// What is already directly inside a folder the owner-only rule makes
// owner-only in place gets the folder's rights, and the folder passes only
// when the read of those entries holds them -- for the account sign-in
// folders only, which ask for it (secureSignInFoldersWindows, or the `inside`
// option); every other caller gets the folders' own rights alone, and its
// call says so. Read: every entry directly inside, never deeper. Each one
// this user, the Administrators group or SYSTEM owns must give rights to
// nobody but the user, SYSTEM and the Administrators group. The sign-in
// files the app writes (.credentials.json, .claude.json, in any letter case)
// are held to the whole rule: one that is a link, or that another account
// owns, refuses the folder. Any other link (any reparse point, a cloud file's
// placeholder among them) is judged by its own owner only: one this user,
// the Administrators group or SYSTEM owns is passed over whatever its own
// rights, and one another account owns refuses the folder. Any other entry
// another account still owns refuses it too; one the read made this user's
// is judged as any other and counted (takenOver). A folder
// whose own rights read back owner-only is still refused when an entry
// inside keeps another account's entry -- an entry the Administrators group
// owns with another group's inherited read among them -- when what is inside
// could not be read or put right, and when the answer does not say what is
// inside at all. A clean folder passes.
//
// The script writes the folder's owner and its rights separately (owner
// first), so that the rights alone are what Windows passes on to what is
// inside; it lists only the entries directly inside the folder, never goes
// through a link (a link's own owner is all it reads of one), makes another
// account's entry this user's (the owner alone written; never a sign-in file
// or a file with more than one name) before it puts it right, writes only an
// entry this user, the Administrators group or SYSTEM owns, never resets a
// file with more than one name, and leaves
// out the shared entries (the home mirror's links to the user's own files)
// while each is such a file. The rule with Windows' own programs (where
// Constrained Language Mode refuses the script) never uses /restore, which
// needs a privilege only an elevated process has, and removes every other
// account's own entry by SID. A script call that ran past its time limit is
// no read, and that route is not tried after it.
//
// Host-safe: no process starts and no file or folder is touched. The script's
// answers are fakes in the shape it prints; the real round trip is
// owner-only-folders-real.test.ts (CI and the VM).
import { describe, it, expect, vi } from 'vitest'

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const no = (file: unknown) => { throw new Error(`no process in this test: ${String(file)}`) }
  return { ...real, execFile: vi.fn(no), execFileSync: vi.fn(no), spawn: vi.fn(no), spawnSync: vi.fn(no), execSync: vi.fn(no) }
})

import * as rule from '../../../src/main/owner-only-folders'
import type { NativeOwnerOnlyTools, OwnerOnlyOptions } from '../../../src/main/owner-only-folders'

const { secureFoldersWindows, OWNER_ONLY_SCRIPT, OWNER_ONLY_SYSTEM_SID, OWNER_ONLY_ADMINISTRATORS_SID, OWNER_ONLY_INSIDE_ENV, OWNER_ONLY_SHARED_ENV } = rule

const USER = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
const OTHER = 'S-1-5-21-1111111111-2222222222-3333333333-1005'
/** A local group of this machine (synthetic). */
const OTHER_GROUP = 'S-1-5-21-1111111111-2222222222-3333333333-1007'
const FULL = 2032127
const READ_EXECUTE = 1179817
const rule1 = (sid: string, extra: Partial<{ rights: number; allow: boolean; inherited: boolean; flags: number }> = {}) =>
  ({ sid, rights: FULL, allow: true, inherited: false, flags: 3, ...extra })
/** A folder's own read, owner-only, with what is inside it. */
const folder = (dir: string, inside: unknown, insideError: unknown = null) =>
  ({ dir, error: null, owner: USER, protected: true, rules: [rule1(USER), rule1(OWNER_ONLY_SYSTEM_SID)], inside, insideError })
/** An entry inside, as the script prints it. */
const entry = (name: string, owner: string, rules: unknown[], folderToo = false) => ({ name, link: false, folder: folderToo, owner, rules })
/** The entries a file inside an owner-only folder reads once it takes the folder's rights. */
const takenRights = () => [rule1(OWNER_ONLY_SYSTEM_SID, { inherited: true, flags: 0 }), rule1(USER, { inherited: true, flags: 0 })]
/** What a file inside an owner-only folder reads once it takes the folder's rights. */
const inherits = (name: string, owner = USER) => entry(name, owner, takenRights())
/** A link (any reparse point), as the script prints one: a sign-in file's unread, any other's with its own owner. */
const link = (name: string, folderToo = true, linkType: unknown = 'Junction', owner?: unknown) => (owner === undefined ? { name, link: true, folder: folderToo, linkType } : { name, link: true, folder: folderToo, linkType, owner })
/** A file the Administrators group owns with another group's inherited read. */
const keptGroupRead = (name: string) => entry(name, OWNER_ONLY_ADMINISTRATORS_SID, [
  rule1(OTHER_GROUP, { rights: READ_EXECUTE, inherited: true, flags: 0 }),
  rule1(USER, { inherited: true, flags: 0 }), rule1(OWNER_ONLY_ADMINISTRATORS_SID, { inherited: true, flags: 0 }), rule1(OWNER_ONLY_SYSTEM_SID, { inherited: true, flags: 0 }),
])
const answer = (folders: unknown[]) => async () => JSON.stringify({ user: USER, folders })
const HOME = 'C:\\profiles\\profile-a'
const DIRS = [HOME, `${HOME}\\.claude`, `${HOME}\\identity`]
/** The account sign-in folders' call: what is inside read too. */
const INSIDE: OwnerOnlyOptions = { inside: true }

