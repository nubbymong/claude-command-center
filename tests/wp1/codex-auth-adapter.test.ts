// WP1.62 -- WP2 slice 3a (plan A7; design 9.2): `codex login status`
// is classified from its exit code and output alone; auth.json is never
// read, a printed key is never retained, and anything unexpected is an
// error, never "signed out". PURE.
//
// WP1.20, WP1.22, WP1.49, WP1.62 -- WP2 slice 3c (plan A6, A7; design 5.4,
// 9.2, 11, 12): the Codex sign-in, status and logout operations, through
// injected ports (no process is started, no file is read). The real-process
// counterpart is tests/wp1/fake-cli.test.ts (CI/VM).
import { describe, it, expect } from 'vitest'
import { parseCodexLoginStatus, createCodexAuthOperations, createCodexOutputRedactor, createCodexPackage } from '../../src/main/providers/codex'
import type { CodexAuthDeps, CodexDiscovery, CodexDiscoveryDeps, CodexCommand, CodexRunOptions, CodexRunResult } from '../../src/main/providers/codex'

describe('codex login status', () => {
  it('classifies the pinned CLI outputs, on either stream', () => {
    expect(parseCodexLoginStatus(0, '', 'Logged in using ChatGPT\n')).toEqual({ state: 'signed-in', via: 'chatgpt' })
    expect(parseCodexLoginStatus(0, 'Logged in using ChatGPT\n', '')).toEqual({ state: 'signed-in', via: 'chatgpt' })
    expect(parseCodexLoginStatus(0, '', 'Logged in using an API key - sk-proj-***ABCD\n')).toEqual({ state: 'signed-in', via: 'api-key' })
    expect(parseCodexLoginStatus(0, 'Logged in using something new\n', '')).toEqual({ state: 'signed-in', via: 'unknown' })
    expect(parseCodexLoginStatus(1, '', 'Not logged in\n')).toEqual({ state: 'signed-out' })
  })

  it('never returns any part of the printed output', () => {
    const r = parseCodexLoginStatus(0, '', 'Logged in using an API key - sk-proj-SECRETSECRET\n')
    expect(JSON.stringify(r)).not.toMatch(/sk-|SECRET/)
  })

  it('strips terminal escapes and CRLF before matching', () => {
    expect(parseCodexLoginStatus(0, '\u001b[1mLogged in using ChatGPT\u001b[0m\r\n', '')).toEqual({ state: 'signed-in', via: 'chatgpt' })
  })

  it('an unexpected exit code or output is an error, never "signed out"', () => {
    expect(parseCodexLoginStatus(1, '', 'Error: failed to load config\n')).toEqual({ state: 'error' })
    expect(parseCodexLoginStatus(2, '', 'Not logged in\n')).toEqual({ state: 'error' })
    expect(parseCodexLoginStatus(null, '', '')).toEqual({ state: 'error' })
    expect(parseCodexLoginStatus(0, '', '')).toEqual({ state: 'error' })
    expect(parseCodexLoginStatus(0, 'Not logged in', '')).toEqual({ state: 'error' })
    // A line that merely mentions the phrase is not the status line.
    expect(parseCodexLoginStatus(0, 'warning: Logged in using ChatGPT is deprecated', '')).toEqual({ state: 'error' })
  })

  it('two status lines that could disagree are an error, whatever the exit code; a warning beside one is fine', () => {
    expect(parseCodexLoginStatus(0, 'Not logged in\nLogged in using ChatGPT', '')).toEqual({ state: 'error' })
    expect(parseCodexLoginStatus(1, 'Logged in using ChatGPT', 'Not logged in')).toEqual({ state: 'error' })
    expect(parseCodexLoginStatus(0, 'Logged in using an API key - x\nLogged in using ChatGPT', '')).toEqual({ state: 'error' })
    expect(parseCodexLoginStatus(0, '', 'WARNING: proceeding without the sandbox\nLogged in using ChatGPT')).toEqual({ state: 'signed-in', via: 'chatgpt' })
  })

  it('a Unicode lookalike, a NUL or a stray control sequence is not a status line', () => {
    expect(parseCodexLoginStatus(0, 'Lоgged in using ChatGPT', '')).toEqual({ state: 'error' })
    expect(parseCodexLoginStatus(0, '\u0000Logged in using ChatGPT', '')).toEqual({ state: 'error' })
  })
})

// ---------------------------------------------------------------------------
// WP1.20, WP1.22, WP1.49, WP1.62 -- slice 3c: sign-in, status and logout.
// ---------------------------------------------------------------------------

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const KEY = 'sk-proj-' + 'K'.repeat(40) + '1234'
const IDENT = { path: 'C:\\Tools\\codex.exe', size: 100, mtimeMs: 5, ctimeMs: 6, dev: '1', ino: '2' }
const PROVEN: CodexDiscovery = { state: 'found', executable: IDENT.path, identity: IDENT, version: '0.155.1', compatibility: 'supported', checkedAt: 1 }
const ID_A = 'realm-' + 'a'.repeat(16)
const ID_B = 'realm-' + 'b'.repeat(16)
const ID_X = 'realm-' + 'e'.repeat(16)
const MANAGED = { authRealmId: ID_A }
const MANAGED_B = { authRealmId: ID_B }
const EXTERNAL = { authRealmId: ID_X }
const ROOTS = { resourcesDir: 'C:\\res', externalDefaultHome: 'C:\\Users\\u\\.codex' }
const HOME_A = `C:\\res\\codex-realms\\${ID_A}`
const HOME_B = `C:\\res\\codex-realms\\${ID_B}`
const HOME_X = 'C:\\Users\\u\\.codex'
const managed = (id: string) => ({ id, providerId: 'codex' as const, kind: 'codex-home' as const, ownership: 'conductor-managed' as const, pathRef: `managed:${id}` })
const external = (id: string) => ({ id, providerId: 'codex' as const, kind: 'codex-home' as const, ownership: 'external-default' as const, pathRef: 'external-default' })

type Via = 'chatgpt' | 'api-key'
interface Run { args: string[]; file: string; cwd: string; env: Record<string, string>; opts: CodexRunOptions }
type Script = Partial<Record<string, (r: Run) => Partial<CodexRunResult> | Promise<Partial<CodexRunResult>>>>

