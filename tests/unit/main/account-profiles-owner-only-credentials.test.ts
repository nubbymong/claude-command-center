// HOST QUARANTINE: plants junctions and symbolic links. [CI] [VM] only -- never run on the owner's machine.
// An account's sign-in is written only into a folder made readable by the
// user alone and checked: a profile's three sign-in folders (its home, where
// the CLI keeps .claude.json; the CLI's config folder; the identity copy) are
// given the owner-only folder rule and read back -- asynchronously, once per
// folder in a run -- before anything is written there or a session runs in the
// profile. In place first; where that is refused, a new folder is made beside
// it, checked, given what the old one held and swapped into place; otherwise
// nothing is written, the folder stays exactly as it was, and a launch is
// refused. The write and launch paths only read the verdict.
//
// The rule is replaced here (no process starts, no folder's rights change): it
// makes a missing folder in its existing parent, as the real one does, and
// answers as each test says. icacls and Windows PowerShell are replaced too:
// nothing here starts a process. The folders are real, in a temp folder.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const warned: string[] = []
vi.mock('../../../src/main/debug-logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/debug-logger')>()),
  logWarn: (...args: unknown[]) => { warned.push(args.map(String).join(' ')) },
}))

// No process starts: icacls answers success with nothing to read; Windows
// PowerShell, started synchronously, is recorded and fails; started
// asynchronously it answers as `powershellAnswer` says.
const syncPowerShell: string[] = []
const asyncPowerShell: string[][] = []
let powershellAnswer: (dirs: string[]) => string = () => ''
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const execFileSync = vi.fn((file: string, _args?: unknown, opts?: { encoding?: string }) => {
    if (/powershell/i.test(String(file))) { syncPowerShell.push(String(file)); throw new Error('no process in this test') }
    if (/icacls/i.test(String(file))) return opts?.encoding ? '' : Buffer.alloc(0)
    throw new Error(`no process in this test: ${file}`)
  })
  const execFile = vi.fn((file: string, _args: unknown, opts: { env?: Record<string, string> }, cb: (err: Error | null, out: string, errOut: string) => void) => {
    if (!/powershell/i.test(String(file))) { cb(new Error(`no process in this test: ${file}`), '', ''); return }
    const dirs = String(opts?.env?.CCC_OWNER_ONLY_DIRS ?? '').split('\n').filter(Boolean)
    asyncPowerShell.push(dirs)
    setTimeout(() => cb(null, powershellAnswer(dirs), ''), 1)
  })
  return { ...real, execFileSync, execFile, default: { ...real, execFileSync, execFile } }
})

import {
  _setRootsForTest, _setCredentialFolderRuleForTest, getProfileConfigDir, getAccountIdentityDir, getProfilesRoot,
  copyCredentialFile, writeCanonicalIdentity, withProfileHome, profileRealmLaunch, credentialFoldersVerdict,
  checkProfileCredentialFolders, checkEveryProfileCredentialFolders, startOwnerOnlyCredentialFolders,
  startProfileStepsSettled, startProfileStepsPending, profileCredentialFoldersChecked,
  upsertProfile, setPrimaryProfile, syncPrimaryCredentialsWithGlobal, sharedRoot, captureGlobalLogin,
  restoreProfileHomeFromCanonical, listProfiles, cleanupSessionHomes, getSessionHomesRoot, SHARED_DIR_NAMES,
  CREDENTIAL_FOLDER_REFUSAL, CREDENTIAL_FOLDER_PENDING, CREDENTIAL_FOLDER_UNCHECKED, MANAGED_LAUNCH_REFUSAL,
} from '../../../src/main/account-profiles'
import { createClaudePackage } from '../../../src/main/providers/claude'
import { registerProviderPackage, _resetProviderRegistryForTest } from '../../../src/main/providers/core'

const ID = 'profile-mabc123-a1b2c3'
const OLD_CREDENTIAL = '{"claudeAiOauth":{"refreshToken":"old-token-value"}}'
const NEW_CREDENTIAL = '{"claudeAiOauth":{"refreshToken":"new-token-value"}}'
const STAGED = '.owner-only-new'
const ASIDE = '.owner-only-old'

let base = ''
let home = ''
let claudeDir = ''
let identityDir = ''
let src = ''

/** The owner-only rule, replaced: each call recorded; a missing folder made in
 *  its existing parent (as the real script does, before it reads it back);
 *  every folder answered by `ok`, with `detail` as the refusal's reason. */
function useRule(ok: (dir: string) => boolean, rename: ((from: string, to: string) => void) | null = null, detail = 'its owner is not this user') {
  const calls: string[][] = []
  _setCredentialFolderRuleForTest(async (dirs) => {
    calls.push([...dirs])
    return dirs.map((dir) => {
      if (!fs.existsSync(dir) && fs.existsSync(path.dirname(dir))) fs.mkdirSync(dir)
      return ok(dir) ? { dir, ok: true, detail: 'owner-only' } : { dir, ok: false, detail }
    })
  }, rename)
  return calls
}

const idOf = (p: string) => { const st = fs.statSync(p, { bigint: true }); return `${st.dev}:${st.ino}` }
/** A folder as it stands: each file's bytes and modified time, each link as a link, by name. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string, rel: string) => {
    for (const name of fs.readdirSync(d).sort()) {
      const p = path.join(d, name)
      const st = fs.lstatSync(p)
      if (st.isSymbolicLink()) out[`${rel}${name}`] = 'link'
      else if (st.isDirectory()) walk(p, `${rel}${name}/`)
      else out[`${rel}${name}`] = `${fs.readFileSync(p, 'utf8')} @${Math.round(st.mtimeMs)}`
    }
  }
  walk(dir, '')
  return out
}
/** Anything an attempt left beside a folder, in the home or the profiles root. */
const leftovers = () => [
  ...fs.readdirSync(home).filter((n) => /owner-only-(new|old)/.test(n)),
  ...fs.readdirSync(getProfilesRoot()).filter((n) => /owner-only-(new|old)/.test(n)),
]
const refusals = () => warned.filter((w) => /could not be made readable by this user alone/.test(w))
const unanswered = () => warned.filter((w) => /could not be checked this time/.test(w))
/** The rule's call gave no read at all (it could not run or end, or its answer could not be read). */
const noRead = (dirs: readonly string[]) => dirs.map((dir) => ({ dir, ok: false, detail: 'the rights could not be set or read', unread: true as const }))
const madeAndPassed = (dirs: readonly string[]) => dirs.map((dir) => {
  if (!fs.existsSync(dir) && fs.existsSync(path.dirname(dir))) fs.mkdirSync(dir)
  return { dir, ok: true, detail: 'owner-only' }
})
/** The profile's shared folders, linked from its config folder as the home's setup makes them. */
function linkShared(dir = claudeDir) {
  for (const name of SHARED_DIR_NAMES) {
    const target = path.join(sharedRoot(), name)
    fs.mkdirSync(target, { recursive: true })
    fs.symlinkSync(target, path.join(dir, name), process.platform === 'win32' ? 'junction' : 'dir')
  }
}
const linkedToShared = (dir = claudeDir) => SHARED_DIR_NAMES.every((name) => {
  const p = path.join(dir, name)
  try { return fs.lstatSync(p).isSymbolicLink() && fs.realpathSync.native(p) === fs.realpathSync.native(path.join(sharedRoot(), name)) } catch { return false }
})
const past = new Date('2026-01-02T03:04:05Z')