describe('a folder made owner-only in place passes only when what is directly inside it reads back owner-only too', () => {
  it('a clean folder passes: every entry this user\'s, the Administrators group\'s or SYSTEM\'s, rights for the user, SYSTEM and the Administrators group only', async () => {
    const out = await secureFoldersWindows(DIRS, answer([
      folder(DIRS[0], [inherits('.claude.json'), inherits('.gitconfig', OWNER_ONLY_ADMINISTRATORS_SID)]),
      folder(DIRS[1], [inherits('.credentials.json'), entry('todos', OWNER_ONLY_ADMINISTRATORS_SID, [rule1(OWNER_ONLY_SYSTEM_SID, { inherited: true }), rule1(USER, { inherited: true }), rule1(OWNER_ONLY_ADMINISTRATORS_SID)], true), inherits('cache.json', OWNER_ONLY_SYSTEM_SID)]),
      folder(DIRS[2], []),
    ]), undefined, INSIDE)
    expect(out.map((r) => [r.dir, r.ok, r.detail, r.takenOver])).toEqual(DIRS.map((d) => [d, true, 'owner-only', undefined]))
  })

  it('an entry the Administrators group owns with another group\'s inherited read refuses its folder: never passed', async () => {
    const out = await secureFoldersWindows(DIRS, answer([
      folder(DIRS[0], [keptGroupRead('.claude.json')]),
      folder(DIRS[1], [keptGroupRead('.credentials.json')]),
      folder(DIRS[2], [keptGroupRead('.credentials.json'), keptGroupRead('.claude.json')]),
    ]), undefined, INSIDE)
    expect(out.map((r) => [r.ok, r.detail])).toEqual(DIRS.map(() => [false, 'an entry inside it is not owner-only']))
  })

  it('any one entry this user, the Administrators group or SYSTEM owns that is not owner-only refuses the folder, a sign-in file or not; the folders beside it keep their own verdict', async () => {
    const cases: Array<[string, unknown, string]> = [
      ['another account\'s own entry', entry('a.json', USER, [rule1(USER, { inherited: true }), rule1(OTHER, { rights: READ_EXECUTE })]), 'an entry inside it is not owner-only'],
      ['everyone, inherited', entry('a.json', USER, [rule1(USER, { inherited: true }), rule1('S-1-1-0', { inherited: true })]), 'an entry inside it is not owner-only'],
      ['a deny entry', entry('a.json', USER, [rule1(USER, { inherited: true }), rule1(OTHER, { allow: false })]), 'an entry inside it is not owner-only'],
      ['a folder, the Administrators group\'s with another group\'s inherited read', { ...keptGroupRead('todos'), folder: true }, 'an entry inside it is not owner-only'],
      ['SYSTEM the owner, another group\'s read kept', entry('a.json', OWNER_ONLY_SYSTEM_SID, [rule1(USER, { inherited: true }), rule1(OTHER_GROUP, { rights: READ_EXECUTE })]), 'an entry inside it is not owner-only'],
      ['a sign-in file with another account\'s own entry', entry('.credentials.json', USER, [rule1(USER, { inherited: true }), rule1(OTHER, { rights: READ_EXECUTE })]), 'an entry inside it is not owner-only'],
      ['an entry that could not be read', { name: 'a.json', error: 'denied' }, 'what is inside it was not read'],
      ['an entry with no owner', entry('a.json', '', []), 'what is inside it was not read'],
      ['an entry whose owner is not a word', entry('a.json', 42 as unknown as string, []), 'what is inside it was not read'],
      ['an entry whose rights could not be read', entry('a.json', USER, [{ sid: USER }]), 'what is inside it was not read'],
      ['an entry that does not say whether it is a link', { name: 'a.json', owner: USER, rules: [] }, 'what is inside it was not read'],
      ['a link that does not say so plainly', { name: 'a.json', link: 'yes', folder: true, linkType: 'Junction' }, 'what is inside it was not read'],
    ]
    for (const [name, bad, detail] of cases) {
      const out = await secureFoldersWindows(DIRS, answer([folder(DIRS[0], [inherits('.claude.json')]), folder(DIRS[1], [inherits('.credentials.json'), bad]), folder(DIRS[2], [])]), undefined, INSIDE)
      expect(out.map((r) => [r.ok, r.detail]), name).toEqual([[true, 'owner-only'], [false, detail], [true, 'owner-only']])
    }
  })

  it('a sign-in file, in any letter case, that is a link (any kind) or that another account owns refuses its folder', async () => {
    const cases: Array<[string, unknown, string]> = [
      ['a link to a file', link('.credentials.json', false, 'SymbolicLink'), 'a sign-in file inside it is a link'],
      ['a link to a file, upper case', link('.CREDENTIALS.JSON', false, 'SymbolicLink'), 'a sign-in file inside it is a link'],
      ['a junction by that name', link('.claude.json', true, 'Junction'), 'a sign-in file inside it is a link'],
      ['another kind of reparse point (a cloud placeholder)', link('.Claude.Json', false, ''), 'a sign-in file inside it is a link'],
      ['a link whose name the read could not give', { link: true, folder: false, linkType: 'SymbolicLink' }, 'a sign-in file inside it is a link'],
      ['a link named as a path (never what the read gives)', link('sub\\.credentials.json', false, 'SymbolicLink'), 'a sign-in file inside it is a link'],
      ['another account the owner', entry('.credentials.json', OTHER, [rule1(USER, { inherited: true })]), "a sign-in file inside it is another account's"],
      ['LOCAL SERVICE the owner, mixed case', entry('.Claude.json', 'S-1-5-19', [rule1(USER, { inherited: true })]), "a sign-in file inside it is another account's"],
      ['another account the owner, a name the read could not give', { link: false, folder: false, owner: OTHER, rules: [] }, "a sign-in file inside it is another account's"],
    ]
    for (const [name, bad, detail] of cases) {
      const out = await secureFoldersWindows(DIRS, answer([folder(DIRS[0], [inherits('.claude.json')]), folder(DIRS[1], [inherits('.credentials.json'), bad]), folder(DIRS[2], [])]), undefined, INSIDE)
      expect(out.map((r) => [r.ok, r.detail, r.takenOver]), name).toEqual([[true, 'owner-only', undefined], [false, detail, undefined], [true, 'owner-only', undefined]])
    }
  })

  it('any other link this user, the Administrators group or SYSTEM owns is passed over whatever its own rights; one another account owns, or whose owner was not read, refuses the folder', async () => {
    const out = await secureFoldersWindows(DIRS, answer([
      // The shared folders' junctions, a symbolic link to a file, another kind of reparse point (a cloud placeholder).
      folder(DIRS[0], [inherits('.claude.json'), link('.ssh', true, 'Junction', USER), link('tool.exe', false, 'SymbolicLink', OWNER_ONLY_ADMINISTRATORS_SID), link('cloud', true, '', USER), link('notes.txt', false, '', OWNER_ONLY_SYSTEM_SID)]),
      // A link's own rights are not judged (it is never read through).
      folder(DIRS[1], [inherits('.credentials.json'), { ...link('projects', true, 'Junction', USER), rules: [rule1('S-1-1-0')] }]),
      folder(DIRS[2], []),
    ]), undefined, INSIDE)
    expect(out.map((r) => [r.ok, r.detail, r.takenOver])).toEqual(DIRS.map(() => [true, 'owner-only', undefined]))
    const cases: Array<[string, unknown, string]> = [
      ['a junction another account owns', link('todos', true, 'Junction', OTHER), "an entry inside it is another account's"],
      ['a symbolic link to a file LOCAL SERVICE owns', link('tool.exe', false, 'SymbolicLink', 'S-1-5-19'), "an entry inside it is another account's"],
      ['a cloud placeholder another account owns', link('cloud', false, '', OTHER), "an entry inside it is another account's"],
      ['a link whose owner was not read', link('todos'), 'what is inside it was not read'],
      ['a link whose owner is empty', link('todos', true, 'Junction', ''), 'what is inside it was not read'],
      ['a link whose owner is not a word', link('todos', true, 'Junction', 42), 'what is inside it was not read'],
    ]
    for (const [name, bad, detail] of cases) {
      const res = await secureFoldersWindows(DIRS, answer([folder(DIRS[0], [inherits('.claude.json')]), folder(DIRS[1], [inherits('.credentials.json'), bad]), folder(DIRS[2], [])]), undefined, INSIDE)
      expect(res.map((r) => [r.ok, r.detail]), name).toEqual([[true, 'owner-only'], [false, detail], [true, 'owner-only']])
    }
  })

  it('any other entry another account still owns refuses the folder, whatever its rights; one the read made this user\'s is judged as any other and counted', async () => {
    for (const bad of [entry('theirs.json', OTHER, [rule1(USER, { inherited: true })]), entry('svc', 'S-1-5-19', [rule1('S-1-5-19')], true), entry('notes.json', OTHER, [])]) {
      const res = await secureFoldersWindows(DIRS, answer([folder(DIRS[0], [inherits('.claude.json')]), folder(DIRS[1], [inherits('.credentials.json'), bad]), folder(DIRS[2], [])]), undefined, INSIDE)
      expect(res.map((r) => [r.ok, r.detail, r.takenOver]), bad.name).toEqual([[true, 'owner-only', undefined], [false, "an entry inside it is another account's", undefined], [true, 'owner-only', undefined]])
    }
    const made = (name: string, folderToo = false) => ({ ...entry(name, USER, takenRights(), folderToo), takenOver: true })
    const out = await secureFoldersWindows(DIRS, answer([
      folder(DIRS[0], [inherits('.claude.json')]),
      folder(DIRS[1], [inherits('.credentials.json'), made('theirs.json'), made('svc', true)]),
      folder(DIRS[2], [made('notes.json')]),
    ]), undefined, INSIDE)
    expect(out.map((r) => [r.ok, r.detail, r.takenOver])).toEqual([[true, 'owner-only', undefined], [true, 'owner-only', 2], [true, 'owner-only', 1]])
    // One made this user's that still lets another account in refuses the folder; nothing is counted.
    const leaky = { ...entry('theirs.json', USER, [rule1(USER, { inherited: true }), rule1(OTHER, { rights: READ_EXECUTE })]), takenOver: true }
    const refused = await secureFoldersWindows([DIRS[1]], answer([folder(DIRS[1], [made('a.json'), leaky])]), undefined, INSIDE)
    expect(refused.map((r) => [r.ok, r.detail, r.takenOver])).toEqual([[false, 'an entry inside it is not owner-only', undefined]])
    // Only a plain "made this user's" is counted.
    for (const odd of ['true', 1, {}]) {
      const res = await secureFoldersWindows([DIRS[1]], answer([folder(DIRS[1], [{ ...made('a.json'), takenOver: odd }])]), undefined, INSIDE)
      expect(res.map((r) => [r.ok, r.takenOver]), JSON.stringify(odd)).toEqual([[true, undefined]])
    }
  })

  it('an answer that does not say what is inside, or says it could not be read or made owner-only, is never a pass', async () => {
    const shapes: Array<[string, unknown, string]> = [
      ['no read of what is inside (an answer of the earlier shape)', { dir: DIRS[0], error: null, owner: USER, protected: true, rules: [rule1(USER), rule1(OWNER_ONLY_SYSTEM_SID)] }, 'what is inside it was not read'],
      ['what is inside could not be made owner-only', folder(DIRS[0], [], 'what is inside it could not be made owner-only'), 'what is inside it could not be made owner-only'],
      ['an error with a list', folder(DIRS[0], [inherits('.claude.json')], 'anything'), 'what is inside it could not be made owner-only'],
      ['an entry that is not an object', folder(DIRS[0], ['x']), 'what is inside it was not read'],
    ]
    for (const [name, read, detail] of shapes) {
      const out = await secureFoldersWindows([DIRS[0]], answer([read]), undefined, INSIDE)
      expect(out.map((r) => [r.ok, r.detail, r.unread]), name).toEqual([[false, detail, undefined]])
    }
    // A single entry printed as one object (not a list) is still read.
    expect((await secureFoldersWindows([DIRS[0]], answer([folder(DIRS[0], inherits('.claude.json'))]), undefined, INSIDE))[0]).toMatchObject({ ok: true })
    expect((await secureFoldersWindows([DIRS[0]], answer([folder(DIRS[0], keptGroupRead('.claude.json'))]), undefined, INSIDE))[0]).toMatchObject({ ok: false })
  })

  it('a folder whose own read is refused keeps that reason', async () => {
    const out = await secureFoldersWindows([DIRS[0]], answer([{ ...folder(DIRS[0], [keptGroupRead('.claude.json')]), protected: false }]), undefined, INSIDE)
    expect(out[0]).toMatchObject({ ok: false, detail: 'it inherits rights from above' })
  })
})