/** A fake Codex world: one sign-in per CODEX_HOME, driven by the argv. */
function world(over: Partial<CodexAuthDeps> = {}, script: Script = {}) {
  const signedIn = new Map<string, Via>()
  const runs: Run[] = []
  const secrets = new Map<string, string>([['h1', `${KEY}\n`], ['h2', 'sk-other-key-value-0000']])
  const taken: string[] = []
  const status = (home: string): Partial<CodexRunResult> => {
    const v = signedIn.get(home)
    if (v === 'chatgpt') return { exitCode: 0, stderr: 'Logged in using ChatGPT\n' }
    if (v === 'api-key') return { exitCode: 0, stderr: 'Logged in using an API key - sk-proj-***1234\n' }
    return { exitCode: 1, stderr: 'Not logged in\n' }
  }
  const behaviour: Script = {
    'login status': (r) => status(r.env.CODEX_HOME),
    'logout': (r) => { signedIn.delete(r.env.CODEX_HOME); return { exitCode: 0, stdout: 'Successfully logged out\n' } },
    'login': (r) => {
      r.opts.onOutput?.(`${ESC}[1mStarting local login server on http://localhost:1455.${ESC}[0m\nIf your browser did not open, navigate to this URL:\n\nhttps://auth.example/oauth/authorize?state=abc`, 'stderr')
      r.opts.onOutput?.(`\n${ESC}]52;c;ZXZpbA==${BEL}leaked ${KEY.slice(0, 20)}`, 'stderr')
      r.opts.onOutput?.(`${KEY.slice(20)} done\n`, 'stderr')
      signedIn.set(r.env.CODEX_HOME, 'chatgpt')
      return { exitCode: 0, stdout: 'Successfully logged in\n' }
    },
    'login --device-auth': (r) => {
      r.opts.onOutput?.('1. Open https://auth.example/codex/device\n2. Enter this one-time code\n   ABCD-EFGH\n', 'stdout')
      signedIn.set(r.env.CODEX_HOME, 'chatgpt')
      return { exitCode: 0 }
    },
    'login --with-api-key': (r) => {
      if (typeof r.opts.stdin !== 'string' || !r.opts.stdin.trim()) return { exitCode: 3 }
      r.opts.onOutput?.(`read key ${r.opts.stdin.trim()}\n`, 'stdout')
      signedIn.set(r.env.CODEX_HOME, 'api-key')
      return { exitCode: 0, stdout: 'Successfully logged in\n' }
    },
    ...script,
  }
  const deps: CodexAuthDeps = {
    lookupRealm: async (r) => {
      if (r.authRealmId === ID_A) return { ok: true, realm: managed(ID_A), roots: ROOTS }
      if (r.authRealmId === ID_B) return { ok: true, realm: managed(ID_B), roots: ROOTS }
      if (r.authRealmId === ID_X) return { ok: true, realm: external(ID_X), roots: ROOTS }
      return { ok: false }
    },
    realmIdentity: (home) => ({ canonical: home, dev: '9', ino: home === HOME_A ? '11' : home === HOME_B ? '12' : '13', isDirectory: true }),
    proven: () => PROVEN,
    executablePorts: { resolve: () => IDENT.path, realpath: (p) => p, stat: () => ({ ...IDENT, isFile: true }), platform: 'win32' },
    baseEnv: async () => ({ PATH: 'C:\\Tools', SYSTEMROOT: 'C:\\Windows', OPENAI_API_KEY: 'sk-ambient', CODEX_HOME: 'C:\\elsewhere' }),
    run: async (cmd: CodexCommand, opts: CodexRunOptions) => {
      const r: Run = { args: cmd.args, file: cmd.file, cwd: cmd.cwd, env: { ...opts.env }, opts }
      runs.push(r)
      const f = behaviour[cmd.args.join(' ')]
      const out = f ? await f(r) : { exitCode: 64 }
      return { exitCode: null, stdout: '', stderr: '', timedOut: false, truncated: false, ...out }
    },
    envFilePresent: () => false,
    takeSecret: (h) => { taken.push(h); const v = secrets.get(h) ?? null; secrets.delete(h); return v },
    ...over,
  }
  return { ops: createCodexAuthOperations(deps), deps, runs, taken, signedIn, secrets }
}

const argsOf = (runs: Run[]) => runs.map((r) => r.args.join(' '))
const SIGNED_IN_ACCOUNT = { ok: true, state: 'signed-in', credential: 'account' }

