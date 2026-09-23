// WP1.62, WP1.19 -- WP2 slice 3b (plan A6, A8; design 9.2, 16.3): the real
// runner and discovery against a deterministic FAKE Codex CLI, through a real
// process -- on Windows through a real npm-style `.cmd` shim and cmd.exe,
// which is where quoting and CVE-2024-27980 handling actually break.
//
// HOST QUARANTINE: this suite writes a temp directory and starts processes. It
// runs in CI and on the VM, never on the owner's workstation. It touches no
// ACL, no junction, no real home and no real Codex.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { codexCommandLine, runCodexCli, discoverCodex, codexCliEnv, parseCodexLoginStatus, createCodexAuthOperations } from '../../src/main/providers/codex'
import type { CodexCliOperation, CodexDiscovery, CodexAuthDeps } from '../../src/main/providers/codex'

const IS_WIN = process.platform === 'win32'
let dir: string
let exe: string

// A fake that behaves like the pinned CLI's observable contract, keeps its
// "credential" under CODEX_HOME, refuses a TTY stdin for an API key, and
// fails loudly if an ambient credential or NODE_OPTIONS reached it.
const FAKE = `
const fs = require('fs'), path = require('path')
const a = process.argv.slice(2).join(' ')
if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.NODE_OPTIONS) { process.stderr.write('LEAK\\n'); process.exit(9) }
if (a === '--version') { process.stdout.write('codex-cli 0.155.1\\n'); process.exit(0) }
if (a === 'sleep') { fs.writeFileSync(path.join(__dirname, 'sleep.pid'), String(process.pid)); setInterval(() => {}, 1000); return }
const home = process.env.CODEX_HOME
if (!home) { process.stderr.write('no CODEX_HOME\\n'); process.exit(8) }
const auth = path.join(home, 'auth.fake')
if (a === 'login status') {
  if (fs.existsSync(auth)) { process.stderr.write(fs.readFileSync(auth, 'utf8')); process.exit(0) }
  process.stderr.write('Not logged in\\n'); process.exit(1)
}
if (a === 'login' || a === 'login --device-auth') {
  fs.mkdirSync(home, { recursive: true })
  if (fs.existsSync(path.join(home, 'HANG'))) {
    // Waits for the user like the real browser flow: opens a "browser" (an
    // image outside the CLI's chain), and signs the realm in a little later
    // unless it is killed first. On Windows the "browser" is detached: a Node
    // parent puts its own children in a job that dies with it, and the real
    // browser, started by the native codex binary, is not in that job -- but
    // it is still this process's child by parent id, which is what a /T tree
    // kill walks. On POSIX it stays in the process group, as a browser opened
    // through xdg-open does.
    const win = process.platform === 'win32'
    const b = require('child_process').spawn(win ? 'ping' : 'sleep', win ? ['-n', '120', '127.0.0.1'] : ['120'], { stdio: 'ignore', detached: win })
    fs.writeFileSync(path.join(__dirname, 'browser.pid'), String(b.pid))
    fs.writeFileSync(path.join(__dirname, 'login.pid'), String(process.pid))
    setTimeout(() => fs.writeFileSync(auth, 'Logged in using ChatGPT\\n'), 2500)
    process.stderr.write('Open https://auth.example/oauth/authorize?state=s1 to sign in\\n')
    setInterval(() => {}, 1000)
    return
  }
  process.stderr.write(a === 'login' ? 'Starting local login server on http://localhost:1455.\\n' : 'Enter this one-time code: ABCD-EFGH\\n')
  fs.writeFileSync(auth, 'Logged in using ChatGPT\\n')
  process.stdout.write('Successfully logged in\\n'); process.exit(0)
}
if (a === 'logout') { try { fs.unlinkSync(auth) } catch {} process.stdout.write('Successfully logged out\\n'); process.exit(0) }
if (a === 'login --with-api-key') {
  if (process.stdin.isTTY) { process.stderr.write('refuses a TTY\\n'); process.exit(2) }
  let d = ''
  process.stdin.on('data', (c) => { d += c })
  process.stdin.on('end', () => {
    if (!d.trim()) process.exit(3)
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(auth, 'Logged in using an API key - ' + d.trim().slice(0, 3) + '***\\n')
    process.stdout.write('Read key ' + d.trim() + '\\nSuccessfully logged in\\n'); process.exit(0)
  })
  return
}
process.stderr.write('unknown ' + a + '\\n'); process.exit(64)
`

