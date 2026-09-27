// Usage track MP7 (ADR-022; the owner's scoped WP1.41 exception): the client
// side of one `codex app-server` usage read, as a pure state machine.
//
// It sends exactly `initialize` (the Codex CLI's name and proven version,
// `capabilities: null`), the `initialized` notification and
// `account/rateLimits/read` with no parameters: never a thread, turn or
// conversation method, never `supportsLunaReserve`, never an answer to a
// server request. It reads only its two answers by id, one line each within
// the size bound, validated against the schema excerpts (extra fields
// accepted), and the `initialize` answer must name the realm. Every failure
// is a verdict that fails closed, and every verdict closes stdin.
//
// PURE: an injected writer and fed stdout; no process, no timer.
import { describe, it, expect } from 'vitest'
import {
  createAppServerUsageClient, appServerMessages, APP_SERVER_MAX_LINE, APP_SERVER_CLIENT_NAME,
  APP_SERVER_READ_DEADLINE_MS, APP_SERVER_INITIALIZE_TIMEOUT_MS, APP_SERVER_EXIT_GRACE_MS,
} from '../../../../src/main/providers/codex/app-server-client'

const HOME = 'C:\\Users\\u\\AppData\\Roaming\\conductor\\codex-realms\\realm-0000000000000001'
const NOW = Date.parse('2026-09-27T12:00:00Z')

function client(over: { platform?: NodeJS.Platform; home?: string; version?: string } = {}) {
  const sent: string[] = []
  let finished = 0
  const c = createAppServerUsageClient({
    send: (l) => { sent.push(l) },
    finish: () => { finished++ },
    realmHome: over.home ?? HOME,
    platform: over.platform ?? 'win32',
    cliVersion: over.version ?? '0.155.1',
    now: () => NOW,
  })
  return { c, sent, finished: () => finished }
}
const line = (m: unknown) => JSON.stringify(m) + '\n'
const initAnswer = (codexHome: string = HOME, over: Record<string, unknown> = {}) =>
  line({ id: 1, result: { codexHome, platformFamily: 'windows', platformOs: 'windows', userAgent: 'codex_cli_rs/0.155.1', ...over } })
const reset = Math.floor(NOW / 1000) + 3600
const readAnswer = (over: Record<string, unknown> = {}) => line({
  id: 2,
  result: {
    rateLimits: { limitId: 'codex', limitName: null, primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: reset }, secondary: { usedPercent: 47, windowDurationMins: 10080, resetsAt: reset + 86_400 }, planType: 'plus', credits: null },
    rateLimitsByLimitId: null,
    ...over,
  },
})
const FORBIDDEN = /thread|turn|conversation|supportsLunaReserve|experimental|getAuthStatus|account\/read"/

describe('what the client sends (ADR-022 bound 1)', () => {
  it('begins with exactly the initialize message: the Codex CLI\'s name and version, no capability', () => {
    const { c, sent } = client()
    c.begin()
    expect(sent).toEqual([`{"id":1,"method":"initialize","params":{"clientInfo":{"name":"${APP_SERVER_CLIENT_NAME}","title":null,"version":"0.155.1"},"capabilities":null}}\n`])
    c.begin()
    expect(sent).toHaveLength(1)
  })

  it('after an initialize answer naming the realm: exactly initialized, then the read with no parameters', () => {
    const { c, sent } = client()
    c.begin()
    c.receive(initAnswer())
    expect(sent.slice(1)).toEqual(['{"method":"initialized"}\n', '{"id":2,"method":"account/rateLimits/read"}\n'])
    for (const s of sent) expect(s).not.toMatch(FORBIDDEN)
    const m = appServerMessages('0.155.1')
    expect(Object.keys(m)).toEqual(['initialize', 'initialized', 'read'])
  })

  it('a version that is not a plain version sends nothing and fails as unsupported', () => {
    for (const version of ['', '0.155.1; rm', '0.155.1\n{"id":9}', 'latest']) {
      const { c, sent, finished } = client({ version })
      c.begin()
      expect(sent, version).toEqual([])
      expect(c.verdict, version).toEqual({ ok: false, kind: 'unsupported', reason: 'version' })
      expect(finished()).toBe(1)
    }
  })
})