beforeEach(() => {
  warned.length = 0
  syncPowerShell.length = 0
  asyncPowerShell.length = 0
  powershellAnswer = () => ''
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-owner-only-cred-')))
  const resourcesDir = path.join(base, 'res')
  const shared = path.join(base, 'home', '.claude')
  fs.mkdirSync(resourcesDir, { recursive: true })
  fs.mkdirSync(shared, { recursive: true })
  _setRootsForTest({ resourcesDir, sharedRoot: shared })
  _setCredentialFolderRuleForTest(null)
  home = getProfileConfigDir(ID)
  claudeDir = path.join(home, '.claude')
  identityDir = getAccountIdentityDir(ID)
  // The config folder as a signed-in profile has it: its sign-in, a settings
  // copy and some of the CLI's own state; the home's .claude.json beside it.
  fs.mkdirSync(path.join(claudeDir, 'todos'), { recursive: true })
  fs.writeFileSync(path.join(claudeDir, '.credentials.json'), OLD_CREDENTIAL)
  fs.writeFileSync(path.join(claudeDir, 'settings.json'), '{"model":"x"}')
  fs.writeFileSync(path.join(claudeDir, 'todos', 'a.json'), '[]')
  fs.writeFileSync(path.join(home, '.claude.json'), '{"oauthAccount":{"emailAddress":"a@example.com"}}')
  for (const f of [path.join('.claude', '.credentials.json'), path.join('.claude', 'settings.json'), path.join('.claude', 'todos', 'a.json'), '.claude.json']) fs.utimesSync(path.join(home, f), past, past)
  src = path.join(base, 'incoming.json')
  fs.writeFileSync(src, NEW_CREDENTIAL)
})

afterEach(() => {
  _setCredentialFolderRuleForTest(null)
  _setRootsForTest(null)
  _resetProviderRegistryForTest()
  try { fs.rmSync(base, { recursive: true, force: true }) } catch { /* temp */ }
})

