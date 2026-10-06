// WP1.10, WP1.23, WP1.28, WP1.30 -- WP2 slice 3d (plan A5; design 5.4, 5.5,
// 9.3, 12): managed Codex account folders on a REAL filesystem, with the real
// mkdirSecure and a deterministic fake Codex CLI through real processes. Two
// managed accounts get distinct, owner-only (POSIX) homes; each signs in,
// reports and signs out in its own home only; links and junctions planted in
// or over the managed tree are refused; an abandoned setup's folder is removed
// only when it is plainly the app's own; a resources directory reached through
// a link resolves to its canonical path; and an external home that overlaps
// the managed tree blocks every managed operation.
//
// HOST QUARANTINE: this suite writes a temp directory, creates junctions or
// symlinks, and starts processes. It runs in CI and on the VM, never on the
// owner's workstation. It touches no ACL, no real home and no real Codex.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createCodexPackage, runCodexCli, CODEX_REALMS_DIRNAME } from '../../src/main/providers/codex'
import type { CodexDiscoveryDeps, CodexFolderLookup } from '../../src/main/providers/codex'
import { mkdirSecure, _setRootsForTest } from '../../src/main/account-profiles'

const IS_WIN = process.platform === 'win32'
const hex = (c: string) => c.repeat(16)
const RA = `realm-${hex('a')}`
const RB = `realm-${hex('b')}`
type RealmRecord = Extract<CodexFolderLookup, { ok: true }>['realm']
const managed = (id: string, lifecycle: RealmRecord['lifecycle'] = 'pending'): RealmRecord => ({ id, providerId: 'codex', kind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${id}`, lifecycle })

// A fake with the pinned CLI's observable contract: its "credential" lives in
// CODEX_HOME, it writes a log there like the real CLI, and it fails loudly if
// an ambient credential reached it or its home does not exist.
const FAKE = `
const fs = require('fs'), path = require('path')
const a = process.argv.slice(2).join(' ')
if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY) { process.stderr.write('LEAK\\n'); process.exit(9) }
if (a === '--version') { process.stdout.write('codex-cli 0.155.1\\n'); process.exit(0) }
const home = process.env.CODEX_HOME
if (!home || !fs.existsSync(home)) { process.stderr.write('no CODEX_HOME\\n'); process.exit(8) }
fs.mkdirSync(path.join(home, 'log'), { recursive: true })
fs.appendFileSync(path.join(home, 'log', 'codex.log'), a + '\\n')
const auth = path.join(home, 'auth.json')
if (a === 'login status') {
  if (fs.existsSync(auth)) { process.stderr.write('Logged in using ChatGPT\\n'); process.exit(0) }
  process.stderr.write('Not logged in\\n'); process.exit(1)
}
if (a === 'login --device-auth') { fs.writeFileSync(auth, 'x'); process.stdout.write('Enter this one-time code: ABCD-EFGH\\n'); process.exit(0) }
if (a === 'logout') { try { fs.unlinkSync(auth) } catch {} process.stdout.write('Successfully logged out\\n'); process.exit(0) }
process.stderr.write('unknown ' + a + '\\n'); process.exit(64)
`

let tmp: string
let res: string
let bin: string
let exe: string
let savedCodexHome: Array<[string, string | undefined]>

beforeEach(() => {
  tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-realms-')))
  res = path.join(tmp, 'res')
  bin = path.join(tmp, 'bin')
  fs.mkdirSync(res)
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'fake-codex.js'), FAKE)
  if (IS_WIN) {
    exe = path.join(bin, 'codex.cmd')
    fs.writeFileSync(exe, `@ECHO off\r\n"${process.execPath}" "%~dp0\\fake-codex.js" %*\r\n`)
  } else {
    exe = path.join(bin, 'codex')
    fs.writeFileSync(exe, `#!${process.execPath}\nrequire(${JSON.stringify(path.join(bin, 'fake-codex.js'))})\n`, { mode: 0o755 })
  }
  _setRootsForTest({ resourcesDir: res, sharedRoot: path.join(tmp, 'shared') })
  savedCodexHome = Object.keys(process.env).filter((k) => k.toUpperCase() === 'CODEX_HOME').map((k) => [k, process.env[k]])
  for (const [k] of savedCodexHome) delete process.env[k]
})