beforeAll(() => {
  dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccc-fake-codex-')))
  fs.writeFileSync(path.join(dir, 'fake-codex.js'), FAKE)
  if (IS_WIN) {
    // npm's own cmd-shim template: no node.exe beside it, so it runs a BARE
    // `node` -- which cmd.exe would look for in the current folder first,
    // were NoDefaultCurrentDirectoryInExePath not set. A planted node.cmd in
    // that folder must never run.
    exe = path.join(dir, 'codex.cmd')
    fs.writeFileSync(exe, [
      '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
      'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\fake-codex.js" %*', '',
    ].join('\r\n'))
    fs.writeFileSync(path.join(dir, 'node.cmd'), `@echo planted> "${path.join(dir, 'PLANTED-RAN')}"\r\n`)
  } else {
    exe = path.join(dir, 'codex')
    fs.writeFileSync(exe, `#!${process.execPath}\nrequire(${JSON.stringify(path.join(dir, 'fake-codex.js'))})\n`, { mode: 0o755 })
  }
})
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }) })

// The real node must be findable on PATH (the shim's bare `node`), first.
const withNode = `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH ?? process.env.Path ?? ''}`
const poisoned = { ...process.env, PATH: withNode, Path: undefined, OPENAI_API_KEY: 'sk-ambient', CODEX_API_KEY: 'x', NODE_OPTIONS: '--no-warnings' } as Record<string, string | undefined>
const home = (name: string) => path.join(dir, 'realms', name)

async function op(operation: CodexCliOperation, realm: string, stdin?: string) {
  const cmd = codexCommandLine(exe, operation, process.platform, { ComSpec: process.env.ComSpec, SystemRoot: process.env.SystemRoot })
  if ('refused' in cmd) throw new Error(cmd.refused)
  return runCodexCli(cmd, { env: codexCliEnv(poisoned, home(realm)), timeoutMs: 20_000, stdin })
}

describe('the runner against a fake Codex CLI (real processes)', () => {
  it('discovery proves the version through the real shim, with no ambient credential reaching it', async () => {
    const versionHome = home('version')
    let disposed = false
    const r = await discoverCodex({
      resolve: () => exe,
      realpath: (p) => fs.realpathSync.native(p),
      stat: (p) => {
        const s = fs.statSync(p, { bigint: true })
        return { size: Number(s.size), mtimeMs: Number(s.mtimeMs), ctimeMs: Number(s.ctimeMs), dev: String(s.dev), ino: String(s.ino), isFile: s.isFile() }
      },
      run: (cmd, env) => runCodexCli(cmd, { env, timeoutMs: 20_000 }),
      env: poisoned,
      platform: process.platform,
      versionHome: () => ({ home: versionHome, dispose: () => { disposed = true } }),
      now: () => 1,
    })
    if (r.state !== 'found') {
      // Say WHY: the same operation run directly, with its exit code and output.
      const direct = await op('version', 'version-diagnostic')
      throw new Error(`discovery: ${JSON.stringify(r)}\ndirect --version: ${JSON.stringify(direct)}`)
    }
    expect(r).toMatchObject({ state: 'found', version: '0.155.1', compatibility: 'supported' })
    expect(disposed).toBe(true)
  })

  it('an API key goes to stdin (a pipe, not a TTY), signs in only its own realm, and logout clears only that realm', async () => {
    expect(parseCodexLoginStatus(...fields(await op('status', 'a')))).toEqual({ state: 'signed-out' })
    const login = await op('login-api-key', 'a', 'sk-test-key\n')
    expect(login).toMatchObject({ exitCode: 0 })
    expect(parseCodexLoginStatus(...fields(await op('status', 'a')))).toEqual({ state: 'signed-in', via: 'api-key' })
    expect(parseCodexLoginStatus(...fields(await op('status', 'b')))).toEqual({ state: 'signed-out' })
    await op('login-api-key', 'b', 'sk-other\n')
    expect((await op('logout', 'a')).exitCode).toBe(0)
    expect(parseCodexLoginStatus(...fields(await op('status', 'a')))).toEqual({ state: 'signed-out' })
    expect(parseCodexLoginStatus(...fields(await op('status', 'b')))).toEqual({ state: 'signed-in', via: 'api-key' })
  })

  it('a planted node in the shim folder never runs (the current-folder search is off)', async () => {
    if (!IS_WIN) return
    expect(parseCodexLoginStatus(...fields(await op('status', 'planted')))).toEqual({ state: 'signed-out' })
    expect(fs.existsSync(path.join(dir, 'PLANTED-RAN'))).toBe(false)
  })

  it('a run past its deadline is killed with its WHOLE tree -- the sleeping grandchild is gone -- and settles', async () => {
    const cmd = IS_WIN
      ? { file: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), args: ['/d', '/v:off', '/s', '/c', `""${exe}" sleep"`], verbatim: true, cwd: dir }
      : { file: exe, args: ['sleep'], verbatim: false, cwd: dir }
    const pidFile = path.join(dir, 'sleep.pid')
    const started = Date.now()
    const r = await runCodexCli(cmd, { env: codexCliEnv(poisoned, home('sleep')), timeoutMs: 3000 })
    expect(r).toMatchObject({ timedOut: true, exitCode: null })
    expect(Date.now() - started).toBeLessThan(10_000)
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    expect(pid).toBeGreaterThan(0)
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    const deadline = Date.now() + 8000
    while (alive() && Date.now() < deadline) await new Promise((res) => setTimeout(res, 100))
    expect(alive(), `the sleeping fake (pid ${pid}) outlived the tree kill`).toBe(false)
  })
})