describe('only the account sign-in folders ask for what is inside to be read', () => {
  const OWN_ONLY = { dir: DIRS[0], error: null, owner: USER, protected: true, rules: [rule1(USER), rule1(OWNER_ONLY_SYSTEM_SID)] }

  it('a call without the option asks the script for the folders\' own rights alone (whatever this process\'s environment holds), and an answer that says nothing of what is inside passes', async () => {
    const saved = process.env[OWNER_ONLY_INSIDE_ENV]
    process.env[OWNER_ONLY_INSIDE_ENV] = '1'
    try {
      const envs: Array<Record<string, string>> = []
      const out = await secureFoldersWindows([DIRS[0]], async (_s, env) => { envs.push(env); return JSON.stringify({ user: USER, folders: [OWN_ONLY] }) })
      expect(out.map((r) => [r.ok, r.detail])).toEqual([[true, 'owner-only']])
      expect(envs[0][OWNER_ONLY_INSIDE_ENV]).toBe('0')
      expect(envs[0][OWNER_ONLY_SHARED_ENV]).toBe('')
      // Even an answer whose inside would refuse the folder: it was not asked for.
      expect((await secureFoldersWindows([DIRS[0]], answer([folder(DIRS[0], [keptGroupRead('.claude.json')])])))[0]).toMatchObject({ ok: true })
    } finally {
      if (saved === undefined) delete process.env[OWNER_ONLY_INSIDE_ENV]
      else process.env[OWNER_ONLY_INSIDE_ENV] = saved
    }
  })

  it('the sign-in folders\' call asks for it, names the shared entries (never a sign-in file in any letter case, never one that cannot be named), and refuses that same answer', async () => {
    const envs: Array<Record<string, string>> = []
    const shared = [`${HOME}\\.gitconfig`, `${HOME}\\.claude.json`, `${HOME}\\.CREDENTIALS.JSON`, `${HOME}\\.Claude.Json`, 'relative\\.npmrc', `${HOME}\\.npmrc`]
    const out = await secureFoldersWindows([DIRS[0]], async (_s, env) => { envs.push(env); return JSON.stringify({ user: USER, folders: [OWN_ONLY] }) }, undefined, { inside: true, shared })
    expect(out.map((r) => [r.ok, r.detail])).toEqual([[false, 'what is inside it was not read']])
    expect(envs[0][OWNER_ONLY_INSIDE_ENV]).toBe('1')
    expect(envs[0][OWNER_ONLY_SHARED_ENV].split('\n')).toEqual([`${HOME}\\.gitconfig`, `${HOME}\\.npmrc`])
  })

  it('a script call that ran past its time limit is no read, and the rule with Windows\' own programs is not tried after it', async () => {
    const started: string[] = []
    const tools: NativeOwnerOnlyTools = {
      run: async (program) => { started.push(program); return { code: 0, stdout: '' } },
      lstat: () => { started.push('lstat'); return null },
      isFolder: () => false,
      mkdir: () => { started.push('mkdir') },
    }
    const killed = async () => { throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }) }
    const out = await secureFoldersWindows(DIRS, killed, tools, INSIDE)
    expect(out.map((r) => [r.ok, r.unread])).toEqual(DIRS.map(() => [false, true]))
    expect(started).toEqual([])
    // A refusal of the script (it fails at once) still goes to that route.
    const refused = async () => { throw Object.assign(new Error('Cannot invoke method.'), { code: 1, killed: false }) }
    await secureFoldersWindows(DIRS, refused, tools, INSIDE)
    expect(started[0]).toBe('whoami')
  })
})