describe('Codex status (A7, D3)', () => {
  it('runs `login status` in the realm home the package derives, under the allowlisted environment, from the proven executable', async () => {
    const w = world()
    expect(await w.ops.status(MANAGED)).toEqual({ ok: true, state: 'signed-out' })
    const r = w.runs[0]
    expect(r).toMatchObject({ file: IDENT.path, cwd: 'C:\\Tools', args: ['login', 'status'] })
    expect(r.env).toMatchObject({ CODEX_HOME: HOME_A, NoDefaultCurrentDirectoryInExePath: '1', PATH: 'C:\\Tools' })
    expect(r.env.OPENAI_API_KEY).toBeUndefined()
    w.signedIn.set(HOME_A, 'api-key')
    const signed = await w.ops.status(MANAGED)
    expect(signed).toEqual({ ok: true, state: 'signed-in', credential: 'api-key' })
    expect(JSON.stringify(signed)).not.toMatch(/sk-|1234/)
  })

  it('an unknown realm, no proven CLI, an unusable version or a replaced executable is an error with a code, and runs nothing', async () => {
    expect(await world().ops.status({ authRealmId: 'nope' })).toMatchObject({ ok: false, state: 'error', code: 'realm-unavailable' })
    const cases: Array<[Partial<CodexAuthDeps>, string]> = [
      [{ proven: () => null }, 'cli-unavailable'],
      [{ proven: () => ({ ...PROVEN, state: 'invalid' }) }, 'cli-unavailable'],
      [{ proven: () => ({ ...PROVEN, compatibility: 'too-old' }) }, 'cli-unavailable'],
      [{ proven: () => ({ ...PROVEN, compatibility: 'unknown' }) }, 'cli-unavailable'],
      [{ proven: () => ({ ...PROVEN, identity: undefined }) }, 'cli-unavailable'],
      [{ proven: () => { throw new Error('x') } }, 'cli-unavailable'],
      [{ executablePorts: { resolve: () => 'C:\\evil\\codex.exe', realpath: (p) => p, stat: () => ({ ...IDENT, isFile: true }), platform: 'win32' } }, 'cli-unavailable'],
      [{ executablePorts: { resolve: () => IDENT.path, realpath: (p) => p, stat: () => ({ ...IDENT, ino: '9', isFile: true }), platform: 'win32' } }, 'cli-unavailable'],
      [{ executablePorts: { resolve: () => IDENT.path, realpath: () => 42 as never, stat: () => null as never, platform: 'win32' } }, 'cli-unavailable'],
      [{ lookupRealm: async () => { throw new Error('registry gone') } }, 'realm-unavailable'],
      [{ baseEnv: async () => { throw new Error('shell') } }, 'not-started'],
    ]
    for (const [over, code] of cases) {
      const w = world(over)
      expect(await w.ops.status(MANAGED), code).toMatchObject({ ok: false, state: 'error', code })
      expect(w.runs, code).toEqual([])
    }
  })

  it('the realm is the record the lookup returns, turned into a home by the package: a wrong record, an odd ownership or a bad reference is refused', async () => {
    const odd: Array<Partial<CodexAuthDeps>> = [
      { lookupRealm: async () => ({ ok: true, realm: managed(ID_B), roots: ROOTS }) },
      { lookupRealm: async () => ({ ok: true, realm: { ...managed(ID_A), ownership: 'imported' as never }, roots: ROOTS }) },
      { lookupRealm: async () => ({ ok: true, realm: { ...managed(ID_A), pathRef: 'managed:realm-' + 'c'.repeat(16) }, roots: ROOTS }) },
      { lookupRealm: async () => ({ ok: true, realm: managed(ID_A), roots: { resourcesDir: 'res', externalDefaultHome: null } }) },
      { lookupRealm: async () => ({ ok: true, realm: managed(ID_A) }) as never },
      { lookupRealm: async () => 42 as never },
    ]
    for (const [i, over] of odd.entries()) {
      const w = world(over)
      expect(await w.ops.status(MANAGED), String(i)).toMatchObject({ ok: false, code: 'realm-unavailable' })
      expect(await w.ops.logout(MANAGED, { acknowledgeExternalRealm: true }), String(i)).toMatchObject({ ok: false, code: 'realm-unavailable' })
      expect(w.runs, String(i)).toEqual([])
    }
    for (const ref of [null, undefined, {}, { authRealmId: 42 }, 'realm-x'] as never[]) {
      expect(await world().ops.status(ref), String(ref)).toMatchObject({ ok: false, code: 'realm-unavailable' })
    }
  })

  it('a lookup failure never carries its own text into the result', async () => {
    const w = world({ lookupRealm: async () => ({ ok: false, message: 'C:\\Users\\u\\secret token=abcdefghijkl' }) as never })
    const r = await w.ops.status(MANAGED)
    expect(JSON.stringify(r)).not.toMatch(/secret|token|Users/)
  })

  it('the realm folder must exist at its canonical path, as a folder', async () => {
    for (const over of [
      { realmIdentity: () => { throw new Error('ENOENT') } },
      { realmIdentity: (h: string) => ({ canonical: `${h}-other`, dev: '9', ino: '11', isDirectory: true }) },
      { realmIdentity: (h: string) => ({ canonical: h, dev: '9', ino: '11', isDirectory: false }) },
      { realmIdentity: () => null as never },
    ]) {
      const w = world(over)
      expect(await w.ops.status(MANAGED)).toMatchObject({ ok: false, code: 'realm-unavailable' })
      expect(w.runs).toEqual([])
    }
    // Case alone is not a different folder on Windows.
    expect(await world({ realmIdentity: (h) => ({ canonical: h.toUpperCase(), dev: '9', ino: '11', isDirectory: true }) }).ops.status(MANAGED)).toMatchObject({ ok: true })
  })

  it('a too-new CLI is allowed (warned elsewhere, never blocked)', async () => {
    expect(await world({ proven: () => ({ ...PROVEN, compatibility: 'too-new' }) }).ops.status(MANAGED)).toMatchObject({ ok: true })
  })

  it('an unstartable, timed-out or unrecognised status run is an error, never "signed out"', async () => {
    const cases: Array<[Partial<CodexRunResult>, string]> = [[{ spawnError: 'EACCES' }, 'not-started'], [{ timedOut: true }, 'timed-out'], [{ exitCode: 2, stderr: 'Not logged in' }, 'status-unrecognised'], [{ exitCode: 0, stdout: 'hello' }, 'status-unrecognised']]
    for (const [out, code] of cases) {
      expect(await world({}, { 'login status': () => out }).ops.status(MANAGED), code).toMatchObject({ ok: false, state: 'error', code })
    }
  })

  it('a managed realm holding a .env is refused for status and sign-in (it can carry a key past the allowlist), not for logout', async () => {
    const w = world({ envFilePresent: (home) => home === HOME_A })
    expect(await w.ops.status(MANAGED)).toMatchObject({ ok: false, state: 'error', code: 'realm-env-file', message: expect.stringMatching(/\.env/) })
    expect(await w.ops.login(MANAGED, 'browser')).toMatchObject({ ok: false, code: 'realm-env-file' })
    expect(w.runs).toEqual([])
    expect(await w.ops.logout(MANAGED)).toMatchObject({ ok: true })
    // The external default home is the user's own; its .env is theirs.
    expect(await world({ envFilePresent: () => true }).ops.status(EXTERNAL)).toMatchObject({ ok: true })
  })

  it('a .env check that cannot answer, or answers anything but false, counts as present', async () => {
    for (const envFilePresent of [() => { throw new Error('EACCES') }, () => undefined as never, () => 'no' as never, () => 0 as never]) {
      const w = world({ envFilePresent })
      expect(await w.ops.status(MANAGED)).toMatchObject({ ok: false, code: 'realm-env-file' })
      expect(w.runs).toEqual([])
    }
  })

  it('a throwing getter anywhere in the input or the record resolves to a refusal and holds nothing afterwards', async () => {
    const boom = () => { throw new Error('getter') }
    const w = world()
    const badHandle = { get secretHandle() { return boom() } } as never
    await expect(w.ops.login(MANAGED, 'apiKey', badHandle)).resolves.toMatchObject({ ok: false })
    const badSignal = { get signal() { return boom() } } as never
    await expect(w.ops.login(MANAGED, 'browser', badSignal)).resolves.toMatchObject({ ok: false })
    // Neither the realm nor the browser flow is left held.
    expect(await w.ops.login(MANAGED, 'browser')).toEqual(SIGNED_IN_ACCOUNT)
    const badRef = { get authRealmId() { return boom() } } as never
    await expect(w.ops.status(badRef)).resolves.toMatchObject({ ok: false, code: 'realm-unavailable' })
    const r = world({ lookupRealm: async () => ({ ok: true, realm: managed(ID_A), get roots() { return boom() } }) as never })
    await expect(r.ops.status(MANAGED)).resolves.toMatchObject({ ok: false, code: 'realm-unavailable' })
    const q = world({ lookupRealm: async () => ({ ok: true, get realm() { return boom() }, roots: ROOTS }) as never })
    await expect(q.ops.logout(MANAGED)).resolves.toMatchObject({ ok: false, code: 'realm-unavailable' })
  })

  it('a run port that answers nothing usable fails closed; nothing rejects', async () => {
    for (const run of [async () => undefined as never, async () => 'x' as never, async () => { throw new Error('boom') }]) {
      const w = world({ run })
      await expect(w.ops.status(MANAGED)).resolves.toMatchObject({ ok: false, code: 'not-started' })
      await expect(w.ops.login(MANAGED, 'device')).resolves.toMatchObject({ ok: false, code: 'not-started' })
      await expect(w.ops.logout(MANAGED)).resolves.toMatchObject({ ok: false, code: 'not-started' })
    }
  })
})

