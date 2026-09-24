// WP1.62, WP1.19 -- WP2 slice 3b (plan A6, A8; design 9.2, 16.3), with the
// reviewers of commits 5a and 5b and the review diff (5b) at the end: the real
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
import { spawn as nodeSpawn } from 'node:child_process'
import { codexCommandLine, cliCommandLine, codexShellEnv, runCodexCli, discoverCodex, codexCliEnv, parseCodexLoginStatus, createCodexAuthOperations, createCodexReviewOperations, makeCodexKillTree, makeCodexProcessLister, CODEX_KILL_SETTLE_MS, CODEX_TREE_PRIME_MS } from '../../src/main/providers/codex'
import { createClaudeReviewLaunch, createClaudeReviewOperations, CLAUDE_REVIEW_ARGS } from '../../src/main/providers/claude'
import { produceReviewDiff, defaultReviewDiffDeps, findGit } from '../../src/main/review-diff'
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
    // After the delay the HANG file names (ms), so a test can place it past
    // the runner's own kill window.
    setTimeout(() => fs.writeFileSync(auth, 'Logged in using ChatGPT\\n'), Number(fs.readFileSync(path.join(home, 'HANG'), 'utf8')) || 2500)
    process.stderr.write('Open https://auth.example/oauth/authorize?state=s1 to sign in\\n')
    setInterval(() => {}, 1000)
    return
  }
  process.stderr.write(a === 'login' ? 'Starting local login server on http://localhost:1455.\\n' : 'Enter this one-time code: ABCD-EFGH\\n')
  fs.writeFileSync(auth, 'Logged in using ChatGPT\\n')
  process.stdout.write('Successfully logged in\\n'); process.exit(0)
}
if (a === 'logout') { try { fs.unlinkSync(auth) } catch {} process.stdout.write('Successfully logged out\\n'); process.exit(0) }
if (a === 'exec --json --ephemeral --skip-git-repo-check --sandbox read-only -m gpt-5.5 -') {
  // A review (WP2 5a): reports what reached it -- the request from stdin, its
  // working folder, any Conductor variable -- as the pinned JSONL events.
  let d = ''
  process.stdin.on('data', (c) => { d += c })
  process.stdin.on('end', () => {
    const seen = { prompt: d, cwd: process.cwd(), conductorVars: Object.keys(process.env).filter((k) => /^(CCC_|CONDUCTOR_|CLAUDE_MULTI_)/i.test(k)) }
    const events = [{ type: 'thread.started', thread_id: 't' }, { type: 'turn.started' }, { type: 'item.completed', item: { id: 'i0', type: 'agent_message', text: JSON.stringify(seen) } }, { type: 'turn.completed', usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } }]
    process.stdout.write(events.map((e) => JSON.stringify(e)).join('\\n') + '\\n'); process.exit(0)
  })
  return
}
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
// On Windows the folder can stay busy after every test has passed: a killed
// process releases its working folder a moment after it is reported gone,
// and real-time scanning holds files the suite has just written for longer
// (Windows CI showed EBUSY beyond 5 s of retries). Retried for up to 30 s;
// a folder that still cannot go is left in the runner's temp with a warning
// -- cleanup of a disposable folder is not a test result.
afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 60, retryDelay: 500 })
  } catch (err) {
    process.stderr.write(`fake-cli: left ${dir} behind (${(err as NodeJS.ErrnoException).code ?? err})\n`)
  }
}, 60_000)

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
    // Settles within the runner's own bound: the deadline, then at most the
    // kill's settle window (reading the process table on Windows is a cold
    // PowerShell start, seconds on a loaded machine), not a typical speed.
    expect(Date.now() - started).toBeLessThan(3000 + CODEX_KILL_SETTLE_MS + 2000)
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    expect(pid).toBeGreaterThan(0)
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    const deadline = Date.now() + 8000
    while (alive() && Date.now() < deadline) await new Promise((res) => setTimeout(res, 100))
    expect(alive(), `the sleeping fake (pid ${pid}) outlived the tree kill`).toBe(false)
  }, 45_000)

  it('a kill whose own process-table read fails still ends the WHOLE tree, from the chain the run showed once established', async () => {
    const cmd = IS_WIN
      ? { file: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), args: ['/d', '/v:off', '/s', '/c', `""${exe}" sleep"`], verbatim: true, cwd: dir }
      : { file: exe, args: ['sleep'], verbatim: false, cwd: dir }
    const pidFile = path.join(dir, 'sleep.pid')
    try { fs.unlinkSync(pidFile) } catch { /* first run */ }
    // The real table reader, except that every read after the first fails --
    // the kill-time read, as on a machine where PowerShell is too slow.
    const real = makeCodexProcessLister(process.platform, process.env.SystemRoot)
    expect(real, 'a process table reader exists on this platform').not.toBeNull()
    let reads = 0
    const lister = async () => { if (++reads > 1) throw new Error('process table unavailable'); return real!() }
    const deps = { spawn: nodeSpawn, platform: process.platform, killTree: makeCodexKillTree(process.platform, nodeSpawn, process.env.SystemRoot, lister) }
    const r = await runCodexCli(cmd, { env: codexCliEnv(poisoned, home('sleep-noread')), timeoutMs: CODEX_TREE_PRIME_MS + 8000 }, deps)
    expect(r).toMatchObject({ timedOut: true, exitCode: null })
    // Read once while running; the kill either waited for that read (still
    // running) or tried its own, which failed, and used the earlier one.
    expect([1, 2], 'reads').toContain(reads)
    const pid = Number(fs.readFileSync(pidFile, 'utf8'))
    expect(pid).toBeGreaterThan(0)
    const alive = () => { try { process.kill(pid, 0); return true } catch { return false } }
    const deadline = Date.now() + 8000
    while (alive() && Date.now() < deadline) await new Promise((res) => setTimeout(res, 100))
    expect(alive(), `the sleeping fake (pid ${pid}) outlived a kill whose table read failed`).toBe(false)
  }, 60_000)
})