describe('the verdict on what is inside (ownerOnlyInsideVerdict)', () => {
  it('judges the read as the folder\'s answer carries it', () => {
    const verdict = rule.ownerOnlyInsideVerdict
    expect(verdict({ inside: [inherits('a')] }, USER)).toEqual({ ok: true, detail: 'owner-only' })
    expect(verdict({ inside: [] }, USER)).toEqual({ ok: true, detail: 'owner-only' })
    expect(verdict({ inside: [inherits('a', OWNER_ONLY_SYSTEM_SID)] }, USER)).toEqual({ ok: true, detail: 'owner-only' })
    expect(verdict({ inside: [keptGroupRead('a')] }, USER)).toEqual({ ok: false, detail: 'an entry inside it is not owner-only' })
    expect(verdict({ inside: [entry('a', OTHER, [])] }, USER)).toEqual({ ok: false, detail: "an entry inside it is another account's" })
    expect(verdict({ inside: [{ ...inherits('a'), takenOver: true }, { ...inherits('b'), takenOver: true }, link('c', true, 'Junction', USER)] }, USER)).toEqual({ ok: true, detail: 'owner-only', takenOver: 2 })
    expect(verdict({ inside: [inherits('a')] }, '')).toMatchObject({ ok: false })
    expect(verdict(undefined, USER)).toMatchObject({ ok: false })
    expect(verdict({}, USER)).toEqual({ ok: false, detail: 'what is inside it was not read' })
    // The reasons it gives are the ones the app logs in its own words.
    for (const r of rule.OWNER_ONLY_INSIDE_REASONS) expect(r).not.toMatch(/[\\/:]|S-1-/)
    // Those that say the read failed, as against an entry judged, are among them.
    for (const r of rule.OWNER_ONLY_INSIDE_FAILED_REASONS) expect(rule.OWNER_ONLY_INSIDE_REASONS).toContain(r)
    expect([...rule.OWNER_ONLY_INSIDE_FAILED_REASONS].sort()).toEqual(['what is inside it could not be made owner-only', 'what is inside it was not read'])
  })
})