// WP1.20, WP1.22, WP1.51, WP1.62 -- slice 3c: the auth operations over the
// real runner, the real shim, the real process table and the real filesystem.
describe('the auth operations against the fake Codex CLI (real processes)', () => {
  const KEY = 'sk-proj-' + 'Q'.repeat(40) + '9876'
  let proven: CodexDiscovery | null = null
  const secrets = new Map<string, string>()
  const ports = {
    resolve: () => exe,
    realpath: (p: string) => fs.realpathSync.native(p),
    stat: (p: string) => {
      const s = fs.statSync(p, { bigint: true })
      return { size: Number(s.size), mtimeMs: Number(s.mtimeMs), ctimeMs: Number(s.ctimeMs), dev: String(s.dev), ino: String(s.ino), isFile: s.isFile() }
    },
    platform: process.platform,
  }
  let next = 0
  /** A managed realm whose folder exists, as slice 3d will create it. */
  const realm = () => {
    const id = 'realm-' + (++next).toString(16).padStart(16, '0')
    fs.mkdirSync(path.join(dir, 'codex-realms', id), { recursive: true })
    return id
  }
  const homeOf = (id: string) => path.join(dir, 'codex-realms', id)
  const deps = (): CodexAuthDeps => ({
    lookupRealm: async (r) => (/^realm-[0-9a-f]{16}$/.test(r.authRealmId)
      ? { ok: true, realm: { id: r.authRealmId, providerId: 'codex', kind: 'codex-home', ownership: 'conductor-managed', pathRef: `managed:${r.authRealmId}` }, roots: { resourcesDir: dir, externalDefaultHome: null } }
      : { ok: false }),
    realmIdentity: (home) => {
      const canonical = fs.realpathSync.native(home)
      const s = fs.statSync(canonical, { bigint: true })
      return { canonical, dev: String(s.dev), ino: String(s.ino), isDirectory: s.isDirectory() }
    },
    proven: () => proven,
    executablePorts: ports,
    baseEnv: async () => poisoned,
    run: (cmd, opts) => runCodexCli(cmd, opts),
    envFilePresent: (h) => { try { fs.lstatSync(path.join(h, '.env')); return true } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ENOENT' } },
    takeSecret: (h) => { const v = secrets.get(h) ?? null; secrets.delete(h); return v },
  })
  const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

  beforeAll(async () => {
    const r = await discoverCodex({ ...ports, run: (cmd, env) => runCodexCli(cmd, { env, timeoutMs: 20_000 }), env: poisoned, versionHome: () => ({ home: home('auth-version'), dispose: () => {} }), now: () => 1 })
    proven = r.state === 'found' ? r : null
  })

  it('API key into one realm over a real stdin pipe, browser into another, logout of the first only; the key never reaches the display', async () => {
    expect(proven, 'discovery through the shim').not.toBeNull()
    const [a, b, c] = [realm(), realm(), realm()]
    const ops = createCodexAuthOperations(deps())
    const shown: string[] = []
    secrets.set('h', `${KEY}\n`)
    expect(await ops.login({ authRealmId: a }, 'apiKey', { secretHandle: 'h', onOutput: (t) => shown.push(t) })).toEqual({ ok: true, state: 'signed-in', credential: 'api-key' })
    expect(shown.join('')).toContain('Read key [REDACTED]')
    expect(shown.join('')).not.toContain(KEY)
    expect(await ops.status({ authRealmId: a })).toEqual({ ok: true, state: 'signed-in', credential: 'api-key' })
    expect(await ops.status({ authRealmId: b })).toEqual({ ok: true, state: 'signed-out' })
    expect(await ops.login({ authRealmId: b }, 'browser', { onOutput: (t) => shown.push(t) })).toEqual({ ok: true, state: 'signed-in', credential: 'account' })
    expect(await ops.login({ authRealmId: c }, 'device')).toEqual({ ok: true, state: 'signed-in', credential: 'account' })
    expect(await ops.logout({ authRealmId: a })).toEqual({ ok: true, state: 'signed-out' })
    expect(await ops.status({ authRealmId: a })).toEqual({ ok: true, state: 'signed-out' })
    expect(await ops.status({ authRealmId: b })).toEqual({ ok: true, state: 'signed-in', credential: 'account' })
  })

  it('cancelling a waiting browser sign-in kills its own processes only -- the browser it opened lives -- and the realm stays signed out', async () => {
    const id = realm()
    fs.writeFileSync(path.join(homeOf(id), 'HANG'), '')
    const ops = createCodexAuthOperations(deps())
    const ac = new AbortController()
    const r = await ops.login({ authRealmId: id }, 'browser', { signal: ac.signal, onOutput: (t) => { if (/sign in/.test(t)) ac.abort() } })
    expect(r).toMatchObject({ ok: false, code: 'cancelled', state: 'signed-out' })
    const loginPid = Number(fs.readFileSync(path.join(dir, 'login.pid'), 'utf8'))
    const browserPid = Number(fs.readFileSync(path.join(dir, 'browser.pid'), 'utf8'))
    try {
      const deadline = Date.now() + 3000
      while (alive(loginPid) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50))
      expect(alive(loginPid), `the waiting fake login (pid ${loginPid}) outlived the cancel`).toBe(false)
      expect(alive(browserPid), `the "browser" (pid ${browserPid}) the sign-in opened was killed with it`).toBe(true)
      // Past the moment the fake would have signed the realm in, had it lived.
      await new Promise((res) => setTimeout(res, 3000))
      expect(await ops.status({ authRealmId: id })).toEqual({ ok: true, state: 'signed-out' })
    } finally {
      try { process.kill(browserPid) } catch { /* already gone */ }
    }
  })

  it('a managed realm holding a .env is refused before the CLI runs', async () => {
    const id = realm()
    fs.writeFileSync(path.join(homeOf(id), '.env'), 'OPENAI_API_KEY=sk-from-dotenv\n')
    const ops = createCodexAuthOperations(deps())
    expect(await ops.login({ authRealmId: id }, 'browser')).toMatchObject({ ok: false, code: 'realm-env-file' })
    expect(fs.existsSync(path.join(homeOf(id), 'auth.fake'))).toBe(false)
  })

  it('a realm folder that does not exist is refused, never created by the CLI', async () => {
    const id = 'realm-' + 'f'.repeat(16)
    const ops = createCodexAuthOperations(deps())
    expect(await ops.login({ authRealmId: id }, 'device')).toMatchObject({ ok: false, code: 'realm-unavailable' })
    expect(fs.existsSync(homeOf(id))).toBe(false)
  })
})

function fields(r: { exitCode: number | null; stdout: string; stderr: string }): [number | null, string, string] {
  return [r.exitCode, r.stdout, r.stderr]
}