describe('the answer (ADR-022 bounds 3, 5, 8)', () => {
  it('a full read: the allowance, the plan, stdin closed once', () => {
    const { c, finished } = client()
    c.begin(); c.receive(initAnswer()); c.receive(readAnswer())
    expect(c.verdict?.ok).toBe(true)
    if (!c.verdict?.ok) throw new Error('no reading')
    expect(c.verdict.reading.planType).toBe('plus')
    expect(c.verdict.reading.limits[0].primary?.usedPercent).toBe(18)
    expect(c.verdict.reading.limits[0].secondary?.windowMinutes).toBe(10080)
    expect(finished()).toBe(1)
  })

  it('accepts the fields later versions add, and requires none of them', () => {
    const { c } = client()
    c.begin(); c.receive(initAnswer(HOME, { extra: { nested: true } }))
    c.receive(readAnswer({ ordinaryUsageAllowed: true, rateLimitUpsell: { banner_text: 'x' }, rateLimitsByLimitId: { codex: { limitId: 'codex', normalModelSlug: 'gpt', primary: { usedPercent: 18, windowDurationMins: 300, resetsAt: reset } } } }))
    expect(c.verdict?.ok).toBe(true)
  })

  it('reads a line split across chunks, with CRLF, and ignores notifications', () => {
    const { c } = client()
    c.begin()
    const text = line({ method: 'account/updated', params: {} }) + initAnswer().replace('\n', '\r\n') + readAnswer()
    for (let i = 0; i < text.length; i += 7) c.receive(text.slice(i, i + 7))
    expect(c.verdict?.ok).toBe(true)
  })

  // MP7 round 1, D-1: a wrong home is about the realm, not the CLI, so it is
  // never the sticky per-executable verdict.
  it('the realm must be named: another home fails (transient) and nothing more is sent', () => {
    const { c, sent } = client()
    c.begin(); c.receive(initAnswer('C:\\Users\\u\\.codex'))
    expect(c.verdict).toEqual({ ok: false, kind: 'transient', reason: 'codex-home' })
    expect(sent).toHaveLength(1)
  })

  it('the realm is compared canonically: caseless with either separator on Windows, exact on Linux', () => {
    const win = client()
    win.c.begin(); win.c.receive(initAnswer(HOME.toUpperCase().replace(/\\/g, '/') + '/'))
    expect(win.c.initialized).toBe(true)
    const verbatim = client()
    verbatim.c.begin(); verbatim.c.receive(initAnswer(`\\\\?\\${HOME}`))
    expect(verbatim.c.initialized).toBe(true)
    const linux = client({ platform: 'linux', home: '/home/u/.local/share/conductor/codex-realms/realm-1' })
    linux.c.begin(); linux.c.receive(initAnswer('/home/u/.local/share/conductor/codex-realms/REALM-1'))
    expect(linux.c.verdict).toEqual({ ok: false, kind: 'transient', reason: 'codex-home' })
  })

  // MP7 round 1, D-1: a realm on a share, answered in the verbatim UNC form.
  it('a verbatim UNC home (\\\\?\\UNC\\server\\share) names the same folder as \\\\server\\share, in either case', () => {
    const share = '\\\\fs1\\users\\u\\conductor\\codex-realms\\realm-0000000000000001'
    for (const answered of [`\\\\?\\UNC\\${share.slice(2)}`, `\\\\?\\unc\\${share.slice(2).toUpperCase()}`, share]) {
      const unc = client({ home: share })
      unc.c.begin(); unc.c.receive(initAnswer(answered))
      expect(unc.c.initialized, answered).toBe(true)
    }
    // Not a way to name another share or a local folder.
    for (const other of [`\\\\?\\UNC\\fs2\\${share.slice(6)}`, `\\\\?\\C:${share.slice(1)}`]) {
      const unc = client({ home: share })
      unc.c.begin(); unc.c.receive(initAnswer(other))
      expect(unc.c.verdict, other).toEqual({ ok: false, kind: 'transient', reason: 'codex-home' })
    }
  })

  // MP7 round 1, C-F1: the helper names its own version; it must be the one
  // the client was started for (the proven executable), else fail closed.
  it('the helper\'s user agent must name the version the client was started for', () => {
    const ok = client()
    ok.c.begin(); ok.c.receive(initAnswer(HOME, { userAgent: 'codex_cli_rs/0.155.1 (Windows 10.0.26100; x86_64) WindowsTerminal' }))
    expect(ok.c.initialized).toBe(true)
    for (const userAgent of ['codex_cli_rs/0.157.1 (Windows 10.0.26100; x86_64)', 'codex_cli_rs/0.155.10', 'fake', '', ' codex_cli_rs/0.155.1', 'codex_cli_rs 0.155.1']) {
      const { c, sent } = client()
      c.begin(); c.receive(initAnswer(HOME, { userAgent }))
      expect(c.verdict, userAgent).toEqual({ ok: false, kind: 'transient', reason: 'version-mismatch' })
      expect(sent, userAgent).toHaveLength(1)
    }
  })

  it('a request from the server is never answered and fails the read', () => {
    const { c, sent } = client()
    c.begin(); c.receive(initAnswer())
    c.receive(line({ id: 'srv-1', method: 'account/chatgptAuthTokens/refresh', params: {} }))
    expect(c.verdict).toEqual({ ok: false, kind: 'transient', reason: 'server-request' })
    expect(sent).toHaveLength(3)
  })

  it('error answers: method not found and invalid requests are unsupported; anything else is transient', () => {
    const cases: Array<[number, string, string]> = [[-32601, 'unsupported', 'method-not-found'], [-32600, 'unsupported', 'invalid-request'], [-32602, 'unsupported', 'invalid-request'], [-32000, 'transient', 'error-response']]
    for (const [code, kind, reason] of cases) {
      const { c } = client()
      c.begin(); c.receive(initAnswer()); c.receive(line({ id: 2, error: { code, message: 'x' } }))
      expect(c.verdict, String(code)).toEqual({ ok: false, kind, reason })
    }
    const early = client()
    early.c.begin(); early.c.receive(line({ id: 1, error: { code: -32601, message: 'no' } }))
    expect(early.c.verdict).toEqual({ ok: false, kind: 'unsupported', reason: 'method-not-found' })
  })

  it('answers that do not match the schema fail as unsupported', () => {
    const bad: Array<[string, string]> = [
      ['initialize without userAgent', line({ id: 1, result: { codexHome: HOME, platformFamily: 'windows', platformOs: 'windows' } })],
      ['initialize with a numeric home', line({ id: 1, result: { codexHome: 7, platformFamily: 'w', platformOs: 'w', userAgent: 'u' } })],
      ['a response to an id never sent', line({ id: 9, result: {} })],
      ['the read answered before initialize', line({ id: 2, result: {} })],
    ]
    for (const [name, text] of bad) {
      const { c } = client()
      c.begin(); c.receive(text)
      expect(c.verdict, name).toEqual({ ok: false, kind: 'unsupported', reason: 'schema' })
    }
    const readBad: Array<[string, Record<string, unknown>]> = [
      ['no rateLimits', { id: 2, result: { rateLimitsByLimitId: null } }],
      ['a fractional percentage', { id: 2, result: { rateLimits: { primary: { usedPercent: 12.5 } } } }],
      ['a window without its percentage', { id: 2, result: { rateLimits: { primary: { windowDurationMins: 300 } } } }],
      ['a per-limit map that is a list', { id: 2, result: { rateLimits: {}, rateLimitsByLimitId: [] } }],
      ['a numeric plan', { id: 2, result: { rateLimits: { planType: 3 } } }],
    ]
    for (const [name, msg] of readBad) {
      const { c } = client()
      c.begin(); c.receive(initAnswer()); c.receive(line(msg))
      expect(c.verdict, name).toEqual({ ok: false, kind: 'unsupported', reason: 'schema' })
    }
  })

  // MP7 round 1, D-1: only a version or protocol answer is sticky.
  it('a line that is not JSON, or not an object, fails (transient)', () => {
    for (const text of ['not json\n', '[1,2]\n', '"x"\n', '{"id":true}\n']) {
      const { c } = client()
      c.begin(); c.receive(text)
      expect(c.verdict, text).toEqual({ ok: false, kind: 'transient', reason: 'malformed' })
    }
  })

  it(`a line longer than ${APP_SERVER_MAX_LINE} characters fails, whether or not it has ended yet`, () => {
    const long = 'x'.repeat(APP_SERVER_MAX_LINE + 1)
    const ended = client()
    ended.c.begin(); ended.c.receive(long + '\n')
    expect(ended.c.verdict).toEqual({ ok: false, kind: 'transient', reason: 'oversized' })
    const open = client()
    open.c.begin(); open.c.receive(long)
    expect(open.c.verdict).toEqual({ ok: false, kind: 'transient', reason: 'oversized' })
  })

  // MP7 round 1, S-1 (ADR-022: every bound is a test): the values themselves.
  it('the bounds are the ADR\'s: 64 KiB a line, 12 s for initialize, 20 s a read, 3 s to exit', () => {
    expect(APP_SERVER_MAX_LINE).toBe(65_536)
    expect(APP_SERVER_INITIALIZE_TIMEOUT_MS).toBe(12_000)
    expect(APP_SERVER_READ_DEADLINE_MS).toBe(20_000)
    expect(APP_SERVER_EXIT_GRACE_MS).toBe(3_000)
    // A line of exactly the bound is read.
    const { c } = client()
    c.begin(); c.receive(initAnswer(HOME, { pad: 'x'.repeat(65_536 - initAnswer().length - 10) }))
    expect(c.initialized).toBe(true)
  })

  it('an answer with nothing to show is no reading (transient)', () => {
    const { c } = client()
    c.begin(); c.receive(initAnswer()); c.receive(line({ id: 2, result: { rateLimits: { limitId: 'codex', primary: null, secondary: null, planType: 'plus' } } }))
    expect(c.verdict).toEqual({ ok: false, kind: 'transient', reason: 'no-reading' })
  })

  it('an end before a verdict is transient; after a verdict nothing changes and nothing more is sent', () => {
    for (const reason of ['timeout', 'exit', 'spawn', 'cancelled'] as const) {
      const { c } = client()
      c.begin(); c.ended(reason)
      expect(c.verdict).toEqual({ ok: false, kind: 'transient', reason })
    }
    const { c, sent, finished } = client()
    c.begin(); c.receive(initAnswer()); c.receive(readAnswer())
    c.ended('exit'); c.receive(readAnswer()); c.receive(line({ id: 'x', method: 'y' }))
    expect(c.verdict?.ok).toBe(true)
    expect(sent).toHaveLength(3)
    expect(finished()).toBe(1)
  })

  it('a writer that throws ends the read (transient)', () => {
    const c = createAppServerUsageClient({ send: () => { throw new Error('closed') }, finish: () => {}, realmHome: HOME, platform: 'win32', cliVersion: '0.155.1', now: () => NOW })
    c.begin()
    expect(c.verdict).toEqual({ ok: false, kind: 'transient', reason: 'exit' })
  })
})