describe('Codex browser and device sign-in (WP1.20)', () => {
  it('browser: checks the realm is signed out, runs `login` there, streams redacted display-only output, and verifies with status', async () => {
    const w = world()
    const shown: string[] = []
    expect(await w.ops.login(MANAGED, 'browser', { onOutput: (t) => shown.push(t) })).toEqual(SIGNED_IN_ACCOUNT)
    expect(argsOf(w.runs)).toEqual(['login status', 'login', 'login status'])
    expect(new Set(w.runs.map((x) => x.env.CODEX_HOME))).toEqual(new Set([HOME_A]))
    expect(w.runs[1].opts.stdin).toBeUndefined()
    const text = shown.join('')
    // Whole lines only, escapes and control sequences gone, the key redacted
    // even though it arrived split across two chunks.
    expect(text).toContain('Starting local login server on http://localhost:1455.\n')
    expect(text).toContain('https://auth.example/oauth/authorize?state=abc\n')
    expect(text).not.toContain(ESC)
    expect(text).not.toContain(BEL)
    expect(text).not.toContain(KEY.slice(0, 20))
    expect(text).not.toContain(KEY.slice(20))
    expect(shown.every((l) => l.endsWith('\n'))).toBe(true)
  })

  it('device: runs `login --device-auth`, and the one-time code reaches the display', async () => {
    const w = world()
    const shown: string[] = []
    expect(await w.ops.login(MANAGED, 'device', { onOutput: (t) => shown.push(t) })).toEqual(SIGNED_IN_ACCOUNT)
    expect(argsOf(w.runs)).toEqual(['login status', 'login --device-auth', 'login status'])
    expect(shown.join('')).toContain('ABCD-EFGH')
  })

  it('refuses to sign in over an existing sign-in (the CLI clears it first), after an unreadable status, into an external realm, or by an unsupported method', async () => {
    const w = world()
    w.signedIn.set(HOME_A, 'chatgpt')
    expect(await w.ops.login(MANAGED, 'browser')).toMatchObject({ ok: false, code: 'already-signed-in', state: 'signed-in' })
    expect(argsOf(w.runs)).toEqual(['login status'])
    const e = world({}, { 'login status': () => ({ exitCode: 0, stdout: 'garbage' }) })
    expect(await e.ops.login(MANAGED, 'device')).toMatchObject({ ok: false, code: 'status-unrecognised' })
    expect(argsOf(e.runs)).toEqual(['login status'])
    const x = world()
    expect(await x.ops.login(EXTERNAL, 'browser')).toMatchObject({ ok: false, code: 'external-realm' })
    for (const m of ['external', 'unknown', 'Browser', '__proto__', 'toString'] as never[]) expect(await x.ops.login(MANAGED, m), String(m)).toMatchObject({ ok: false, code: 'method-unsupported' })
    expect(x.runs).toEqual([])
  })

  it('cancel, a deadline, a failed start or a non-zero exit fails with its own code; the realm is read again and reported', async () => {
    const cases: Array<[Partial<CodexRunResult>, string]> = [[{ spawnError: 'cancelled' }, 'cancelled'], [{ timedOut: true }, 'timed-out'], [{ spawnError: 'ENOENT' }, 'not-started'], [{ exitCode: 1 }, 'provider-refused']]
    for (const [out, code] of cases) {
      const w = world({}, { 'login': () => out })
      expect(await w.ops.login(MANAGED, 'browser'), code).toMatchObject({ ok: false, code, state: 'signed-out' })
      expect(argsOf(w.runs), code).toEqual(['login status', 'login', 'login status'])
    }
    const liar = world({}, { 'login': () => ({ exitCode: 0 }) })
    expect(await liar.ops.login(MANAGED, 'browser')).toMatchObject({ ok: false, code: 'not-confirmed', state: 'signed-out' })
    // Signed in, but with an API key: not what a browser sign-in produces.
    const wrong = world({}, { 'login': (r) => { wrong.signedIn.set(r.env.CODEX_HOME, 'api-key'); return { exitCode: 0 } } })
    expect(await wrong.ops.login(MANAGED, 'browser')).toMatchObject({ ok: false, code: 'not-confirmed' })
  })

  it('a sign-in stopped just as the user finished it says the realm is signed in regardless', async () => {
    const w = world({}, { 'login': (r) => { w.signedIn.set(r.env.CODEX_HOME, 'chatgpt'); return { spawnError: 'cancelled' } } })
    expect(await w.ops.login(MANAGED, 'browser')).toMatchObject({ ok: false, code: 'cancelled', state: 'signed-in', credential: 'account', message: expect.stringMatching(/regardless/) })
  })

  it('the cancel signal and a bounded deadline reach the sign-in run', async () => {
    const w = world()
    const ac = new AbortController()
    await w.ops.login(MANAGED, 'device', { signal: ac.signal })
    expect(w.runs[1].opts.signal).toBe(ac.signal)
    for (const r of w.runs) expect(r.opts.timeoutMs).toBeGreaterThan(0)
    expect(w.runs[1].opts.timeoutMs).toBeLessThanOrEqual(20 * 60_000)
    expect(w.runs[0].opts.timeoutMs).toBeLessThanOrEqual(60_000)
  })

  it('the executable is re-verified before every run, not once per operation', async () => {
    let n = 0
    const w = world({ proven: () => (n++ < 3 ? PROVEN : null) })
    // prepare (1), the status before (2), the login (3); the status after finds no proof.
    expect(await w.ops.login(MANAGED, 'device')).toMatchObject({ ok: false, code: 'cli-unavailable' })
    expect(argsOf(w.runs)).toEqual(['login status', 'login --device-auth'])
  })

  it('one sign-in or sign-out at a time per realm FOLDER (by file identity, however it is spelled); another folder is independent', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => { release = res })
    const w = world({}, { 'login --device-auth': async (r) => { await gate; w.signedIn.set(r.env.CODEX_HOME, 'chatgpt'); return { exitCode: 0 } } })
    const first = w.ops.login(MANAGED, 'device')
    await new Promise((res) => setTimeout(res, 0))
    expect(await w.ops.login(MANAGED, 'device')).toMatchObject({ ok: false, code: 'busy' })
    expect(await w.ops.logout(MANAGED)).toMatchObject({ ok: false, code: 'busy' })
    const other = w.ops.login(MANAGED_B, 'device')
    release()
    expect(await first).toEqual(SIGNED_IN_ACCOUNT)
    expect(await other).toEqual(SIGNED_IN_ACCOUNT)
    // Released after it settled.
    expect(await w.ops.logout(MANAGED)).toMatchObject({ ok: true })
    // Two realm records whose folders are ONE folder (a link the canonical
    // check cannot see, a share alias): the lock is the folder's identity.
    let release2: () => void = () => {}
    const gate2 = new Promise<void>((res) => { release2 = res })
    const same = world({ realmIdentity: (h) => ({ canonical: h, dev: '9', ino: '77', isDirectory: true }) }, { 'login --device-auth': async () => { await gate2; return { exitCode: 0 } } })
    const one = same.ops.login(MANAGED, 'device')
    await new Promise((res) => setTimeout(res, 0))
    expect(await same.ops.login(MANAGED_B, 'device')).toMatchObject({ ok: false, code: 'busy' })
    release2()
    await one
  })

  it('one browser sign-in at a time across every realm (the callback port is machine-wide); device sign-in is not held by it', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((res) => { release = res })
    const w = world({}, { 'login': async (r) => { await gate; w.signedIn.set(r.env.CODEX_HOME, 'chatgpt'); return { exitCode: 0 } } })
    const first = w.ops.login(MANAGED, 'browser')
    await new Promise((res) => setTimeout(res, 0))
    expect(await w.ops.login(MANAGED_B, 'browser')).toMatchObject({ ok: false, code: 'browser-busy', message: expect.stringMatching(/browser/) })
    expect(await w.ops.login(MANAGED_B, 'device')).toEqual(SIGNED_IN_ACCOUNT)
    release()
    expect(await first).toEqual(SIGNED_IN_ACCOUNT)
    // Released after it settled -- whatever the outcome.
    const f = world({}, { 'login': () => ({ exitCode: 1 }) })
    await f.ops.login(MANAGED, 'browser')
    expect(await f.ops.login(MANAGED_B, 'browser')).toMatchObject({ code: 'provider-refused' })
  })

  it('a stop that found the root already gone still drops the partial line', async () => {
    const w = world({}, { 'login': (r) => { r.opts.onOutput?.(`key: ${KEY.slice(0, 15)}`, 'stdout'); w.signedIn.set(r.env.CODEX_HOME, 'chatgpt'); return { exitCode: 0, stopped: 'cancel' } } })
    const shown: string[] = []
    await w.ops.login(MANAGED, 'browser', { onOutput: (t) => shown.push(t) })
    expect(shown.join('')).not.toContain('key:')
  })

  it('the display never shows a partial line left by a stopped or cut-off run, and each stream is buffered on its own', async () => {
    const w = world({}, { 'login': (r) => { r.opts.onOutput?.(`almost ${KEY.slice(0, 12)}`, 'stdout'); return { spawnError: 'cancelled' } } })
    const shown: string[] = []
    await w.ops.login(MANAGED, 'browser', { onOutput: (t) => shown.push(t) })
    expect(shown.join('')).not.toContain('almost')
    const s = world({}, {
      'login': (r) => {
        r.opts.onOutput?.(`key ${KEY.slice(0, 11)}`, 'stdout')
        r.opts.onOutput?.('WARN a stderr line\n', 'stderr')
        r.opts.onOutput?.(`${KEY.slice(11)}\n`, 'stdout')
        s.signedIn.set(r.env.CODEX_HOME, 'chatgpt')
        return { exitCode: 0 }
      },
    })
    const lines: string[] = []
    await s.ops.login(MANAGED, 'browser', { onOutput: (t) => lines.push(t) })
    expect(lines).toContain('WARN a stderr line\n')
    expect(lines.join('')).not.toContain(KEY.slice(0, 11) + 'WARN')
    expect(lines.join('')).not.toMatch(/K{16}/)
  })
})