describe('the script: the owner and the rights written separately, then what is directly inside read and put right', () => {
  const lines = OWNER_ONLY_SCRIPT.split('\n')
  const at = (needle: string) => { const i = lines.findIndex((l) => l.includes(needle)); expect(i, needle).toBeGreaterThan(-1); return i }

  it('writes the folder\'s owner alone first, then its rights alone (no owner in that write)', () => {
    const ownerWrite = at('[IO.Directory]::SetAccessControl($d, $o)')
    expect(at('$o.SetOwner($user)')).toBeLessThan(ownerWrite)
    const rightsWrite = at('[IO.Directory]::SetAccessControl($d, $s)')
    expect(ownerWrite).toBeLessThan(rightsWrite)
    expect(lines.slice(ownerWrite + 1, rightsWrite).join('\n')).not.toMatch(/SetOwner/)
    expect(OWNER_ONLY_SCRIPT).not.toMatch(/\$s\.SetOwner/)
  })

  it('reads what is inside only when the call asks for it, and only once the folder itself was read back', () => {
    expect(OWNER_ONLY_SCRIPT).toContain(`$walk = $env:${OWNER_ONLY_INSIDE_ENV} -eq '1'`)
    const gate = at('    if ($walk) {')
    expect(at('$done[$d] = $true')).toBeLessThan(gate)
    expect(gate).toBeLessThan(at('EnumerateFileSystemInfos()'))
  })

  it('lists only the entries directly inside the folder, once: never a folder below it', () => {
    expect(OWNER_ONLY_SCRIPT.split('EnumerateFileSystemInfos()').length - 1).toBe(1)
    expect(OWNER_ONLY_SCRIPT).toContain('foreach ($e in @(([IO.DirectoryInfo]$root).EnumerateFileSystemInfos())) {')
    expect(OWNER_ONLY_SCRIPT).not.toMatch(/\$todo|Stack\[|\.Push\(|-Recurse|AllDirectories/)
  })

  it('never goes through a link: a sign-in file that is one is noted unread; of any other only its own owner is read, and it is never changed', () => {
    const list = at('EnumerateFileSystemInfos()')
    const signInLink = at('if ($isLink -and $cred) { $inside.Add(')
    const otherLink = at('        if ($isLink) {')
    const firstRead = lines.findIndex((l, i) => i > list && l.includes('GetAccessControl($p'))
    expect(at('if ($asked.ContainsKey($p)) { continue }')).toBeLessThan(signInLink)
    expect(signInLink).toBeGreaterThan(list)
    expect(signInLink).toBeLessThan(otherLink)
    expect(lines[signInLink]).toMatch(/continue \}$/)
    expect(lines[signInLink]).toContain('link = $true')
    expect(lines[signInLink]).not.toMatch(/GetAccessControl/)
    // The other link's block: the owner section alone, read by the link's name, the entry noted with that owner, then on.
    const end = lines.findIndex((l, i) => i > otherLink && l === '        }')
    const block = lines.slice(otherLink, end + 1).join('\n')
    // Opened as a block of its own, never passed over before its owner is read.
    expect(lines[otherLink]).toBe("        if ($isLink) {")
    expect(firstRead).toBe(otherLink + 1)
    expect(block).toContain('[IO.Directory]::GetAccessControl($p, $ownerOnly)')
    expect(block).toContain('[IO.File]::GetAccessControl($p, $ownerOnly)')
    expect(block).toContain('owner = $lo')
    expect(block).toMatch(/\n {10}continue\n {8}\}$/)
    expect(block).not.toMatch(/SetAccessControl|SetOwner|\$both|Rules|EnumerateFileSystemInfos/)
    expect(OWNER_ONLY_SCRIPT).toContain("$ownerOnly = [Security.AccessControl.AccessControlSections]'Owner'")
    // A sign-in file by its name in any letter case: looked up upper-cased, the invariant way, in a table of upper-cased names.
    expect(OWNER_ONLY_SCRIPT).toContain('$cred = $signIn.ContainsKey($e.Name.ToUpperInvariant())')
    expect(OWNER_ONLY_SCRIPT).toContain("$signIn = @{ '.CLAUDE.JSON' = $true; '.CREDENTIALS.JSON' = $true }")
    expect(OWNER_ONLY_SCRIPT).toContain(`$okOwner = @{ ($user.Value) = $true; '${OWNER_ONLY_SYSTEM_SID}' = $true; '${OWNER_ONLY_ADMINISTRATORS_SID}' = $true }`)
  })

  it('makes another account\'s entry this user\'s first, never a sign-in file or a file with more than one name: the owner alone written, then read again', () => {
    const take = at('if (-not $okOwner.ContainsKey($own) -and -not $cred -and ($isDir -or (OneName $p))) {')
    const fix = at('if (-not $ok -and $okOwner.ContainsKey($own) -and ($isDir -or $taken -or (OneName $p))) {')
    expect(at('$own = $a.GetOwner($sidType).Value')).toBeLessThan(take)
    expect(take).toBeLessThan(fix)
    const body = lines.slice(take, fix).join('\n')
    expect(body).toContain('$w.SetOwner($user)')
    expect(body).toMatch(/\[IO\.Directory\]::SetAccessControl\(\$p, \$w\)/)
    expect(body).toMatch(/\[IO\.File\]::SetAccessControl\(\$p, \$w\)/)
    expect(body).not.toMatch(/AddAccessRule|RemoveAccessRule|SetAccessRuleProtection|\$rightsOnly/)
    expect(body).toContain('$taken = $own -eq $user.Value')
    // One that cannot be made this user's: passed on to the verdict (refused), never a failure of the whole read; one gone meanwhile is passed over.
    expect(body).toContain('} catch { if (-not (There $p)) { continue } }')
  })

  it('puts right only an entry this user, the Administrators group or SYSTEM owns, never a file with more than one name: its own entries removed, inheritance on, the rights alone written, then read again', () => {
    const fix = at('if (-not $ok -and $okOwner.ContainsKey($own) -and ($isDir -or $taken -or (OneName $p))) {')
    expect(fix).toBeGreaterThan(at('        if ($isLink) {'))
    const body = lines.slice(fix, fix + 11).join('\n')
    expect(body).toMatch(/GetAccessControl\(\$p, \$rightsOnly\)/)
    expect(body).toMatch(/RemoveAccessRuleSpecific/)
    expect(body).toMatch(/SetAccessRuleProtection\(\$false, \$false\)/)
    expect(body).toMatch(/SetAccessControl\(\$p, \$t\)/)
    expect(body).toMatch(/GetAccessControl\(\$p, \$both\)/)
    expect(body).not.toMatch(/SetOwner/)
    expect(OWNER_ONLY_SCRIPT).toContain("$rightsOnly = [Security.AccessControl.AccessControlSections]'Access'")
    // A file's names are counted by fsutil from the system folder; the script's text names no path.
    expect(OWNER_ONLY_SCRIPT).toContain("$fsutil = [IO.Path]::Combine([Environment]::SystemDirectory, 'fsutil.exe')")
    expect(OWNER_ONLY_SCRIPT).toMatch(/function OneName\(\[string\]\$x\) \{ \$ErrorActionPreference = 'Continue'; \$o = @\(& \$fsutil hardlink list \$x 2>\$null\); \(\$LASTEXITCODE -eq 0\) -and \(\$o\.Count -eq 1\) \}/)
    expect(OWNER_ONLY_SCRIPT).not.toMatch(/[A-Za-z]:\\|System32/)
  })

  it('every entry read comes back with its owner and rights and whether it was made this user\'s; every one not owner-only counts towards the read\'s limit', () => {
    expect(OWNER_ONLY_SCRIPT).toContain('$inside.Add([ordered]@{ name = $e.Name; link = $false; folder = $isDir; owner = $own; rules = (Rules $a); takenOver = $taken })')
    expect(OWNER_ONLY_SCRIPT).toContain("if (-not $ok) { $refused++; if ($refused -ge 50) { throw 'too many' } }")
    expect(OWNER_ONLY_SCRIPT).toContain("if (-not $okOwner.ContainsKey($lo)) { $refused++; if ($refused -ge 50) { throw 'too many' } }")
  })

  it('leaves out a shared entry only while it is a file with more than one name, never a sign-in file', () => {
    const skip = at('$shared.ContainsKey($p)')
    expect(lines[skip]).toContain("-not $cred -and $shared.ContainsKey($p) -and [string]$e.LinkType -eq 'HardLink') { continue }")
    expect(lines[skip]).toContain('-not $isDir -and -not $isLink')
    expect(OWNER_ONLY_SCRIPT).toContain(`foreach ($x in ($env:${OWNER_ONLY_SHARED_ENV} -split`)
  })

  it('passes over an entry gone since it was listed; any other failure refuses the folder', () => {
    expect(OWNER_ONLY_SCRIPT).toContain('function There([string]$x) { [IO.File]::Exists($x) -or [IO.Directory]::Exists($x) }')
    expect(OWNER_ONLY_SCRIPT.split('catch { if (There $p) { throw }; continue }').length - 1).toBe(3)
  })

  it('a failure inside is that folder\'s alone, in fixed words', () => {
    expect(OWNER_ONLY_SCRIPT).toContain("$r.insideError = 'what is inside it could not be made owner-only'")
  })
})