afterEach(() => {
  _setRootsForTest(null)
  for (const [k, v] of savedCodexHome) process.env[k] = v
  fs.rmSync(tmp, { recursive: true, force: true })
})

const statOf = (p: string) => {
  const s = fs.statSync(p, { bigint: true })
  return { size: Number(s.size), mtimeMs: Number(s.mtimeMs), ctimeMs: Number(s.ctimeMs), dev: String(s.dev), ino: String(s.ino), isFile: s.isFile() }
}
const withNode = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`
const poisoned = { ...process.env, PATH: withNode, Path: undefined, OPENAI_API_KEY: 'sk-ambient', CODEX_API_KEY: 'x' } as Record<string, string | undefined>

/** The package over a registry of realms, with the real folder port. */
function pkgFor(realms: Map<string, RealmRecord>, resourcesDir = res) {
  const executablePorts = { resolve: () => exe, realpath: (p: string) => fs.realpathSync.native(p), stat: statOf, platform: process.platform }
  const discoveryDeps = async (): Promise<CodexDiscoveryDeps> => ({
    ...executablePorts,
    run: (cmd, env) => runCodexCli(cmd, { env, timeoutMs: 20_000 }),
    env: poisoned,
    versionHome: () => {
      const home = fs.mkdtempSync(path.join(tmp, 'v-'))
      return { home, dispose: () => fs.rmSync(home, { recursive: true, force: true }) }
    },
    now: () => Date.now(),
  })
  return createCodexPackage({
    realms: {
      lookup: async (ref) => {
        const realm = realms.get(ref.authRealmId)
        return realm ? { ok: true, realm: { ...realm, lifecycle: realm.lifecycle ?? 'pending' }, resourcesDir } : { ok: false }
      },
      mkdirSecure,
    },
    discoveryDeps,
    authPorts: { executablePorts, baseEnv: async () => poisoned },
  })
}

const homeOf = (id: string) => path.join(res, CODEX_REALMS_DIRNAME, id)
const link = (target: string, at: string) => fs.symlinkSync(target, at, IS_WIN ? 'junction' : 'dir')

describe('managed Codex folders on a real filesystem', () => {
  it('two managed accounts get distinct, real, owner-only homes and stay isolated through sign-in, status and sign-out', async () => {
    const realms = new Map([[RA, managed(RA)], [RB, managed(RB)]])
    const pkg = pkgFor(realms)
    expect(await pkg.realmFolders!.prepare({ authRealmId: RA })).toEqual({ ok: true, created: true })
    expect(await pkg.realmFolders!.prepare({ authRealmId: RB })).toEqual({ ok: true, created: true })
    for (const p of [path.join(res, CODEX_REALMS_DIRNAME), homeOf(RA), homeOf(RB)]) {
      const st = fs.lstatSync(p)
      expect(st.isDirectory() && !st.isSymbolicLink(), p).toBe(true)
      if (!IS_WIN) expect(st.mode & 0o777, p).toBe(0o700)
    }
    expect(fs.statSync(homeOf(RA), { bigint: true }).ino).not.toBe(fs.statSync(homeOf(RB), { bigint: true }).ino)

    expect(await pkg.setup!.discover()).toMatchObject({ state: 'found' })
    const auth = pkg.auth!
    expect(await auth.login({ authRealmId: RA }, 'device')).toMatchObject({ ok: true, state: 'signed-in' })
    expect(await auth.status({ authRealmId: RA })).toMatchObject({ ok: true, state: 'signed-in' })
    expect(await auth.status({ authRealmId: RB })).toMatchObject({ ok: true, state: 'signed-out' })
    expect(await auth.login({ authRealmId: RB }, 'device')).toMatchObject({ ok: true, state: 'signed-in' })
    expect(await auth.logout({ authRealmId: RA })).toMatchObject({ ok: true, state: 'signed-out' })
    expect(await auth.status({ authRealmId: RB })).toMatchObject({ ok: true, state: 'signed-in' })
    expect(fs.existsSync(path.join(homeOf(RA), 'auth.json'))).toBe(false)
    expect(fs.existsSync(path.join(homeOf(RB), 'auth.json'))).toBe(true)
  }, 60_000)

  it('an abandoned setup\'s folder, logs and all, is removed; a sibling and the root stay', async () => {
    const realms = new Map([[RA, managed(RA)], [RB, managed(RB)]])
    const pkg = pkgFor(realms)
    await pkg.realmFolders!.prepare({ authRealmId: RA })
    await pkg.realmFolders!.prepare({ authRealmId: RB })
    expect(await pkg.setup!.discover()).toMatchObject({ state: 'found' })
    await pkg.auth!.status({ authRealmId: RA })
    fs.mkdirSync(path.join(homeOf(RA), 'sessions', '2026'), { recursive: true })
    fs.writeFileSync(path.join(homeOf(RA), 'sessions', '2026', 'rollout.jsonl'), '{}\n')
    expect(await pkg.realmFolders!.remove({ authRealmId: RA }, { contents: 'empty-only' })).toMatchObject({ ok: false, code: 'not-empty' })
    expect(await pkg.realmFolders!.remove({ authRealmId: RA }, { contents: 'all' })).toEqual({ ok: true, removed: true })
    expect(fs.existsSync(homeOf(RA))).toBe(false)
    expect(fs.existsSync(homeOf(RB))).toBe(true)
    expect(await pkg.realmFolders!.remove({ authRealmId: RA }, { contents: 'all' })).toEqual({ ok: true, removed: false })
  }, 60_000)

  it('a junction or symlink planted inside a folder refuses the removal, and the file it points at survives', async () => {
    const pkg = pkgFor(new Map([[RA, managed(RA)]]))
    await pkg.realmFolders!.prepare({ authRealmId: RA })
    const victim = path.join(tmp, 'victim')
    fs.mkdirSync(victim)
    fs.writeFileSync(path.join(victim, 'thesis.docx'), 'irreplaceable')
    fs.writeFileSync(path.join(homeOf(RA), 'config.toml'), '')
    link(victim, path.join(homeOf(RA), 'sessions'))
    expect(await pkg.realmFolders!.remove({ authRealmId: RA }, { contents: 'all' })).toMatchObject({ ok: false, code: 'unsafe-contents' })
    expect(fs.readFileSync(path.join(victim, 'thesis.docx'), 'utf8')).toBe('irreplaceable')
    expect(fs.existsSync(path.join(homeOf(RA), 'config.toml'))).toBe(true)
  })

  it('a junction or symlink planted AS a home or as the managed root is refused, and nothing is made or removed through it', async () => {
    const victim = path.join(tmp, 'victim')
    fs.mkdirSync(victim)
    fs.writeFileSync(path.join(victim, 'auth.json'), 'theirs')
    const root = path.join(res, CODEX_REALMS_DIRNAME)
    fs.mkdirSync(root)
    link(victim, homeOf(RA))
    const pkg = pkgFor(new Map([[RA, managed(RA)]]))
    expect(await pkg.realmFolders!.prepare({ authRealmId: RA })).toMatchObject({ ok: false, code: 'unsafe-path' })
    expect(await pkg.realmFolders!.remove({ authRealmId: RA }, { contents: 'all' })).toMatchObject({ ok: false, code: 'unsafe-path' })
    expect(fs.readFileSync(path.join(victim, 'auth.json'), 'utf8')).toBe('theirs')
    if (!IS_WIN) expect(fs.statSync(victim).mode & 0o777).not.toBe(0o700)

    fs.unlinkSync(homeOf(RA))
    fs.rmdirSync(root)
    link(victim, root)
    expect(await pkg.realmFolders!.prepare({ authRealmId: RA })).toMatchObject({ ok: false, code: 'unsafe-path' })
    expect(fs.readdirSync(victim)).toEqual(['auth.json'])
  })

  it('a resources directory reached through a link resolves to its canonical path', async () => {
    const via = path.join(tmp, 'via')
    link(res, via)
    const pkg = pkgFor(new Map([[RA, managed(RA)]]), via)
    expect(await pkg.realmFolders!.prepare({ authRealmId: RA })).toEqual({ ok: true, created: true })
    expect(fs.lstatSync(homeOf(RA)).isDirectory()).toBe(true)
    expect(await pkg.setup!.discover()).toMatchObject({ state: 'found' })
    expect(await pkg.auth!.status({ authRealmId: RA })).toMatchObject({ ok: true, state: 'signed-out' })
  }, 60_000)

  it('an inherited CODEX_HOME that overlaps the managed tree blocks every managed operation', async () => {
    process.env.CODEX_HOME = path.join(res, CODEX_REALMS_DIRNAME)
    const pkg = pkgFor(new Map([[RA, managed(RA)]]))
    expect(await pkg.realmFolders!.prepare({ authRealmId: RA })).toMatchObject({ ok: false, code: 'overlaps-external' })
    expect(fs.existsSync(homeOf(RA))).toBe(false)
    delete process.env.CODEX_HOME
    // Captured when the package was made: the user's own Codex home.
    expect(await pkg.realmFolders!.prepare({ authRealmId: RA })).toMatchObject({ ok: false, code: 'overlaps-external' })
    expect(await pkgFor(new Map([[RA, managed(RA)]])).realmFolders!.prepare({ authRealmId: RA })).toMatchObject({ ok: true })
  })

  it('a folder still holding a sign-in is not removed until the CLI signs it out', async () => {
    const pkg = pkgFor(new Map([[RA, managed(RA)]]))
    await pkg.realmFolders!.prepare({ authRealmId: RA })
    expect(await pkg.setup!.discover()).toMatchObject({ state: 'found' })
    expect(await pkg.auth!.login({ authRealmId: RA }, 'device')).toMatchObject({ ok: true, state: 'signed-in' })
    expect(await pkg.realmFolders!.remove({ authRealmId: RA }, { contents: 'all' })).toMatchObject({ ok: false, code: 'credentials-present' })
    expect(fs.existsSync(path.join(homeOf(RA), 'auth.json'))).toBe(true)
    expect(await pkg.auth!.logout({ authRealmId: RA })).toMatchObject({ ok: true, state: 'signed-out' })
    expect(await pkg.realmFolders!.remove({ authRealmId: RA }, { contents: 'all' })).toEqual({ ok: true, removed: true })
  }, 60_000)

  it.runIf(IS_WIN)('Windows: a junction to a volume-GUID path -- which lstat reports as a plain folder -- refuses the removal before anything is deleted', async () => {
    const pkg = pkgFor(new Map([[RA, managed(RA)]]))
    await pkg.realmFolders!.prepare({ authRealmId: RA })
    const victim = path.join(tmp, 'victim')
    fs.mkdirSync(victim)
    fs.writeFileSync(path.join(victim, 'thesis.docx'), 'irreplaceable')
    fs.writeFileSync(path.join(homeOf(RA), 'config.toml'), '')
    const volume = execFileSync('mountvol', [victim.slice(0, 3), '/L'], { encoding: 'utf8' }).trim()
    const at = path.join(homeOf(RA), 'sessions')
    fs.symlinkSync(volume + victim.slice(3), at, 'junction')
    try {
      // The premise: the plain lstat link check cannot see it.
      expect(fs.lstatSync(at).isSymbolicLink()).toBe(false)
      expect(await pkg.realmFolders!.remove({ authRealmId: RA }, { contents: 'all' })).toMatchObject({ ok: false, code: 'unsafe-contents' })
      expect(fs.readFileSync(path.join(victim, 'thesis.docx'), 'utf8')).toBe('irreplaceable')
      expect(fs.existsSync(path.join(homeOf(RA), 'config.toml'))).toBe(true)
    } finally {
      fs.rmdirSync(at)
    }
  })
})