describe('Codex API-key sign-in (WP1.22)', () => {
  it('takes the key from its single-use handle, writes it to stdin only, and verifies an API-key sign-in', async () => {
    const w = world()
    const shown: string[] = []
    expect(await w.ops.login(MANAGED, 'apiKey', { secretHandle: 'h1', onOutput: (t) => shown.push(t) })).toEqual({ ok: true, state: 'signed-in', credential: 'api-key' })
    expect(w.taken).toEqual(['h1'])
    expect(argsOf(w.runs)).toEqual(['login status', 'login --with-api-key', 'login status'])
    const login = w.runs[1]
    expect(login.opts.stdin).toBe(`${KEY}\n`)
    for (const r of w.runs) {
      expect(r.args.join(' '), 'argv').not.toContain(KEY)
      expect(JSON.stringify(r.env), 'env').not.toContain(KEY)
      if (r !== login) expect(r.opts.stdin, 'only the login run gets stdin').toBeUndefined()
    }
    // The CLI echoed the key: the display never shows it.
    expect(shown.join('')).not.toContain(KEY)
    expect(shown.join('')).toContain('read key')
  })

  it('the handle is consumed first, so a refused sign-in never leaves the key waiting', async () => {
    for (const [realm, over] of [[{ authRealmId: 'nope' }, {}], [EXTERNAL, {}], [MANAGED, { proven: () => null }]] as const) {
      const w = world(over as Partial<CodexAuthDeps>)
      expect(await w.ops.login(realm, 'apiKey', { secretHandle: 'h1' })).toMatchObject({ ok: false })
      expect(w.taken).toEqual(['h1'])
      expect(w.secrets.has('h1')).toBe(false)
      expect(w.runs.some((r) => r.opts.stdin !== undefined)).toBe(false)
    }
  })

  it('a handle sent with a browser, device or unknown sign-in is consumed and refused, never left parked', async () => {
    for (const m of ['browser', 'device', 'nonsense'] as never[]) {
      const w = world()
      expect(await w.ops.login(MANAGED, m, { secretHandle: 'h1' }), String(m)).toMatchObject({ ok: false, code: 'method-unsupported' })
      expect(w.taken, String(m)).toEqual(['h1'])
      expect(w.runs, String(m)).toEqual([])
    }
  })

  it('no handle, an unknown, used or non-string handle, a throwing or odd secret store, or no secret channel runs no sign-in', async () => {
    const w = world()
    expect(await w.ops.login(MANAGED, 'apiKey')).toMatchObject({ ok: false, code: 'secret-unavailable' })
    expect(await w.ops.login(MANAGED, 'apiKey', { secretHandle: 'nope' })).toMatchObject({ ok: false, code: 'secret-unavailable' })
    await w.ops.login(MANAGED, 'apiKey', { secretHandle: 'h2' })
    expect(await w.ops.login(MANAGED_B, 'apiKey', { secretHandle: 'h2' })).toMatchObject({ ok: false, code: 'secret-unavailable' })
    for (const handle of [new String('h1'), ['h1'], 7] as never[]) expect(await world().ops.login(MANAGED, 'apiKey', { secretHandle: handle })).toMatchObject({ ok: false, code: 'secret-unavailable' })
    expect(await world({ takeSecret: () => { throw new Error(KEY) } }).ops.login(MANAGED, 'apiKey', { secretHandle: 'h1' })).toMatchObject({ ok: false, code: 'secret-unavailable' })
    expect(await world({ takeSecret: () => Buffer.from(KEY) as never }).ops.login(MANAGED, 'apiKey', { secretHandle: 'h1' })).toMatchObject({ ok: false, code: 'secret-unavailable' })
    const none = await world({ takeSecret: undefined }).ops.login(MANAGED, 'apiKey', { secretHandle: 'h1' })
    expect(none).toMatchObject({ ok: false, code: 'secret-channel-unavailable', message: expect.stringMatching(/not available/) })
  })

  it('only printable ASCII of a key-like length is sent: surrounding space, control or format characters and short keys are refused, not cleaned', async () => {
    const c = (n: number) => String.fromCharCode(n)
    const bad = [
      'sk-a\nsk-bbbbbbbbbbbbbbbbbbbb', `${KEY}${c(0)}`, '', '   ', 'x'.repeat(5000), ` ${KEY}`, `${KEY} `, `${KEY}\n\n`,
      `${KEY.slice(0, 10)}${c(0x85)}${KEY.slice(10)}`, `${KEY.slice(0, 10)}${c(0x200e)}${KEY.slice(10)}`, 'sk-short-key',
    ]
    for (const v of bad) {
      const w = world({ takeSecret: () => v })
      expect(await w.ops.login(MANAGED, 'apiKey', { secretHandle: 'h' }), JSON.stringify(v.slice(0, 12))).toMatchObject({ ok: false, code: 'secret-invalid' })
      expect(w.runs).toEqual([])
    }
    // One trailing line break (a paste) is fine, CRLF included.
    expect(await world({ takeSecret: () => `${KEY}\r\n` }).ops.login(MANAGED, 'apiKey', { secretHandle: 'h' })).toMatchObject({ ok: true })
  })

  it('a ChatGPT sign-in where an API key was expected is not a success', async () => {
    const w = world({}, { 'login --with-api-key': (r) => { w.signedIn.set(r.env.CODEX_HOME, 'chatgpt'); return { exitCode: 0 } } })
    expect(await w.ops.login(MANAGED, 'apiKey', { secretHandle: 'h1' })).toMatchObject({ ok: false, code: 'not-confirmed' })
  })

  it('an echo of the key cut, spliced or split by the CLI is still redacted', async () => {
    const c = (n: number) => String.fromCharCode(n)
    const w = world({}, {
      'login --with-api-key': (r) => {
        r.opts.onOutput?.(`a ${KEY.slice(0, 30)}${c(0x9b)}0m${KEY.slice(30)}\n`, 'stdout')
        r.opts.onOutput?.(`b ${KEY.slice(5, 40)}\n`, 'stdout')
        r.opts.onOutput?.(`c ${KEY.slice(0, 26)}...\n`, 'stderr')
        w.signedIn.set(r.env.CODEX_HOME, 'api-key')
        return { exitCode: 0 }
      },
    })
    const shown: string[] = []
    await w.ops.login(MANAGED, 'apiKey', { secretHandle: 'h1', onOutput: (t) => shown.push(t) })
    expect(shown.join('')).not.toMatch(/K{16}/)
  })

  it('no result, message or failure text ever carries the key or a login URL', async () => {
    const results = [
      await world().ops.login(MANAGED, 'apiKey', { secretHandle: 'h1' }),
      await world({}, { 'login --with-api-key': (r) => ({ exitCode: 1, stderr: `bad key ${r.opts.stdin}` }) }).ops.login(MANAGED, 'apiKey', { secretHandle: 'h1' }),
      await world({}, { 'login': () => ({ exitCode: 1, stderr: 'go to https://auth.example/oauth/authorize?state=s' }) }).ops.login(MANAGED, 'browser'),
      await world({ run: async () => { throw new Error(`boom ${KEY} https://x.example`) } }).ops.login(MANAGED, 'apiKey', { secretHandle: 'h1' }),
    ]
    const text = JSON.stringify(results)
    expect(text).not.toContain(KEY)
    expect(text).not.toMatch(/https?:/)
  })
})