describe('the rule with Windows\' own programs sets the rights without the restore privilege', () => {
  it('inheritance off, the user and SYSTEM granted, every other account\'s own entry removed by SID, on the folder itself', () => {
    const args = rule.nativeRightsArgs('C:\\p\\a', USER, `O:BAG:SYD:AI(A;;FR;;;${OTHER})(D;;0x100116;;;BG)(A;OICI;FA;;;BA)(A;;FA;;;${USER})(A;OICIID;FA;;;WD)(A;OICIID;FA;;;SY)`)
    expect(args).toEqual(['C:\\p\\a', '/inheritance:r', '/grant:r', `*${USER}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '/remove', `*${OTHER}`, '*S-1-5-32-546', '*S-1-5-32-544', '/L'])
    expect(args).not.toContain('/restore')
    // Nothing of its own to remove: no /remove.
    expect(rule.nativeRightsArgs('C:\\p\\a', USER, 'O:BAG:SYD:AI(A;OICIID;FA;;;WD)')).toEqual(['C:\\p\\a', '/inheritance:r', '/grant:r', `*${USER}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '/L'])
    expect(rule.nativeRightsArgs('C:\\p\\a', USER, null)).toEqual(['C:\\p\\a', '/inheritance:r', '/grant:r', `*${USER}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '/L'])
  })

  it('the read of what is inside uses only what Constrained Language Mode allows, lists only the entries directly inside, and never goes through a link (of one only its own SDDL is read)', () => {
    const s = rule.OWNER_ONLY_INSIDE_SCRIPT
    expect(s.split('Get-ChildItem').length - 1).toBe(1)
    expect(s).toContain('foreach ($e in @(Get-ChildItem -LiteralPath $root -Force)) {')
    expect(s).toMatch(/\(Get-Acl -LiteralPath \$p\)\.Sddl/)
    expect(s).toMatch(/\$attributes -band 0x400/)
    expect(s).not.toMatch(/-Recurse|New-Object|\.GetAccessControl|::|pscustomobject|\[ordered\]|\/T\b|\$todo/)
    // Names come back as numbers (ASCII whatever the language).
    expect(s).toMatch(/name = \[int\[\]\]\[char\[\]\]\$e\.Name/)
    // A sign-in file that is a link comes back unread, before anything is read; any other link with its own SDDL and its kind.
    expect(s).toContain('$cred = [bool]$signIn[$e.Name.ToUpperInvariant()]')
    expect(s).toContain("$signIn = @{ '.CLAUDE.JSON' = $true; '.CREDENTIALS.JSON' = $true }")
    const signInLink = 'if ($isLink -and $cred) { $r.inside += @{ name = [int[]][char[]]$e.Name; attributes = $attributes; sddl = $null; linkType = [string]$e.LinkType }; continue }'
    expect(s.indexOf(signInLink)).toBeGreaterThan(-1)
    expect(s.indexOf(signInLink)).toBeLessThan(s.indexOf('Get-Acl -LiteralPath $p'))
    expect(s).toContain('if ($isLink) { $x.linkType = [string]$e.LinkType }')
    expect(s).not.toMatch(/if \(\$isLink -and -not \$cred\)/)
  })

  it('that read decides nothing itself: every entry it reads comes back, and the verdict judges it', () => {
    const s = rule.OWNER_ONLY_INSIDE_SCRIPT
    expect(s).toContain('$x = @{ name = [int[]][char[]]$e.Name; attributes = $attributes; sddl = $sddl }')
    expect(s).toContain('$r.inside += $x')
    expect(s).not.toMatch(/\$clean|\$ownerOk|\$uIds|\$refused|too many/)
  })

  it('that read passes over an entry gone since it was listed, and leaves out a shared entry only while it is a file with more than one name', () => {
    const s = rule.OWNER_ONLY_INSIDE_SCRIPT
    expect(s).toContain('try { $sddl = [string](Get-Acl -LiteralPath $p).Sddl } catch { if (Test-Path -LiteralPath $p) { throw } else { continue } }')
    expect(s).toContain("if (-not $isDir -and -not $isLink -and -not $cred -and $shared[$p] -and [string]$e.LinkType -eq 'HardLink') { continue }")
  })
})