// WP2 5a: the Codex reviewer over the real runner and, on Windows, the real
// npm shim and cmd.exe -- the request reaches Codex byte for byte on stdin.
describe('the Codex reviewer against the fake Codex CLI (real processes)', () => {
  it('the request arrives intact on stdin, in the project, with no Conductor variable; relative PATH entries and a node in the project are never used', async () => {
    const project = path.join(dir, 'project')
    fs.mkdirSync(project, { recursive: true })
    const marker = path.join(dir, 'PROJECT-NODE-RAN')
    if (IS_WIN) fs.writeFileSync(path.join(project, 'node.cmd'), `@echo planted> "${marker}"\r\n`)
    const env: Record<string, string> = { ...codexCliEnv(poisoned, home('review')) }
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'PATH') delete env[k]
    // A relative entry first: without the reviewer's PATH rule, cmd.exe would
    // resolve the shim's bare `node` to the project's node.cmd through it.
    env.PATH = `.${path.delimiter}${withNode}`
    Object.assign(env, { CCC_STATUS_URL: 'http://127.0.0.1:1/s?t=x', CONDUCTOR_MCP_TOKEN: 't', CLAUDE_MULTI_SESSION_ID: 's' })
    const prompt = 'Review this.\nFocus area: race %OPENAI_API_KEY% & calc ^ "quoted" !PATH! | more'
    const r = await createCodexReviewOperations().run({ executable: exe, env, cwd: project, prompt, timeoutMs: 20_000 })
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 3 } })
    const seen = JSON.parse(r.ok ? r.text : '{}') as { prompt: string; cwd: string; conductorVars: string[] }
    expect(seen.prompt).toBe(prompt)
    expect(fs.realpathSync.native(seen.cwd)).toBe(fs.realpathSync.native(project))
    expect(seen.conductorVars).toEqual([])
    expect(fs.existsSync(marker)).toBe(false)
  }, 60_000)
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
    // The fake would sign the realm in only after the runner's whole kill
    // window: the cancel must kill it before then on any machine, however
    // slow its process table is to read.
    fs.writeFileSync(path.join(homeOf(id), 'HANG'), String(CODEX_KILL_SETTLE_MS + 5000))
    const ops = createCodexAuthOperations(deps())
    const ac = new AbortController()
    const r = await ops.login({ authRealmId: id }, 'browser', { signal: ac.signal, onOutput: (t) => { if (/sign in/.test(t)) ac.abort() } })
    const loginPid = Number(fs.readFileSync(path.join(dir, 'login.pid'), 'utf8'))
    const browserPid = Number(fs.readFileSync(path.join(dir, 'browser.pid'), 'utf8'))
    // Every assertion inside the try: a failure must not leave the "browser"
    // running in the test folder (afterAll could not remove it).
    try {
      expect(r).toMatchObject({ ok: false, code: 'cancelled', state: 'signed-out' })
      const deadline = Date.now() + 3000
      while (alive(loginPid) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50))
      expect(alive(loginPid), `the waiting fake login (pid ${loginPid}) outlived the cancel`).toBe(false)
      expect(alive(browserPid), `the "browser" (pid ${browserPid}) the sign-in opened was killed with it`).toBe(true)
      // The fake is gone, so nothing can sign the realm in later.
      expect(await ops.status({ authRealmId: id })).toEqual({ ok: true, state: 'signed-out' })
    } finally {
      try { process.kill(browserPid) } catch { /* already gone */ }
      const gone = Date.now() + 5000
      while (alive(browserPid) && Date.now() < gone) await new Promise((res) => setTimeout(res, 50))
    }
  }, 45_000)

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