describe('a sign-in is written only into a folder read back as owner-only', () => {
  it('refused in place and refused again when made anew: nothing is written, every folder and its sign-in stay exactly as they were, one log line each', async () => {
    const calls = useRule(() => false)
    const before = snapshot(claudeDir)
    const id = idOf(claudeDir)
    await checkProfileCredentialFolders(ID)
    expect(() => copyCredentialFile(src, path.join(claudeDir, '.credentials.json'))).toThrow(CREDENTIAL_FOLDER_REFUSAL)
    expect(snapshot(claudeDir)).toEqual(before)
    expect(idOf(claudeDir)).toBe(id)
    expect(calls).toEqual([[home, claudeDir, identityDir], [`${home}${STAGED}`], [`${claudeDir}${STAGED}`], [`${identityDir}${STAGED}`]])
    expect(leftovers()).toEqual([])
    expect(refusals().length).toBe(3)
    // Each line names the profile and the folder, never a path.
    for (const line of refusals()) {
      expect(line).toContain(ID)
      expect(line).not.toContain(base)
    }
  })

  it('a write before its folder has a verdict writes nothing and says the check is still running; the check it starts lets a retry write', async () => {
    const calls = useRule(() => true)
    expect(() => copyCredentialFile(src, path.join(claudeDir, '.credentials.json'))).toThrow(CREDENTIAL_FOLDER_PENDING)
    expect(fs.readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8')).toBe(OLD_CREDENTIAL)
    // The refused write started the check (the rule is already asked); waiting
    // for the profile's check is that same one.
    expect(calls).toEqual([[home, claudeDir, identityDir]])
    await checkProfileCredentialFolders(ID)
    expect(calls).toEqual([[home, claudeDir, identityDir]])
    copyCredentialFile(src, path.join(claudeDir, '.credentials.json'))
    expect(fs.readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8')).toBe(NEW_CREDENTIAL)
  })

  it('the identity copy is written only once its folder is checked; refused, neither of its files is written', async () => {
    useRule((dir) => dir !== identityDir && !dir.startsWith(identityDir))
    await checkProfileCredentialFolders(ID)
    expect(() => writeCanonicalIdentity(ID, { claudeJson: '{"oauthAccount":{"emailAddress":"a@example.com"}}', credentials: NEW_CREDENTIAL })).toThrow(CREDENTIAL_FOLDER_REFUSAL)
    expect(fs.existsSync(path.join(identityDir, '.credentials.json'))).toBe(false)
    expect(fs.existsSync(path.join(identityDir, '.claude.json'))).toBe(false)
  })

  it('the profile folder holds .claude.json, which can carry a token: it is written there only once that folder is checked', async () => {
    useRule((dir) => dir !== home && !dir.startsWith(`${home}${STAGED}`))
    fs.mkdirSync(identityDir)
    fs.writeFileSync(path.join(identityDir, '.claude.json'), '{"oauthAccount":{"emailAddress":"b@example.com"},"primaryApiKey":"key-value"}')
    await checkProfileCredentialFolders(ID)
    const before = fs.readFileSync(path.join(home, '.claude.json'), 'utf8')
    expect(() => restoreProfileHomeFromCanonical(ID)).toThrow(CREDENTIAL_FOLDER_REFUSAL)
    expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).toBe(before)
    expect(refusals().length).toBe(1)
    expect(refusals()[0]).toMatch(/the profile folder/)
  })

  it('read back owner-only in place: written; not asked again while it is the same folder, asked again once it is another', async () => {
    const calls = useRule(() => true)
    await checkProfileCredentialFolders(ID)
    copyCredentialFile(src, path.join(claudeDir, '.credentials.json'))
    expect(fs.readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8')).toBe(NEW_CREDENTIAL)
    copyCredentialFile(src, path.join(claudeDir, '.credentials.json'))
    await checkProfileCredentialFolders(ID)
    expect(calls).toEqual([[home, claudeDir, identityDir]])
    // Another folder made at its path, with no verdict until it is checked
    // again. The old one is moved aside first and kept, so the two exist at
    // once and cannot share an identity (a file system may give a folder made
    // just after a removal the removed one's number, as ext4 does).
    const before = idOf(claudeDir)
    fs.renameSync(claudeDir, `${claudeDir}.aside`)
    fs.mkdirSync(claudeDir)
    expect(idOf(claudeDir)).not.toBe(before)
    expect(() => copyCredentialFile(src, path.join(claudeDir, '.credentials.json'))).toThrow(CREDENTIAL_FOLDER_PENDING)
    await checkProfileCredentialFolders(ID)
    expect(calls).toEqual([[home, claudeDir, identityDir], [claudeDir]])
    copyCredentialFile(src, path.join(claudeDir, '.credentials.json'))
  })

  it('a refusal holds for the run while it is the same folder: no write or launch asks again', async () => {
    const calls = useRule((dir) => dir !== claudeDir && !dir.startsWith(`${claudeDir}${STAGED}`))
    await checkProfileCredentialFolders(ID)
    expect(calls.length).toBe(2)
    for (let i = 0; i < 3; i++) expect(() => copyCredentialFile(src, path.join(claudeDir, '.credentials.json'))).toThrow(CREDENTIAL_FOLDER_REFUSAL)
    await checkProfileCredentialFolders(ID)
    expect(calls.length).toBe(2)
    expect(refusals().length).toBe(1)
  })

  it('refused in place: a new folder is made, checked, given what the old one held and swapped in, its shared folders linked again; the old copy goes', async () => {
    linkShared()
    const calls = useRule((dir) => dir !== claudeDir)
    const before = snapshot(claudeDir)
    const id = idOf(claudeDir)
    await checkProfileCredentialFolders(ID)
    expect(calls).toEqual([[home, claudeDir, identityDir], [`${claudeDir}${STAGED}`]])
    // Another folder now, holding everything the old one held (times kept)
    // and the profile's shared folders, linked to the shared ones again.
    expect(idOf(claudeDir)).not.toBe(id)
    expect(snapshot(claudeDir)).toEqual(before)
    expect(linkedToShared()).toBe(true)
    // Nothing left beside it, so no other copy of the old sign-in anywhere.
    expect(leftovers()).toEqual([])
    expect(refusals()).toEqual([])
    // Checked: the write lands, and asks nothing.
    copyCredentialFile(src, path.join(claudeDir, '.credentials.json'))
    expect(fs.readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8')).toBe(NEW_CREDENTIAL)
    expect(calls.length).toBe(2)
  })

  it('the profile folder refused in place is made anew the same way: what it holds carried, its folders checked again inside it, its links made again', async () => {
    linkShared()
    const calls = useRule((dir) => dir !== home)
    const before = snapshot(home)
    const id = idOf(home)
    await checkProfileCredentialFolders(ID)
    expect(calls).toEqual([[home, claudeDir, identityDir], [`${home}${STAGED}`], [claudeDir, identityDir]])
    expect(idOf(home)).not.toBe(id)
    expect(snapshot(home)).toEqual(before)
    expect(linkedToShared()).toBe(true)
    expect(leftovers()).toEqual([])
    expect(credentialFoldersVerdict([home, claudeDir, identityDir])).toEqual({ ok: true })
  })

  it('a sign-in rewritten while the folder is copied is the one in place after the swap, and the old copy goes', async () => {
    let n = 0
    let atSwap: string | null = null
    const fresh = '{"claudeAiOauth":{"refreshToken":"rotated-token-value"}}'
    useRule((dir) => dir !== claudeDir, (from, to) => {
      // The CLI rotates the sign-in after the copy, before the old folder moves.
      if (++n === 1) fs.writeFileSync(path.join(from, '.credentials.json'), fresh)
      // What the new folder holds as it goes into place.
      if (n === 2) atSwap = fs.readFileSync(path.join(from, '.credentials.json'), 'utf8')
      fs.renameSync(from, to)
    })
    await checkProfileCredentialFolders(ID)
    expect(atSwap).toBe(fresh)
    expect(fs.readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8')).toBe(fresh)
    expect(leftovers()).toEqual([])
  })

  it('a sign-in inside the profile folder rewritten while that folder is copied is the one in place after the swap, and the old copy goes', async () => {
    let n = 0
    let atSwap: string | null = null
    const fresh = '{"claudeAiOauth":{"refreshToken":"rotated-token-value"}}'
    useRule((dir) => dir !== home, (from, to) => {
      // The CLI rotates the sign-in in the config folder after the copy, before the old profile folder moves.
      if (++n === 1) fs.writeFileSync(path.join(from, '.claude', '.credentials.json'), fresh)
      // What the new profile folder holds as it goes into place.
      if (n === 2) atSwap = fs.readFileSync(path.join(from, '.claude', '.credentials.json'), 'utf8')
      fs.renameSync(from, to)
    })
    await checkProfileCredentialFolders(ID)
    expect(atSwap).toBe(fresh)
    expect(fs.readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8')).toBe(fresh)
    expect(leftovers()).toEqual([])
    expect(credentialFoldersVerdict([home, claudeDir, identityDir])).toEqual({ ok: true })
  })

  it('the old profile folder gives up every sign-in in it, those of its inner folders too, before the rest of it goes', async () => {
    fs.mkdirSync(identityDir)
    fs.writeFileSync(path.join(identityDir, '.credentials.json'), OLD_CREDENTIAL)
    fs.writeFileSync(path.join(identityDir, '.claude.json'), '{"oauthAccount":{"emailAddress":"a@example.com"}}')
    useRule((dir) => dir !== home)
    // The rest of the old copy cannot go: its config folder cannot be listed.
    const oldCopy = `${home}${ASIDE}`
    const realReaddir = fs.readdirSync
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      if (path.resolve(String(p)) === path.join(oldCopy, '.claude')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      return (realReaddir as (...a: unknown[]) => unknown)(p, ...rest)
    }) as typeof fs.readdirSync)
    try {
      await checkProfileCredentialFolders(ID)
    } finally {
      spy.mockRestore()
    }
    // The old copy is still there, holding no sign-in at any depth.
    expect(fs.existsSync(oldCopy)).toBe(true)
    for (const rel of ['.claude.json', '.credentials.json', path.join('.claude', '.credentials.json'), path.join('.claude', '.claude.json'), path.join('identity', '.credentials.json'), path.join('identity', '.claude.json')]) {
      expect(fs.existsSync(path.join(oldCopy, rel)), rel).toBe(false)
    }
    // Each sign-in is in place.
    expect(fs.readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8')).toBe(OLD_CREDENTIAL)
    expect(fs.readFileSync(path.join(identityDir, '.credentials.json'), 'utf8')).toBe(OLD_CREDENTIAL)
    expect(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).toContain('a@example.com')
    expect(warned.some((w) => /could not be removed yet/.test(w))).toBe(true)
  })

  it.each(['.claude', 'identity'])('a profile folder remade while its %s folder is a link never reads, carries or removes a sign-in through that link', async (name) => {
    // The link's target, outside the profile, holds a sign-in.
    const outside = path.join(base, 'outside')
    fs.mkdirSync(outside)
    const OUTSIDE = '{"claudeAiOauth":{"refreshToken":"outside-token-value"}}'
    fs.writeFileSync(path.join(outside, '.credentials.json'), OUTSIDE)
    fs.writeFileSync(path.join(outside, '.claude.json'), '{"oauthAccount":{"emailAddress":"o@example.com"}}')
    const linked = path.join(home, name)
    fs.rmSync(linked, { recursive: true, force: true })
    fs.symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
    useRule((dir) => dir !== home)
    await checkProfileCredentialFolders(ID)
    // The target keeps both files, unchanged ...
    expect(fs.readFileSync(path.join(outside, '.credentials.json'), 'utf8')).toBe(OUTSIDE)
    expect(fs.readFileSync(path.join(outside, '.claude.json'), 'utf8')).toContain('o@example.com')
    // ... nothing of it was carried into the new profile folder ...
    expect(fs.existsSync(path.join(home, name, '.credentials.json'))).toBe(false)
    expect(fs.existsSync(path.join(home, name, '.claude.json'))).toBe(false)
    // ... and the old copy went, its link removed as a link.
    expect(leftovers()).toEqual([])
  })

  it('a sign-in removed while the folder is copied (a sign-out) is not brought back by the swap', async () => {
    let n = 0
    useRule((dir) => dir !== claudeDir, (from, to) => {
      if (++n === 1) fs.rmSync(path.join(from, '.credentials.json'))
      fs.renameSync(from, to)
    })
    await checkProfileCredentialFolders(ID)
    expect(fs.existsSync(path.join(claudeDir, '.credentials.json'))).toBe(false)
    expect(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')).toBe('{"model":"x"}')
    expect(leftovers()).toEqual([])
  })

  it('the old folder cannot be moved aside (in use): the new folder goes, the old one and its sign-in stay exactly as they were', async () => {
    useRule((dir) => dir !== claudeDir, () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }) })
    const before = snapshot(claudeDir)
    const id = idOf(claudeDir)
    await checkProfileCredentialFolders(ID)
    expect(() => copyCredentialFile(src, path.join(claudeDir, '.credentials.json'))).toThrow(CREDENTIAL_FOLDER_REFUSAL)
    expect(idOf(claudeDir)).toBe(id)
    expect(snapshot(claudeDir)).toEqual(before)
    expect(leftovers()).toEqual([])
    expect(refusals().length).toBe(1)
  })

  it('the new folder cannot be put in its place: the old one goes back, unchanged; the new one goes', async () => {
    let n = 0
    useRule((dir) => dir !== claudeDir, (from, to) => {
      if (++n === 2) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      fs.renameSync(from, to)
    })
    const before = snapshot(claudeDir)
    const id = idOf(claudeDir)
    await checkProfileCredentialFolders(ID)
    expect(() => copyCredentialFile(src, path.join(claudeDir, '.credentials.json'))).toThrow(CREDENTIAL_FOLDER_REFUSAL)
    expect(idOf(claudeDir)).toBe(id)
    expect(snapshot(claudeDir)).toEqual(before)
    expect(leftovers()).toEqual([])
  })

  it('the primary account\'s sign-in, refreshed outside the app, is written into its folder only once that folder is checked', async () => {
    // The primary profile and the user's own sign-in are the same account; the
    // user's own copy is the fresher one, so it is the one to write across.
    const email = '{"oauthAccount":{"emailAddress":"a@example.com"}}'
    upsertProfile({ id: ID, name: '', accountEmail: 'a@example.com', createdAt: 1 })
    setPrimaryProfile(ID)
    fs.writeFileSync(path.join(path.dirname(sharedRoot()), '.claude.json'), email)
    const fresher = '{"claudeAiOauth":{"refreshToken":"user-token","expiresAt":9999999999999}}'
    fs.writeFileSync(path.join(sharedRoot(), '.credentials.json'), fresher)
    useRule(() => false)
    await checkProfileCredentialFolders(ID)
    const before = snapshot(claudeDir)
    expect(syncPrimaryCredentialsWithGlobal()).toBe('none')
    expect(snapshot(claudeDir)).toEqual(before)
    useRule(() => true)
    await checkProfileCredentialFolders(ID)
    expect(syncPrimaryCredentialsWithGlobal()).toBe('global->profile')
    expect(fs.readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8')).toBe(fresher)
  })

  it('a sign-in kept from an earlier layout is moved into the profile only once its folders are checked, and is never dropped before that', async () => {
    upsertProfile({ id: ID, name: '', accountEmail: 'a@example.com', createdAt: 1 })
    const retired = path.join(getSessionHomesRoot(), 's1')
    const fresher = '{"claudeAiOauth":{"refreshToken":"kept-token","expiresAt":9999999999999}}'
    fs.mkdirSync(path.join(retired, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(retired, '.claude.json'), '{"oauthAccount":{"emailAddress":"a@example.com"}}')
    fs.writeFileSync(path.join(retired, '.claude', '.credentials.json'), fresher)
    useRule(() => false)
    await checkProfileCredentialFolders(ID)
    const before = snapshot(claudeDir)
    cleanupSessionHomes()
    expect(snapshot(claudeDir)).toEqual(before)
    expect(fs.readFileSync(path.join(retired, '.claude', '.credentials.json'), 'utf8')).toBe(fresher)
    expect(fs.existsSync(path.join(retired, '.claude.json'))).toBe(true)
    // Checked at a later start: moved in, and the old copies go.
    useRule(() => true)
    await checkProfileCredentialFolders(ID)
    cleanupSessionHomes()
    expect(fs.readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8')).toBe(fresher)
    expect(fs.existsSync(path.join(retired, '.claude', '.credentials.json'))).toBe(false)
  })

  it('a profile whose folder is missing is not made by the check', async () => {
    const calls = useRule(() => true)
    const gone = 'profile-gone-000000'
    await checkProfileCredentialFolders(gone)
    expect(calls).toEqual([])
    expect(fs.existsSync(getProfileConfigDir(gone))).toBe(false)
  })

  it('a sign-in folder that is not a folder is refused, never made again, and nothing is written', async () => {
    const calls = useRule(() => true)
    fs.writeFileSync(identityDir, 'not a folder')
    await checkProfileCredentialFolders(ID)
    expect(calls).toEqual([[home, claudeDir]])
    expect(credentialFoldersVerdict([identityDir])).toEqual({ ok: false, message: CREDENTIAL_FOLDER_REFUSAL })
    expect(() => writeCanonicalIdentity(ID, { credentials: NEW_CREDENTIAL })).toThrow()
    expect(fs.readFileSync(identityDir, 'utf8')).toBe('not a folder')
    expect(leftovers()).toEqual([])
  })

  it('a folder put in the place of one the rule was reading back is not taken as checked: it is made anew', async () => {
    let swapped = false
    const calls: string[][] = []
    _setCredentialFolderRuleForTest(async (dirs) => {
      calls.push([...dirs])
      const out = dirs.map((dir) => {
        if (!fs.existsSync(dir) && fs.existsSync(path.dirname(dir))) fs.mkdirSync(dir)
        return { dir, ok: true, detail: 'owner-only' }
      })
      if (!swapped && dirs.includes(claudeDir)) {
        swapped = true
        // Another folder takes the config folder's place once it is read back.
        fs.renameSync(claudeDir, path.join(base, 'moved-away'))
        fs.mkdirSync(claudeDir)
        fs.writeFileSync(path.join(claudeDir, 'put-there.json'), '{}')
      }
      return out
    })
    await checkProfileCredentialFolders(ID)
    // The rule is asked again, for a new folder made beside it.
    expect(calls).toEqual([[home, claudeDir, identityDir], [`${claudeDir}${STAGED}`]])
    expect(fs.existsSync(path.join(claudeDir, 'put-there.json'))).toBe(true)
    expect(leftovers()).toEqual([])
  })

  it('a refusal is logged in fixed words: a reason that names a path or a user is not repeated', async () => {
    useRule((dir) => dir !== claudeDir && !dir.startsWith(`${claudeDir}${STAGED}`), null, "Access to the path 'C:\\Users\\someone\\x' is denied.")
    await checkProfileCredentialFolders(ID)
    expect(refusals().length).toBe(1)
    expect(refusals()[0]).not.toMatch(/someone|[A-Za-z]:\\|Access to the path/)
    expect(refusals()[0]).toContain(ID)
  })

  it('a check whose call gives no read makes nothing anew and keeps no verdict: the folders are asked again and pass in place', async () => {
    const calls: string[][] = []
    let n = 0
    _setCredentialFolderRuleForTest(async (dirs) => {
      calls.push([...dirs])
      return ++n === 1 ? noRead(dirs) : madeAndPassed(dirs)
    })
    const homeId = idOf(home)
    const claudeId = idOf(claudeDir)
    await checkProfileCredentialFolders(ID)
    expect(calls).toEqual([[home, claudeDir, identityDir], [home, claudeDir, identityDir]])
    expect(idOf(home)).toBe(homeId)
    expect(idOf(claudeDir)).toBe(claudeId)
    expect(leftovers()).toEqual([])
    expect(refusals()).toEqual([])
    expect(credentialFoldersVerdict([home, claudeDir, identityDir])).toEqual({ ok: true })
  })

  it('no read of the new folder made for one refused in place is no refusal either: the folder is asked again and made anew then', async () => {
    const calls: string[][] = []
    let stagedAsks = 0
    _setCredentialFolderRuleForTest(async (dirs) => {
      calls.push([...dirs])
      if (dirs[0] === `${home}${STAGED}` && ++stagedAsks === 1) return noRead(dirs)
      return madeAndPassed(dirs).map((r) => (r.dir === home ? { dir: home, ok: false, detail: 'its owner is not this user' } : r))
    })
    const id = idOf(home)
    await checkProfileCredentialFolders(ID)
    expect(refusals()).toEqual([])
    expect(calls.filter((c) => c[0] === `${home}${STAGED}`).length).toBe(2)
    expect(idOf(home)).not.toBe(id)
    expect(leftovers()).toEqual([])
    expect(credentialFoldersVerdict([home, claudeDir, identityDir])).toEqual({ ok: true })
  })

  it('no read of a folder inside the profile folder counts for that profile however the profile folder was named: it is asked again at once, and a launch is told the folders could not be checked', async () => {
    const calls: string[][] = []
    _setCredentialFolderRuleForTest(async (dirs) => {
      calls.push([...dirs])
      return madeAndPassed(dirs).map((r) => (r.dir === claudeDir ? noRead([claudeDir])[0] : r))
    })
    // A launch names the profile folder with a trailing separator; its check starts.
    expect(credentialFoldersVerdict([`${home}${path.sep}`])).toEqual({ ok: false, message: CREDENTIAL_FOLDER_PENDING })
    await checkProfileCredentialFolders(ID)
    expect(calls).toEqual([[`${home}${path.sep}`, claudeDir, identityDir], [claudeDir]])
    expect(credentialFoldersVerdict([home, claudeDir, identityDir])).toEqual({ ok: false, message: CREDENTIAL_FOLDER_UNCHECKED })
    expect(unanswered().length).toBe(2)
    for (const line of unanswered()) expect(line).toContain(ID)
    // Let the check that verdict started end inside this test's folder.
    await checkProfileCredentialFolders(ID)
  })

  it('a rule that gives no read is never taken for a refusal: nothing is made anew or written, the launch is told the folders could not be checked, and once it reads they pass', async () => {
    const calls: string[][] = []
    let reading = false
    _setCredentialFolderRuleForTest(async (dirs) => {
      calls.push([...dirs])
      return reading ? madeAndPassed(dirs) : noRead(dirs)
    })
    const before = snapshot(home)
    await checkProfileCredentialFolders(ID)
    expect(calls.flat().some((d) => d.includes(STAGED))).toBe(false)
    expect(snapshot(home)).toEqual(before)
    expect(credentialFoldersVerdict([home, claudeDir, identityDir])).toEqual({ ok: false, message: CREDENTIAL_FOLDER_UNCHECKED })
    expect(() => copyCredentialFile(src, path.join(claudeDir, '.credentials.json'))).toThrow(CREDENTIAL_FOLDER_UNCHECKED)
    expect(fs.readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8')).toBe(OLD_CREDENTIAL)
    expect(refusals()).toEqual([])
    // Logged in fixed words, naming the profile and never a path.
    expect(unanswered().length).toBeGreaterThan(0)
    for (const line of unanswered()) {
      expect(line).toContain(ID)
      expect(line).not.toContain(base)
    }
    reading = true
    await checkProfileCredentialFolders(ID)
    copyCredentialFile(src, path.join(claudeDir, '.credentials.json'))
    expect(fs.readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8')).toBe(NEW_CREDENTIAL)
    expect(calls.flat().some((d) => d.includes(STAGED))).toBe(false)
  })
})

describe('a new profile takes a home already made and checked, so its first sign-in is written at once', () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(path.dirname(sharedRoot()), '.claude.json'), '{"oauthAccount":{"emailAddress":"c@example.com"}}')
    fs.writeFileSync(path.join(sharedRoot(), '.credentials.json'), NEW_CREDENTIAL)
  })

  it('checked homes kept ready: a capture writes the new profile\'s sign-in and identity at once, and another home is made ready', async () => {
    const calls = useRule(() => true)
    await checkEveryProfileCredentialFolders()
    const captured = captureGlobalLogin()
    expect(captured).not.toBeNull()
    const newHome = getProfileConfigDir(captured!.id)
    expect(fs.readFileSync(path.join(newHome, '.claude', '.credentials.json'), 'utf8')).toBe(NEW_CREDENTIAL)
    expect(fs.readFileSync(path.join(newHome, '.claude.json'), 'utf8')).toContain('c@example.com')
    expect(fs.readFileSync(path.join(newHome, 'identity', '.credentials.json'), 'utf8')).toBe(NEW_CREDENTIAL)
    expect(credentialFoldersVerdict([newHome, path.join(newHome, '.claude'), path.join(newHome, 'identity')])).toEqual({ ok: true })
    // The home the capture took was asked before the capture began.
    expect(calls.flat().some((d) => d.startsWith(newHome))).toBe(false)
    await checkEveryProfileCredentialFolders()
    expect(listProfiles().map((p) => p.id)).toEqual([captured!.id])
  })

  it('a home kept ready whose first check gives no read is asked once more at once, so the start still makes the first account from the user\'s own sign-in', async () => {
    const ready = path.join(getProfilesRoot(), '.owner-only-ready')
    const readySet = [ready, path.join(ready, '.claude'), path.join(ready, 'identity')]
    const calls: string[][] = []
    let n = 0
    const rule = async (dirs: readonly string[]) => { calls.push([...dirs]); return ++n === 1 ? noRead(dirs) : madeAndPassed(dirs) }
    _setCredentialFolderRuleForTest(rule)
    let captured: ReturnType<typeof captureGlobalLogin> = null
    await startOwnerOnlyCredentialFolders(() => { captured = captureGlobalLogin() }, rule)
    expect(calls.slice(0, 2)).toEqual([readySet, readySet])
    expect(captured).not.toBeNull()
    const newHome = getProfileConfigDir(captured!.id)
    expect(listProfiles().map((p) => [p.id, p.accountEmail])).toEqual([[captured!.id, 'c@example.com']])
    expect(fs.readFileSync(path.join(newHome, '.claude', '.credentials.json'), 'utf8')).toBe(NEW_CREDENTIAL)
    // The home it took was the one checked before the capture began.
    expect(calls.flat().some((d) => d.startsWith(newHome))).toBe(false)
    expect(refusals()).toEqual([])
    await checkEveryProfileCredentialFolders()
  })

  it('no checked home ready (the rule refuses it): the capture writes nothing and leaves no profile', async () => {
    useRule(() => false)
    await checkEveryProfileCredentialFolders()
    expect(captureGlobalLogin()).toBeNull()
    expect(listProfiles()).toEqual([])
    expect(fs.readdirSync(getProfilesRoot()).filter((n) => n.startsWith('profile-') && n !== ID)).toEqual([])
    // Let the check the capture started end inside this test's folder: it leaves nothing behind.
    await new Promise((r) => setTimeout(r, 30))
    expect(fs.readdirSync(getProfilesRoot()).filter((n) => n.startsWith('profile-') && n !== ID)).toEqual([])
    expect(listProfiles()).toEqual([])
  })

  it('an account removed while its folders are checked leaves no folder behind: what the check made in its place goes', async () => {
    // The rule answers later (as a Windows PowerShell start does) and makes a missing folder then.
    const calls: string[][] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    _setCredentialFolderRuleForTest(async (dirs) => {
      calls.push([...dirs])
      await gate
      return madeAndPassed(dirs)
    })
    const others = () => fs.readdirSync(getProfilesRoot()).filter((n) => n.startsWith('profile-') && n !== ID)
    // No checked home ready: the capture's writes wait for the new account's check, so it is removed.
    expect(captureGlobalLogin()).toBeNull()
    expect(listProfiles()).toEqual([])
    expect(others()).toEqual([])
    const asked = calls.find((c) => path.basename(c[0]).startsWith('profile-') && c[0] !== home)
    expect(asked).toBeDefined()
    const removedId = path.basename(asked![0])
    release()
    await checkProfileCredentialFolders(removedId)
    expect(others()).toEqual([])
    expect(listProfiles()).toEqual([])
    expect(calls.flat().some((d) => d.includes(STAGED))).toBe(false)
  })

  it('a profile folder put in place while it is read back, its account still listed, is kept and made anew, never removed', async () => {
    upsertProfile({ id: ID, name: '', accountEmail: 'a@example.com', createdAt: 1 })
    let swapped = false
    _setCredentialFolderRuleForTest(async (dirs) => {
      const out = madeAndPassed(dirs)
      if (!swapped && dirs.includes(home)) {
        swapped = true
        // Another folder takes the profile folder's place once it is read back.
        fs.renameSync(home, path.join(base, 'moved-away'))
        fs.mkdirSync(home)
        fs.writeFileSync(path.join(home, 'put-there.json'), '{}')
      }
      return out
    })
    await checkProfileCredentialFolders(ID)
    expect(fs.existsSync(path.join(home, 'put-there.json'))).toBe(true)
    expect(listProfiles().map((p) => p.id)).toEqual([ID])
    expect(credentialFoldersVerdict([home])).toEqual({ ok: true })
    expect(leftovers()).toEqual([])
  })

  it('a profile folder put in place while it is read back is kept when the account list cannot be read then: a list that cannot be read never counts as a removal', async () => {
    upsertProfile({ id: ID, name: '', accountEmail: 'a@example.com', createdAt: 1 })
    const meta = path.join(getProfilesRoot(), 'profiles.json')
    const good = fs.readFileSync(meta, 'utf8')
    let swapped = false
    _setCredentialFolderRuleForTest(async (dirs) => {
      const out = madeAndPassed(dirs)
      if (!swapped && dirs.includes(home)) {
        swapped = true
        // Another folder takes the profile folder's place, and the list is unreadable, as the rule answers.
        fs.renameSync(home, path.join(base, 'moved-away'))
        fs.mkdirSync(home)
        fs.writeFileSync(path.join(home, 'put-there.json'), '{}')
        fs.writeFileSync(meta, '{ not a list')
      }
      return out
    })
    try {
      await checkProfileCredentialFolders(ID)
    } finally {
      fs.writeFileSync(meta, good)
    }
    expect(fs.existsSync(path.join(home, 'put-there.json'))).toBe(true)
    expect(listProfiles().map((p) => p.id)).toEqual([ID])
    expect(leftovers()).toEqual([])
  })

  it('a ready home that was never checked is not taken: the capture writes nothing and leaves no profile', async () => {
    useRule(() => true)
    const ready = path.join(getProfilesRoot(), '.owner-only-ready')
    for (const name of ['.claude', 'identity']) fs.mkdirSync(path.join(ready, name), { recursive: true })
    expect(captureGlobalLogin()).toBeNull()
    expect(listProfiles()).toEqual([])
    await new Promise((r) => setTimeout(r, 30))
  })
})

describe('a remake a quit interrupted is settled by the next check, never losing the sign-in', () => {
  const staged = () => `${claudeDir}${STAGED}`
  const aside = () => `${claudeDir}${ASIDE}`

  it('after the swap: the old copy beside it goes; its sign-in, newer than the one in place, is carried in first', async () => {
    useRule(() => true)
    fs.mkdirSync(aside())
    fs.writeFileSync(path.join(aside(), '.credentials.json'), NEW_CREDENTIAL)
    fs.writeFileSync(path.join(aside(), 'settings.json'), '{}')
    await checkProfileCredentialFolders(ID)
    expect(leftovers()).toEqual([])
    expect(fs.readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8')).toBe(NEW_CREDENTIAL)
  })

  it('after the swap: an old copy older than the one in place goes without replacing it', async () => {
    useRule(() => true)
    fs.mkdirSync(aside())
    fs.writeFileSync(path.join(aside(), '.credentials.json'), NEW_CREDENTIAL)
    const older = new Date('2025-01-01T00:00:00Z')
    fs.utimesSync(path.join(aside(), '.credentials.json'), older, older)
    await checkProfileCredentialFolders(ID)
    expect(leftovers()).toEqual([])
    expect(fs.readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8')).toBe(OLD_CREDENTIAL)
  })

  it('between the two renames: the new folder, its copy complete, goes into place', async () => {
    useRule(() => true)
    fs.renameSync(claudeDir, aside())
    fs.mkdirSync(staged())
    fs.writeFileSync(path.join(staged(), '.credentials.json'), OLD_CREDENTIAL)
    fs.writeFileSync(path.join(staged(), 'settings.json'), '{"model":"x"}')
    fs.utimesSync(path.join(staged(), '.credentials.json'), past, past)
    // Only the new folder holds this: the one in place must be it.
    fs.writeFileSync(path.join(staged(), 'made-anew'), '1')
    const stagedId = idOf(staged())
    await checkProfileCredentialFolders(ID)
    expect(idOf(claudeDir)).toBe(stagedId)
    expect(fs.readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8')).toBe(OLD_CREDENTIAL)
    expect(fs.readFileSync(path.join(claudeDir, 'settings.json'), 'utf8')).toBe('{"model":"x"}')
    expect(fs.existsSync(path.join(claudeDir, 'made-anew'))).toBe(true)
    expect(leftovers()).toEqual([])
  })

  it('the old folder moved aside and no new one: the old one goes back', async () => {
    useRule(() => true)
    const before = snapshot(claudeDir)
    fs.renameSync(claudeDir, aside())
    await checkProfileCredentialFolders(ID)
    expect(snapshot(claudeDir)).toEqual(before)
    expect(leftovers()).toEqual([])
  })

  it('a new folder never swapped in goes; the folder in place is untouched', async () => {
    useRule(() => true)
    const before = snapshot(claudeDir)
    fs.mkdirSync(staged())
    fs.writeFileSync(path.join(staged(), '.credentials.json'), OLD_CREDENTIAL)
    await checkProfileCredentialFolders(ID)
    expect(snapshot(claudeDir)).toEqual(before)
    expect(leftovers()).toEqual([])
  })
})

describe('a session runs in a profile only once its sign-in folders are checked', () => {
  beforeEach(() => {
    _resetProviderRegistryForTest()
    registerProviderPackage(createClaudePackage())
  })

  it('refused: a launch is refused as an isolation fault; not checked yet: refused as still checking, and the check starts; checked: it composes', async () => {
    useRule(() => false)
    await checkProfileCredentialFolders(ID)
    expect(() => withProfileHome({ PATH: 'x' }, home)).toThrow(`${MANAGED_LAUNCH_REFUSAL}: ${CREDENTIAL_FOLDER_REFUSAL}`)
    const calls = useRule(() => true)
    expect(() => withProfileHome({ PATH: 'x' }, home)).toThrow(`${MANAGED_LAUNCH_REFUSAL}: ${CREDENTIAL_FOLDER_PENDING}`)
    await checkProfileCredentialFolders(ID)
    expect(withProfileHome({ PATH: 'x' }, home).USERPROFILE).toBe(home)
    expect(calls).toEqual([[home, claudeDir, identityDir]])
  })

  it('a home that is not a profile home is never checked, a valid profile name outside the profiles folder included', async () => {
    const calls = useRule(() => false)
    for (const other of [path.join(base, 'elsewhere'), path.join(base, 'elsewhere', ID)]) {
      fs.mkdirSync(path.join(other, '.claude'), { recursive: true })
      expect(withProfileHome({ PATH: 'x' }, other).USERPROFILE).toBe(other)
    }
    await new Promise((r) => setTimeout(r, 5))
    expect(calls).toEqual([])
  })

  const notMac = process.platform === 'darwin' ? it.skip : it
  notMac('a review launch in the profile is refused with the same words', async () => {
    useRule(() => false)
    await checkProfileCredentialFolders(ID)
    expect(profileRealmLaunch(ID, { PATH: 'x' })).toEqual({ refused: CREDENTIAL_FOLDER_REFUSAL })
  })
})

describe('at start: the rule is turned on and every profile checked before the start\'s profile steps write', () => {
  const onWindows = process.platform === 'win32'

  it('Windows: the profiles are checked first, then the steps run and their writes land (POSIX: the rule is never asked)', async () => {
    upsertProfile({ id: ID, name: '', accountEmail: '', createdAt: 1 })
    const order: string[] = []
    const rule = async (dirs: readonly string[]) => {
      order.push(`rule ${dirs.length}`)
      return dirs.map((dir) => { if (!fs.existsSync(dir) && fs.existsSync(path.dirname(dir))) fs.mkdirSync(dir); return { dir, ok: true, detail: 'owner-only' } })
    }
    await startOwnerOnlyCredentialFolders(() => {
      order.push('steps')
      copyCredentialFile(src, path.join(claudeDir, '.credentials.json'))
    }, rule)
    expect(fs.readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8')).toBe(NEW_CREDENTIAL)
    if (onWindows) {
      expect(order[0]).toBe('rule 3')
      expect(order.indexOf('steps')).toBeGreaterThan(0)
      expect(order.slice(0, order.indexOf('steps')).every((s) => s.startsWith('rule'))).toBe(true)
    } else {
      expect(order).toEqual(['steps'])
    }
  })

  it('a launch waiting for its profile\'s check also waits for the start\'s profile steps, which run once the check ends', async () => {
    upsertProfile({ id: ID, name: '', accountEmail: '', createdAt: 1 })
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const rule = async (dirs: readonly string[]) => { await gate; return madeAndPassed(dirs) }
    const start = startOwnerOnlyCredentialFolders(() => { order.push('steps') }, rule)
    const launch = checkProfileCredentialFolders(ID).then(() => { order.push('launch') })
    const listed = startProfileStepsSettled().then(() => { order.push('list') })
    release()
    await Promise.all([start, launch, listed])
    expect(order[0]).toBe('steps')
    expect(order.slice(1).sort()).toEqual(['launch', 'list'])
    // Steps that fail still settle the wait, for a waiter that came while they ran too: it never rejects.
    const failing = startOwnerOnlyCredentialFolders(() => { throw new Error('a step failed') }, rule)
    const waiter = startProfileStepsSettled()
    const waitingLaunch = checkProfileCredentialFolders(ID)
    await expect(failing).rejects.toThrow('a step failed')
    await expect(waiter).resolves.toBeUndefined()
    await expect(waitingLaunch).resolves.toBeUndefined()
    await expect(startProfileStepsSettled()).resolves.toBeUndefined()
  })

  it('a launch can tell at once whether the start\'s profile steps are still to run: from the start until they have run or failed', async () => {
    expect(startProfileStepsPending()).toBe(false)
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const rule = async (dirs: readonly string[]) => madeAndPassed(dirs)
    const start = startOwnerOnlyCredentialFolders(async () => { await gate }, rule)
    expect(startProfileStepsPending()).toBe(true)
    release()
    await start
    expect(startProfileStepsPending()).toBe(false)
    const failing = startOwnerOnlyCredentialFolders(() => { throw new Error('a step failed') }, rule)
    expect(startProfileStepsPending()).toBe(true)
    await expect(failing).rejects.toThrow('a step failed')
    expect(startProfileStepsPending()).toBe(false)
  })

  it('a launch can tell at once whether its account\'s sign-in folders have a verdict, without starting a check', async () => {
    // The rule off: always.
    expect(profileCredentialFoldersChecked(ID)).toBe(true)
    const calls = useRule((dir) => dir !== claudeDir && !dir.startsWith(`${claudeDir}${STAGED}`))
    expect(profileCredentialFoldersChecked(ID)).toBe(false)
    // Read only: nothing was asked.
    expect(calls).toEqual([])
    await checkProfileCredentialFolders(ID)
    // A pass and a refusal are both verdicts.
    expect(profileCredentialFoldersChecked(ID)).toBe(true)
    // Something that is not a folder in a sign-in folder's place is refused as it stands: a verdict too.
    fs.rmSync(identityDir, { recursive: true, force: true })
    fs.writeFileSync(identityDir, 'x')
    expect(profileCredentialFoldersChecked(ID)).toBe(true)
    fs.rmSync(identityDir, { force: true })
    // While the start's profile steps are pending: not yet.
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const start = startOwnerOnlyCredentialFolders(async () => { await gate }, async (dirs) => madeAndPassed(dirs))
    expect(profileCredentialFoldersChecked(ID)).toBe(false)
    release()
    await start
    expect(profileCredentialFoldersChecked(ID)).toBe(true)
  })

  it('the app\'s own rule runs Windows PowerShell asynchronously only: no write or launch starts one synchronously', async () => {
    upsertProfile({ id: ID, name: '', accountEmail: '', createdAt: 1 })
    powershellAnswer = (dirs) => {
      const user = 'S-1-5-21-1-2-3-1001'
      for (const d of dirs) if (!fs.existsSync(d) && fs.existsSync(path.dirname(d))) fs.mkdirSync(d)
      const full = (sid: string) => ({ sid, rights: 0x1f01ff, allow: true, inherited: false, flags: 3 })
      return JSON.stringify({ user, folders: dirs.map((dir) => ({ dir, error: null, owner: user, protected: true, rules: [full(user), full('S-1-5-18')] })) })
    }
    await startOwnerOnlyCredentialFolders(() => {
      copyCredentialFile(src, path.join(claudeDir, '.credentials.json'))
    })
    _resetProviderRegistryForTest()
    registerProviderPackage(createClaudePackage())
    expect(withProfileHome({ PATH: 'x' }, home).USERPROFILE).toBe(home)
    expect(fs.readFileSync(path.join(claudeDir, '.credentials.json'), 'utf8')).toBe(NEW_CREDENTIAL)
    expect(syncPowerShell).toEqual([])
    if (onWindows) expect(asyncPowerShell[0]).toEqual([home, claudeDir, identityDir])
    else expect(asyncPowerShell).toEqual([])
  })
})