describe('Codex logout (WP1.23, WP1.24)', () => {
  it('runs `logout` in the selected realm only and confirms the realm now reads signed out', async () => {
    const w = world()
    w.signedIn.set(HOME_A, 'chatgpt')
    w.signedIn.set(HOME_B, 'chatgpt')
    expect(await w.ops.logout(MANAGED)).toEqual({ ok: true, state: 'signed-out' })
    expect(argsOf(w.runs)).toEqual(['logout', 'login status'])
    expect(w.signedIn.has(HOME_B)).toBe(true)
  })

  it('an external realm is logged out only with an explicit acknowledgement of its wider effect', async () => {
    const w = world()
    for (const opts of [undefined, {}, { acknowledgeExternalRealm: 'yes' as never }, { acknowledgeExternalRealm: 1 as never }]) {
      expect(await w.ops.logout(EXTERNAL, opts)).toMatchObject({ ok: false, code: 'external-ack-required', message: expect.stringMatching(/other/) })
    }
    expect(w.runs).toEqual([])
    expect(await w.ops.logout(EXTERNAL, { acknowledgeExternalRealm: true })).toEqual({ ok: true, state: 'signed-out' })
    expect(w.runs[0].env.CODEX_HOME).toBe(HOME_X)
  })

  it('a logout that leaves the realm signed in, or whose check cannot answer, is not a success', async () => {
    const stuck = world({}, { 'logout': () => ({ exitCode: 0 }) })
    stuck.signedIn.set(HOME_A, 'chatgpt')
    expect(await stuck.ops.logout(MANAGED)).toMatchObject({ ok: false, code: 'still-signed-in', state: 'signed-in' })
    expect(await world({}, { 'login status': () => ({ timedOut: true }) }).ops.logout(MANAGED)).toMatchObject({ ok: false, code: 'timed-out' })
    expect(await world({}, { 'logout': () => ({ spawnError: 'EACCES' }) }).ops.logout(MANAGED)).toMatchObject({ ok: false, code: 'not-started' })
  })
})