// WP2 5b: the Claude reviewer over the real runner and, on Windows, a real
// npm-style claude.cmd and cmd.exe -- the request reaches Claude byte for
// byte on stdin, with the constant argv, in the project, and a node planted
// in the project never runs. Discovery proves the version through the shim.
const FAKE_CLAUDE = `
const fs = require('fs')
const a = process.argv.slice(2)
if (a.join(' ') === '--version') { process.stdout.write('2.1.278 (Claude Code)\\n'); process.exit(0) }
let d = ''
process.stdin.on('data', (c) => { d += c })
process.stdin.on('end', () => {
  const seen = { argv: a, prompt: d, cwd: process.cwd(), conductorVars: Object.keys(process.env).filter((k) => /^(CCC_|CONDUCTOR_|CLAUDE_MULTI_)/i.test(k)) }
  const r = { type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(seen), usage: { input_tokens: 4, cache_creation_input_tokens: 1, cache_read_input_tokens: 2, output_tokens: 3 } }
  process.stdout.write(JSON.stringify(r) + '\\n'); process.exit(0)
})
`

describe('the Claude reviewer against a fake Claude CLI (real processes)', () => {
  let claude: string
  beforeAll(() => {
    fs.writeFileSync(path.join(dir, 'fake-claude.js'), FAKE_CLAUDE)
    if (IS_WIN) {
      claude = path.join(dir, 'claude.cmd')
      fs.writeFileSync(claude, [
        '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0',
        'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"', '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')',
        'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\fake-claude.js" %*', '',
      ].join('\r\n'))
    } else {
      claude = path.join(dir, 'claude')
      fs.writeFileSync(claude, `#!${process.execPath}\nrequire(${JSON.stringify(path.join(dir, 'fake-claude.js'))})\n`, { mode: 0o755 })
    }
  })
  const ports = () => ({
    commandLine: (e: string, a: readonly string[], p: NodeJS.Platform, s: { ComSpec?: string; SystemRoot?: string }) => cliCommandLine(e, a, p, s, 'Claude Code'),
    shellEnv: codexShellEnv,
    run: (cmd: Parameters<typeof runCodexCli>[0], opts: Parameters<typeof runCodexCli>[1]) => runCodexCli(cmd, opts),
  })

  it('discovery proves the version through the real shim; a launch runs exactly that file', async () => {
    const parts = createClaudeReviewLaunch({
      ...ports(),
      lookupRealm: async () => ({ ok: true, realm: { id: 'r', providerId: 'claude', ownerProviderAccountId: 'a', kind: 'claude-config-home', ownership: 'conductor-managed', pathRef: 'claude-profile:profile-x1', lifecycle: 'active', createdAt: 1 } }),
      profileRealmLaunch: () => ({ home: dir, baseEnv: {}, realmEnv: { set: {} }, sessionsDir: dir }),
      holdProfile: async () => () => {},
      recordPreflight: () => {},
      resolveExecutable: async () => claude,
    })
    const d = await parts.setup.discover()
    expect(d, JSON.stringify(d)).toMatchObject({ state: 'found', version: '2.1.278', compatibility: 'supported' })
    expect(await parts.launch.prepare({ authRealmId: 'r' })).toMatchObject({ ok: true, executable: fs.realpathSync.native(claude) })
  }, 60_000)

  it('the request arrives intact on stdin with the constant argv, in the project, with no Conductor variable; a node in the project never runs', async () => {
    const project = path.join(dir, 'claude-project')
    fs.mkdirSync(project, { recursive: true })
    const marker = path.join(dir, 'CLAUDE-PROJECT-NODE-RAN')
    if (IS_WIN) fs.writeFileSync(path.join(project, 'node.cmd'), `@echo planted> "${marker}"\r\n`)
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string' && k.toUpperCase() !== 'PATH') env[k] = v
    env.PATH = `.${path.delimiter}${withNode}`
    Object.assign(env, { CCC_STATUS_URL: 'http://127.0.0.1:1/s?t=x', CONDUCTOR_MCP_TOKEN: 't', CLAUDE_MULTI_SESSION_ID: 's' })
    const prompt = 'Review this.\n<<<CHANGE-00ff\n+ x = "%PATH%" & calc ^ !PATH! | more\nCHANGE-00ff>>>\n'
    const held: string[] = []
    const reviewer = createClaudeReviewOperations({
      ...ports(),
      profileOf: async () => 'profile-x1',
      holdProfile: async (id) => { held.push(id); return () => { held.push('released') } },
      recordPreflight: () => {},
    })
    const r = await reviewer.run({ executable: claude, env, cwd: project, prompt, timeoutMs: 20_000, realm: { authRealmId: 'r' } })
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true, usage: { inputTokens: 7, cachedInputTokens: 2, outputTokens: 3 } })
    const seen = JSON.parse(r.ok ? r.text : '{}') as { argv: string[]; prompt: string; cwd: string; conductorVars: string[] }
    expect(seen.argv).toEqual([...CLAUDE_REVIEW_ARGS])
    expect(seen.prompt).toBe(prompt)
    expect(fs.realpathSync.native(seen.cwd)).toBe(fs.realpathSync.native(project))
    expect(seen.conductorVars).toEqual([])
    expect(fs.existsSync(marker)).toBe(false)
    expect(held).toEqual(['profile-x1', 'released'])
  }, 60_000)
})

