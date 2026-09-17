// The origin gate of the system-browser (SSO) sign-in, layer by layer.
//
// Final adversarial pass on 2.1.1: isClaudeUrl's host rule had tests for
// look-alike hosts (`claude.ai.attacker.test`, `notclaude.ai`) but none for a
// SIBLING subdomain -- a mutant that accepts any `*.claude.ai` stayed green --
// and the gates runSignIn stacks on top of it (target filter, live-URL
// re-check, in-page re-check, cookie domain filter) were only ever observed
// together. One case per layer, so a mutant in any one of them is red.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const cookiesSet = vi.fn()
const clearStorageData = vi.fn(async () => {})
vi.mock('electron', () => ({
  session: { fromPartition: vi.fn(() => ({ cookies: { set: cookiesSet }, clearStorageData })) },
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('../../src/main/browser-paths', () => ({ getBrowserPaths: () => ['C:/present/chrome.exe'] }))
vi.mock('node:child_process', () => ({
  spawn: () => ({ exitCode: null, signalCode: null, killed: false, kill: vi.fn(), on: vi.fn(), pid: 4242, once: vi.fn((_e: string, cb: () => void) => cb()) }),
  spawnSync: vi.fn(),
}))
vi.mock('node:fs', () => ({
  existsSync: () => true, readFileSync: () => '51234\n', readdirSync: () => [], rmSync: vi.fn(),
}))

const { runSignIn, _setCdpForTest, isClaudeUrl, pickSignInTargets, cancelSignIn, getSignInState } = await import('../../src/main/account-web/sign-in')
const { CLAUDE_SESSION_COOKIE } = await import('../../src/shared/account-web-session')

const sessionCookie = { name: CLAUDE_SESSION_COOKIE, value: 'sk', domain: '.claude.ai', path: '/', expires: 1_900_000_000, secure: true, httpOnly: true }
const LOGIN = { type: 'page', url: 'https://claude.ai/login', id: 't1', webSocketDebuggerUrl: 'ws://t1' }
// method:'sso' keeps this on the system-browser + CDP path (the non-SSO default
// signs in in-app and is covered by its own tests).
const RUN = { profileId: 'profile-aaa111', dataDir: 'C:/data', pollMs: 5, timeoutMs: 120, method: 'sso' } as const

function makeCdp(opts: {
  targets: any[]
  infoUrl: () => string | undefined
  cookies: () => any[]
  evaluate: (...a: any[]) => Promise<any>
  onCookies?: () => void
  onConnect?: (arg: any) => void
}) {
  const f: any = (arg: any) => {
    opts.onConnect?.(arg)
    return Promise.resolve({
      Target: { getTargetInfo: async () => ({ targetInfo: { url: opts.infoUrl() } }) },
      Runtime: { evaluate: opts.evaluate },
      Network: { getAllCookies: async () => { opts.onCookies?.(); return { cookies: opts.cookies() } } },
      close: async () => {},
    })
  }
  f.List = async () => opts.targets
  return f
}

beforeEach(() => {
  cookiesSet.mockReset()
  clearStorageData.mockClear()
  cancelSignIn()
})

describe('isClaudeUrl -- exactly claude.ai and www.claude.ai over https', () => {
  const reject = [
    // sibling / child subdomains: same registrable domain, NOT the sign-in origin
    'https://api.claude.ai/', 'https://console.claude.ai/', 'https://www.www.claude.ai/', 'https://claude.ai.claude.ai/',
    // look-alikes and embeddings
    'https://claude.ai.evil.example/', 'https://claude.ai@evil.example/', 'https://evil.example/claude.ai/',
    'https://claude.ai%2F@evil.example/', 'https://claude.ai./', 'https://claud\u0435.ai/', 'https://xn--clude-6sa.ai/',
    'https://evil.example/?u=https://claude.ai/', 'https://evil.example/#https://claude.ai/', 'https://claude.ai\u2044evil.example/',
    'HTTPS://CLAUDE.AI.EVIL.EXAMPLE/',
    // wrong scheme
    'http://claude.ai/', 'ws://claude.ai/', 'wss://claude.ai/', 'blob:https://claude.ai/uuid', 'filesystem:https://claude.ai/temporary/x',
    // not a page origin at all
    'about:blank', 'chrome-extension://abc/x.html', 'data:text/html,x', 'javascript:alert(1)', 'https://[::1]/', 'https://127.0.0.1/',
    '', 'not a url',
  ]
  it.each(reject)('rejects %s', (u) => { expect(isClaudeUrl(u)).toBe(false) })

  const accept = [
    'https://claude.ai/', 'https://www.claude.ai/', 'https://CLAUDE.AI/x', 'https://claude.ai:443/', 'https://claude.ai:8443/',
    'https://user:pw@claude.ai/', 'https://claude.ai/@evil.example',
  ]
  it.each(accept)('accepts %s (the hostname really is claude.ai)', (u) => { expect(isClaudeUrl(u)).toBe(true) })

  it('undefined is not claude.ai', () => { expect(isClaudeUrl(undefined)).toBe(false) })
})

describe('pickSignInTargets -- only a PAGE on claude.ai is a sign-in target', () => {
  it('a claude.ai-origin iframe / webview / worker / background page is never picked', () => {
    expect(pickSignInTargets([
      { type: 'iframe', url: 'https://claude.ai/embed', id: 'i1' },
      { type: 'webview', url: 'https://claude.ai/wv', id: 'w1' },
      { type: 'other', url: 'https://claude.ai/o', id: 'o1' },
      { type: 'service_worker', url: 'https://claude.ai/sw.js', id: 's1' },
      { type: 'background_page', url: 'https://claude.ai/bg', id: 'b1' },
      { type: 'PAGE', url: 'https://claude.ai/', id: 'p1' },
      { type: 'page', url: 'https://api.claude.ai/', id: 'p2' },
    ])).toEqual([])
  })
})

describe('runSignIn -- one case per gate', () => {
  it('G1 target filter: nothing but a claude.ai page is ever connected', async () => {
    const connected: any[] = []
    const evaluate = vi.fn(async () => ({ result: { value: 'x@y.z' } }))
    _setCdpForTest(makeCdp({
      targets: [
        { type: 'iframe', url: 'https://claude.ai/embed', id: 'i1', webSocketDebuggerUrl: 'ws://i1' },
        { type: 'page', url: 'https://api.claude.ai/login', id: 'e0', webSocketDebuggerUrl: 'ws://e0' },
        { type: 'page', url: 'https://claude.ai.evil.example/login', id: 'e1', webSocketDebuggerUrl: 'ws://e1' },
        { type: 'page', url: 'https://claude.ai@evil.example/login', id: 'e2', webSocketDebuggerUrl: 'ws://e2' },
        { type: 'page', url: 'https://evil.example/', title: 'Just a moment...', id: 'e3', webSocketDebuggerUrl: 'ws://e3' },
        { type: 'page', url: 'about:blank', id: 'e4', webSocketDebuggerUrl: 'ws://e4' },
        { type: 'page', url: 'https://idp.example/sso', id: 'e5', webSocketDebuggerUrl: 'ws://e5' },
      ],
      infoUrl: () => 'https://claude.ai/login', cookies: () => [sessionCookie], evaluate,
      onConnect: (a) => connected.push(a),
    }))
    const s = await runSignIn({ ...RUN })
    expect(s.phase).toBe('failed')
    expect(connected).toEqual([])
    expect(evaluate).not.toHaveBeenCalled()
    expect(cookiesSet).not.toHaveBeenCalled()
  })

  it('G2 live-URL re-check: a listed claude.ai page whose LIVE url is elsewhere gets no cookie read', async () => {
    let cookieReads = 0
    const evaluate = vi.fn(async () => ({ result: { value: 'x@y.z' } }))
    _setCdpForTest(makeCdp({ targets: [LOGIN], infoUrl: () => 'https://claude.ai@evil.example/', cookies: () => [sessionCookie], evaluate, onCookies: () => { cookieReads++ } }))
    const s = await runSignIn({ ...RUN })
    expect(s.phase).toBe('failed')
    expect(cookieReads).toBe(0)
    expect(evaluate).not.toHaveBeenCalled()
    expect(cookiesSet).not.toHaveBeenCalled()
  })

  it('G2b live-URL re-check: a sibling subdomain is elsewhere too', async () => {
    let cookieReads = 0
    const evaluate = vi.fn(async () => ({ result: { value: 'x@y.z' } }))
    _setCdpForTest(makeCdp({ targets: [LOGIN], infoUrl: () => 'https://api.claude.ai/', cookies: () => [sessionCookie], evaluate, onCookies: () => { cookieReads++ } }))
    const s = await runSignIn({ ...RUN })
    expect(s.phase).toBe('failed')
    expect(cookieReads).toBe(0)
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('G3 session cookie: a sessionKey on a look-alike or host-only www domain is not a session', async () => {
    const evaluate = vi.fn(async () => ({ result: { value: 'x@y.z' } }))
    const jar = [
      { ...sessionCookie, domain: 'claude.ai.evil.example' },
      { ...sessionCookie, domain: '.evil.example' },
      { ...sessionCookie, domain: '.ai' },
      { ...sessionCookie, domain: 'www.claude.ai' },
    ]
    _setCdpForTest(makeCdp({ targets: [LOGIN], infoUrl: () => 'https://claude.ai/login', cookies: () => jar, evaluate }))
    const s = await runSignIn({ ...RUN })
    expect(s.phase).toBe('failed')
    expect(evaluate).not.toHaveBeenCalled()
    expect(cookiesSet).not.toHaveBeenCalled()
  })

  it('G4 identity read re-check: passes the first origin check, is elsewhere by the read -> no evaluate, no write', async () => {
    let calls = 0
    const evaluate = vi.fn(async () => ({ result: { value: 'x@y.z' } }))
    _setCdpForTest(makeCdp({ targets: [LOGIN], infoUrl: () => (++calls % 2 === 1 ? 'https://claude.ai/login' : 'https://idp.example/callback'), cookies: () => [sessionCookie], evaluate }))
    const s = await runSignIn({ ...RUN })
    expect(s.phase).toBe('failed')
    expect(evaluate).not.toHaveBeenCalled()
    expect(cookiesSet).not.toHaveBeenCalled()
  })

  it('G5 identity result: a non-string answer never completes or writes', async () => {
    const evaluate = vi.fn(async () => ({ result: { value: { email_address: 'x@y.z' } } }))
    _setCdpForTest(makeCdp({ targets: [LOGIN], infoUrl: () => 'https://claude.ai/login', cookies: () => [sessionCookie], evaluate }))
    const s = await runSignIn({ ...RUN })
    expect(s.phase).toBe('failed')
    expect(cookiesSet).not.toHaveBeenCalled()
  })

  it('G6 the in-page expression carries its own origin gate and an origin-RELATIVE fetch', async () => {
    const evaluate = vi.fn(async () => ({ result: { value: 'x@y.z' } }))
    _setCdpForTest(makeCdp({ targets: [LOGIN], infoUrl: () => 'https://claude.ai/login', cookies: () => [sessionCookie], evaluate }))
    const s = await runSignIn({ ...RUN, timeoutMs: 1000 })
    expect(s.phase).toBe('done')
    expect(evaluate).toHaveBeenCalledTimes(1)
    const call = evaluate.mock.calls[0][0] as { expression: string }
    expect(call.expression).toMatch(/location\.origin === 'https:\/\/claude\.ai'/)
    expect(call.expression).toMatch(/location\.origin === 'https:\/\/www\.claude\.ai'/)
    expect(call.expression).toMatch(/fetch\('\/api\/bootstrap'/)
    expect(call.expression).not.toMatch(/https?:\/\/[^']*\/api\/bootstrap/)
  })

  it('G7 the Cloudflare notice is a hint, not a gate: a spoofed challenge page is never connected', async () => {
    const connected: any[] = []
    const evaluate = vi.fn(async () => ({ result: { value: 'x@y.z' } }))
    const spoof = { type: 'page', url: 'https://evil.example/cdn-cgi/challenge-platform/x', title: 'Just a moment...', id: 'sp', webSocketDebuggerUrl: 'ws://sp' }
    const spoof2 = { type: 'page', url: 'https://challenges.cloudflare.com/turnstile/v0/x', id: 'sp2', webSocketDebuggerUrl: 'ws://sp2' }
    _setCdpForTest(makeCdp({ targets: [LOGIN, spoof, spoof2], infoUrl: () => 'https://claude.ai/login', cookies: () => [], evaluate, onConnect: (a) => connected.push(a.target) }))
    const run = runSignIn({ ...RUN, timeoutMs: 150 })
    await new Promise((r) => setTimeout(r, 60))
    const mid = getSignInState()
    await run
    expect(mid.phase).toBe('awaiting-user')
    expect(mid.notice).toBeUndefined()
    expect(connected.length).toBeGreaterThan(0)
    expect(connected.every((t) => t === 'ws://t1')).toBe(true)
    expect(evaluate).not.toHaveBeenCalled()
  })

  it('G8 cookie write: only claude.ai-domain cookies reach the partition when the jar carries decoys', async () => {
    const evaluate = vi.fn(async () => ({ result: { value: 'x@y.z' } }))
    const jar = [
      sessionCookie,
      { ...sessionCookie, domain: 'claude.ai.evil.example' },
      { ...sessionCookie, name: 'idp', domain: '.idp.example' },
      { ...sessionCookie, name: 'other', domain: 'claude.ai' },
      { ...sessionCookie, name: 'sub', domain: '.api.claude.ai' },
    ]
    _setCdpForTest(makeCdp({ targets: [LOGIN], infoUrl: () => 'https://claude.ai/login', cookies: () => jar, evaluate }))
    const s = await runSignIn({ ...RUN, timeoutMs: 1000 })
    expect(s.phase).toBe('done')
    const domains = cookiesSet.mock.calls.map((c: any[]) => c[0].domain)
    expect(domains).toEqual(['.claude.ai', 'claude.ai'])
  })
})