describe('the package keeps its own proof and exposes auth only when wired (T13, T14)', () => {
  const discoveryDeps = (gates: Array<() => Promise<Partial<CodexRunResult>>>) => {
    let n = 0
    return async (): Promise<CodexDiscoveryDeps> => ({
      resolve: () => IDENT.path,
      realpath: (p) => p,
      stat: () => ({ ...IDENT, isFile: true }),
      run: async () => ({ exitCode: 0, stdout: '', stderr: '', timedOut: false, truncated: false, ...(await gates[n++]()) }),
      env: { SystemRoot: 'C:\\Windows' },
      platform: 'win32',
      versionHome: () => ({ home: 'C:\\tmp\\v', dispose: () => {} }),
      now: () => 1,
    })
  }
  const authPorts = () => {
    const w = world()
    const { lookupRealm: _l, takeSecret: _t, proven: _p, ...ports } = w.deps
    return { lookup: w.deps.lookupRealm, ports }
  }

  it('without injected auth deps there is no auth, and the auth capabilities stay unknown', () => {
    const pkg = createCodexPackage()
    expect(pkg.auth).toBeUndefined()
    for (const k of ['auth.browser', 'auth.device', 'auth.apiKey', 'auth.status', 'auth.logout'] as const) expect(pkg.capabilities[k].state).toBe('unknown')
    const { lookup } = authPorts()
    expect(createCodexPackage({ auth: { lookupRealm: lookup } }).auth).toBeDefined()
  })

  it('a test port can never replace the proof, the realm lookup or the secret store', async () => {
    const { lookup, ports } = authPorts()
    let rogue = 0
    let real = 0
    const pkg = createCodexPackage({
      auth: { lookupRealm: async (r) => { real++; return lookup(r) } },
      authPorts: { ...ports, lookupRealm: async () => { rogue++; return { ok: false } }, proven: () => PROVEN, takeSecret: () => KEY } as never,
    })
    expect(await pkg.auth!.status(MANAGED)).toMatchObject({ code: 'cli-unavailable' })
    expect(await pkg.auth!.login(MANAGED, 'apiKey', { secretHandle: 'h' })).toMatchObject({ code: 'secret-channel-unavailable' })
    expect([real, rogue]).toEqual([1, 0])
  })

  it('a sign-in never runs on stale proof: a re-check clears it while it runs, a failed check leaves it clear, overlapping checks keep the newest', async () => {
    const version = async () => ({ stdout: 'codex-cli 0.155.1\n' })
    let releaseFirst: () => void = () => {}
    const first = new Promise<Partial<CodexRunResult>>((res) => { releaseFirst = () => res({ stdout: 'codex-cli 0.155.1\n' }) })
    let releaseFourth: () => void = () => {}
    const fourth = new Promise<Partial<CodexRunResult>>((res) => { releaseFourth = () => res({ stdout: 'codex-cli 0.155.1\n' }) })
    const { lookup, ports } = authPorts()
    const pkg = createCodexPackage({
      auth: { lookupRealm: lookup },
      authPorts: ports,
      discoveryDeps: discoveryDeps([() => first, async () => ({ stdout: 'nonsense' }), version, () => fourth]),
    })
    const auth = pkg.auth!
    expect(await auth.status(MANAGED)).toMatchObject({ code: 'cli-unavailable' })
    const d1 = pkg.setup!.discover()
    const d2 = pkg.setup!.discover()
    expect(await d2).toMatchObject({ state: 'invalid' })
    releaseFirst()
    expect(await d1).toMatchObject({ state: 'found' })
    // d1 finished last but started first: its proof is not the newest.
    expect(await auth.status(MANAGED)).toMatchObject({ code: 'cli-unavailable' })
    expect(await pkg.setup!.discover()).toMatchObject({ state: 'found' })
    expect(await auth.status(MANAGED)).toMatchObject({ ok: true })
    const d4 = pkg.setup!.discover()
    expect(await auth.status(MANAGED)).toMatchObject({ code: 'cli-unavailable' })
    releaseFourth()
    await d4
    expect(await auth.status(MANAGED)).toMatchObject({ ok: true })
  })

  it('a check that throws leaves no proof and rejects to its caller', async () => {
    const { lookup, ports } = authPorts()
    const pkg = createCodexPackage({ auth: { lookupRealm: lookup }, authPorts: ports, discoveryDeps: async () => { throw new Error('no shell') } })
    await expect(pkg.setup!.discover()).rejects.toThrow()
    expect(await pkg.auth!.status(MANAGED)).toMatchObject({ code: 'cli-unavailable' })
  })
})