// WP2 5b (owner decision 2): the diff main sends a Claude reviewer, from real
// git on repositories whose own configuration would run a command five ways
// -- an fsmonitor hook, a clean filter, a textconv, an external diff (from the
// config and from GIT_EXTERNAL_DIFF) and a pager -- or point the work tree
// outside the project, one of them reached through a planted `.git` file. A
// plain `git diff` on the same repository is proved to act on them (verify
// the verifier).
describe('the review diff against a booby-trapped repository (real git)', () => {
  const git = findGit(process.env.PATH ?? process.env.Path, process.platform, (p) => fs.statSync(p).isFile())
  const node = process.execPath.replace(/\\/g, '/')
  let markDir = ''
  let mark = ''
  let outside = ''
  const run = (cwd: string, args: string[], env: Record<string, string | undefined> = process.env) => new Promise<string>((resolve) => {
    let out = ''
    const c = nodeSpawn(git!, args, { cwd, env: env as NodeJS.ProcessEnv, windowsHide: true })
    c.stdout?.on('data', (d) => { out += d })
    c.on('close', () => resolve(out))
  })
  const commit = (cwd: string, msg: string) => run(cwd, ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', msg])
  /** Every command a repository's configuration can make git run while it
   *  compares the work tree, each writing a marker when it runs. */
  const traps = (m: string) => [
    ['core.fsmonitor', `"${node}" "${m}" fsmonitor`],
    ['filter.evil.clean', `"${node}" "${m}" clean`],
    ['filter.evil.smudge', `"${node}" "${m}" smudge`],
    ['diff.evil.textconv', `"${node}" "${m}" textconv`],
    ['diff.evil.command', `"${node}" "${m}" extdiff`],
    ['core.pager', `"${node}" "${m}" pager`],
  ]
  const touch = (f: string) => fs.utimesSync(f, new Date(), new Date(Date.now() + 5000))

  beforeAll(() => {
    markDir = path.join(dir, 'marks')
    fs.mkdirSync(markDir, { recursive: true })
    mark = path.join(dir, 'mark.js').replace(/\\/g, '/')
    fs.writeFileSync(mark, `require('fs').writeFileSync(require('path').join(${JSON.stringify(markDir)}, 'RAN-' + process.argv[2]), 'x'); if (process.argv[2] === 'textconv') process.stdout.write(require('fs').readFileSync(process.argv[3], 'utf8')); else if (process.argv[2] === 'clean') process.stdin.pipe(process.stdout)\n`)
    // A folder outside every project: what a repository's core.worktree
    // would point the diff at.
    outside = path.join(dir, 'outside')
    fs.mkdirSync(outside, { recursive: true })
    fs.writeFileSync(path.join(outside, 'a.txt'), 'OUTSIDE-SECRET\n')
  })

  it('mode working: produces the change and runs none of the repository\'s commands, nor reads outside the project', async () => {
    expect(git, 'git must be on PATH for this real-process case').toBeTruthy()
    const repo = path.join(dir, 'trap-repo')
    fs.mkdirSync(repo, { recursive: true })
    await run(repo, ['init', '-q'])
    await commit(repo, 'root')
    fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt filter=evil diff=evil\n')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
    await run(repo, ['add', '.gitattributes', 'a.txt'])
    await commit(repo, 'a')
    for (const [k, v] of traps(mark)) await run(repo, ['config', k, v])
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n')
    touch(path.join(repo, 'a.txt'))
    const trapEnv = { ...process.env, GIT_EXTERNAL_DIFF: `"${node}" "${mark}" envdiff`, GIT_PAGER: `"${node}" "${mark}" envpager` }

    const r = await produceReviewDiff({ cwd: repo, mode: 'working' }, { ...defaultReviewDiffDeps(), env: trapEnv })
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true })
    expect(r.ok && r.diff).toContain('+two')
    expect(fs.readdirSync(markDir)).toEqual([])

    // core.worktree pointing outside the project: the diff still reads the project.
    await run(repo, ['config', 'core.worktree', outside.replace(/\\/g, '/')])
    const pinned = await produceReviewDiff({ cwd: repo, mode: 'working' }, { ...defaultReviewDiffDeps(), env: trapEnv })
    expect(pinned, JSON.stringify(pinned)).toMatchObject({ ok: true })
    expect(pinned.ok && pinned.diff).toContain('+two')
    expect(pinned.ok && pinned.diff).not.toContain('OUTSIDE-SECRET')
    expect(fs.readdirSync(markDir)).toEqual([])

    // The verifier: plain git on the same repository runs the traps and
    // reads the outside folder.
    await run(repo, ['diff', 'HEAD'], trapEnv)
    expect(fs.readdirSync(markDir).length).toBeGreaterThan(0)
    expect(await run(repo, ['--no-pager', 'diff', '--no-ext-diff', '--no-textconv', 'HEAD'])).toContain('OUTSIDE-SECRET')
    for (const f of fs.readdirSync(markDir)) fs.unlinkSync(path.join(markDir, f))
  }, 90_000)

  it('a `.git` file an agent planted, naming a git dir of its own that configures every trap, runs nothing and reads nothing outside', async () => {
    const project = path.join(dir, 'planted')
    fs.mkdirSync(project, { recursive: true })
    // The agent's own git dir, inside the project it can write, and the
    // pointer to it: git init --separate-git-dir writes exactly that.
    await run(project, ['init', '-q', `--separate-git-dir=${path.join(project, 'fake').replace(/\\/g, '/')}`, '.'])
    expect(fs.statSync(path.join(project, '.git')).isFile()).toBe(true)
    fs.writeFileSync(path.join(project, '.gitattributes'), '*.txt filter=evil diff=evil\n')
    fs.writeFileSync(path.join(project, 'a.txt'), 'one\n')
    await run(project, ['add', '.gitattributes', 'a.txt'])
    await commit(project, 'a')
    fs.writeFileSync(path.join(project, 'a.txt'), 'one\ntwo\n')
    await run(project, ['add', 'a.txt'])
    await commit(project, 'b')
    // Traps last: the setup's own plain git must not trip them.
    for (const [k, v] of [...traps(mark), ['core.worktree', outside.replace(/\\/g, '/')]]) await run(project, ['config', k, v])
    fs.writeFileSync(path.join(project, 'a.txt'), 'one\ntwo\nthree\n')
    touch(path.join(project, 'a.txt'))

    const r = await produceReviewDiff({ cwd: project, mode: 'working' }, defaultReviewDiffDeps())
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true })
    expect(r.ok && r.diff).toContain('+three')
    expect(r.ok && r.diff).not.toContain('OUTSIDE-SECRET')
    expect(fs.readdirSync(markDir)).toEqual([])
    // Mode range on the same repository: tree against tree, nothing runs.
    const range = await produceReviewDiff({ cwd: project, mode: 'range', range: 'HEAD~1..HEAD' }, defaultReviewDiffDeps())
    expect(range, JSON.stringify(range)).toMatchObject({ ok: true })
    expect(range.ok && range.diff).toContain('+two')
    expect(fs.readdirSync(markDir)).toEqual([])
  }, 90_000)
  it('reads as the user\'s own `git diff`: an executable bit core.filemode says to ignore is no change; a linked worktree diffs its own change', async () => {
    const repo = path.join(dir, 'modes')
    fs.mkdirSync(repo, { recursive: true })
    await run(repo, ['init', '-q'])
    await run(repo, ['config', 'core.filemode', 'false'])
    fs.writeFileSync(path.join(repo, 'run.sh'), 'echo hi\n')
    await run(repo, ['add', 'run.sh'])
    await run(repo, ['update-index', '--chmod=+x', 'run.sh'])
    await commit(repo, 'x')
    // The verifier: the user's own git sees nothing to review.
    expect(await run(repo, ['--no-pager', 'diff', 'HEAD'])).toBe('')
    const same = await produceReviewDiff({ cwd: repo, mode: 'working' }, defaultReviewDiffDeps())
    expect(same).toEqual({ ok: true, diff: '' })

    const linked = path.join(dir, 'modes-linked')
    await run(repo, ['worktree', 'add', '-q', '-b', 'side', linked.replace(/\\/g, '/')])
    expect(fs.statSync(path.join(linked, '.git')).isFile()).toBe(true)
    fs.writeFileSync(path.join(linked, 'run.sh'), 'echo hi\necho linked\n')
    touch(path.join(linked, 'run.sh'))
    const r = await produceReviewDiff({ cwd: linked, mode: 'working' }, defaultReviewDiffDeps())
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true })
    expect(r.ok && r.diff).toContain('+echo linked')
    expect(r.ok && r.diff).not.toContain('old mode')
  }, 90_000)
  it('a filter the repository gains between the check and the diff (the race an agent can run) still runs nothing', async () => {
    const repo = path.join(dir, 'race')
    fs.mkdirSync(repo, { recursive: true })
    await run(repo, ['init', '-q'])
    fs.writeFileSync(path.join(repo, '.gitattributes'), '*.txt filter=late\n')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n')
    await run(repo, ['add', '.gitattributes', 'a.txt'])
    await commit(repo, 'a')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nfour\n')
    touch(path.join(repo, 'a.txt'))
    const real = defaultReviewDiffDeps()
    let armed = false
    // The race, made deterministic: right after the filter drivers are read,
    // before the diff, the repository gains a clean filter of its own.
    const deps = {
      ...real,
      run: async (g: string, args: readonly string[], o: Parameters<typeof real.run>[2]) => {
        const r = await real.run(g, args, o)
        if (!armed && args.includes('config') && args.includes('^filter\\.')) {
          armed = true
          await run(repo, ['config', 'filter.late.clean', `"${node}" "${mark}" late`])
        }
        return r
      },
    }
    const r = await produceReviewDiff({ cwd: repo, mode: 'working' }, deps)
    expect(armed).toBe(true)
    expect(r, JSON.stringify(r)).toMatchObject({ ok: true })
    expect(r.ok && r.diff).toContain('+four')
    expect(fs.readdirSync(markDir)).toEqual([])
    // The verifier: the filter is live for plain git.
    await run(repo, ['diff', 'HEAD'])
    expect(fs.readdirSync(markDir)).toContain('RAN-late')
    for (const f of fs.readdirSync(markDir)) fs.unlinkSync(path.join(markDir, f))
  }, 90_000)
})