describe('the sign-in output redactor', () => {
  const collect = (secrets: string[] = []) => {
    const out: string[] = []
    const r = createCodexOutputRedactor((t) => out.push(t), secrets)
    return { r, out }
  }

  it('emits whole lines only, and the remainder on flush -- or nothing on discard', () => {
    const { r, out } = collect()
    r.push('abc')
    expect(out).toEqual([])
    r.push('def\r\nghi\n')
    expect(out).toEqual(['abcdef\n', 'ghi\n'])
    r.push('tail')
    r.flush()
    expect(out).toEqual(['abcdef\n', 'ghi\n', 'tail\n'])
    r.flush()
    expect(out).toHaveLength(3)
    r.push('cut mid-')
    r.discard()
    r.flush()
    expect(out).toHaveLength(3)
  })

  it('redacts known secret shapes, the exact secrets it was given and any 16-character run of them, even split across chunks', () => {
    const { r, out } = collect(['hunter2-exact-value', KEY])
    r.push(`key ${KEY.slice(0, 11)}`)
    r.push(`${KEY.slice(11)} and hunter2-`)
    r.push('exact-value and ghp_' + 'a'.repeat(36) + '\n')
    r.push(`fragment ${KEY.slice(3, 19)} end\n`)
    const text = out.join('')
    expect(text).not.toContain(KEY)
    expect(text).not.toContain('hunter2-exact-value')
    expect(text).not.toContain('ghp_')
    expect(text).not.toContain(KEY.slice(3, 19))
    expect(text).toContain('end')
  })

  it('strips terminal escapes (including OSC clipboard and hyperlink sequences) and control characters', () => {
    const { r, out } = collect()
    r.push(`${ESC}[31mred${ESC}[0m ${ESC}]52;c;ZXZpbA==${BEL}${ESC}]8;;https://x.example${ESC}\\link${ESC}]8;;${ESC}\\ a${String.fromCharCode(8)}b\tc\n`)
    expect(out).toEqual(['red link ab\tc\n'])
  })

  it('strips 8-bit escapes as whole units, C1 controls and bidirectional overrides', () => {
    const { r, out } = collect()
    const c = (n: number) => String.fromCharCode(n)
    r.push(`a${c(0x9b)}31mb${c(0x9d)}52;c;ZXZpbA==${c(0x9c)}x${c(0x90)}q-payload${c(0x9c)}${c(0x85)} ${c(0x202e)}lmth.exe${c(0x202c)} ${c(0x2066)}i${c(0x2069)}${c(0x200f)}\n`)
    expect(out).toEqual(['abx lmth.exe i\n'])
  })

  it('withholds a partial line too long to redact safely, then carries on', () => {
    const { r, out } = collect()
    r.push('x'.repeat(3000))
    r.push('y'.repeat(3000))
    r.push('z'.repeat(3000) + '\nnext\n')
    expect(out).toHaveLength(2)
    expect(out[0]).toMatch(/withheld/)
    expect(out[0]).not.toMatch(/xxx/)
    expect(out[1]).toBe('next\n')
  })

  it('strips 7-bit DCS, SOS, PM and APC payloads whole, and every Unicode format character', () => {
    const { r, out } = collect()
    const c = (n: number) => String.fromCharCode(n)
    r.push(`a${ESC}Pq-payload${ESC}\\b${ESC}_apc${BEL}c${ESC}Xsos${ESC}\\d${ESC}^pm${ESC}\\e${c(0x200b)}f${c(0xfeff)}g${c(0x2060)}h\n`)
    expect(out).toEqual(['abcdefgh\n'])
  })

  it('stays linear on a repetitive key and long echoes of it', () => {
    const key = 'A'.repeat(4096)
    const { r, out } = collect([key])
    const started = Date.now()
    for (let i = 0; i < 16; i++) r.push(`${'A'.repeat(3999)}B\n`)
    r.push(`${'A'.repeat(4095)}B`.repeat(15) + '\n')
    expect(Date.now() - started).toBeLessThan(2000)
    expect(out.join('')).not.toMatch(/A{16}/)
  })

  it('a display consumer that throws never breaks the redactor', () => {
    const r = createCodexOutputRedactor(() => { throw new Error('renderer gone') })
    expect(() => { r.push('a\nb'); r.flush() }).not.toThrow()
  })
})
