// [host] WP2 PR 4, P4.6 second half (row 58): a Codex account's chatgpt.com
// sign-in window, fail-closed.
//
// What this pins (ADR-009 surface):
//  - the per-service descriptor: chatgpt.com's start and sign-in pages, and an
//    EXPLICIT off-site host list (never "any https host");
//  - completion is conjunctive and fails closed: the named session cookie AND a
//    valid email from the identity read; a signed-out jar never completes, and a
//    cookie without an email never completes either (no grace for Codex);
//  - the identity read returns ONLY the email: run against a fixture that also
//    holds a token, nothing but the email string crosses the boundary;
//  - the window's navigation: chatgpt.com and the listed sign-in hosts only for
//    the main frame, https for a sub-frame, popups denied, permissions denied;
//  - each run owns its window: a Claude cancel never closes a Codex window, and
//    a Codex cancel never closes Claude's;
//  - a run that does not complete wipes the partition and logs cookie NAMES and
//    off-site HOSTS only (never values, never query strings);
//  - one sign-in at a time across both services; clear and the archive hook.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import vm from 'node:vm'

// ---- a controllable Electron: windows, partitions, an isolated-world eval ----
let uaValue = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) AI Code Conductor/2.1.0 Chrome/128.0.0.0 Electron/33.0.0 Safari/537.36'
interface FakeCookie { name: string; value?: string; expirationDate?: number; session?: boolean }
const jars: Record<string, FakeCookie[]> = {}
const cookieGets: Array<{ partition: string; filter: Record<string, unknown> }> = []
let onCookiesGet: ((n: number, partition: string) => void) | null = null
const clears: Array<{ partition: string; what: 'storage' | 'cache' }> = []
let failClear: string | null = null
/** One ordered trail of what happened, for the order guarantees. */
const events: string[] = []
/** Holds clearStorageData open until released (a wipe in flight). */
let clearGate: Promise<void> | null = null
const sessionEvents: Record<string, Record<string, Function>> = {}
const fromPartition = vi.fn((partition: string) => ({
  getUserAgent: () => uaValue,
  setUserAgent: (v: string) => { uaValue = v },
  on: (ev: string, fn: Function) => { (sessionEvents[partition] ??= {})[ev] = fn },
  cookies: {
    get: vi.fn(async (filter: Record<string, unknown>) => {
      cookieGets.push({ partition, filter })
      onCookiesGet?.(cookieGets.filter((g) => g.partition === partition).length, partition)
      const all = jars[partition] ?? []
      return typeof filter?.name === 'string' ? all.filter((c) => c.name === filter.name) : [...all]
    }),
  },
  clearStorageData: vi.fn(async () => {
    events.push('clear storage')
    if (clearGate) await clearGate
    if (failClear === partition) throw new Error('simulated wipe failure')
    clears.push({ partition, what: 'storage' })
  }),
  clearCache: vi.fn(async () => { clears.push({ partition, what: 'cache' }) }),
}))

/** What the page answers: its origin and its identity endpoint's JSON. */
const page = {
  origin: 'https://chatgpt.com',
  identity: null as unknown,
  fetched: [] as Array<{ url: string; opts: unknown }>,
  onFetch: null as null | (() => void),
  status: 200,
}
function evalInPage(code: string): unknown {
  const ctx = vm.createContext({
    location: { origin: page.origin },
    fetch: (url: string, opts: unknown) => {
      page.fetched.push({ url, opts })
      page.onFetch?.()
      const body = page.identity
      return Promise.resolve({ status: page.status, json: () => Promise.resolve(body), text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)) })
    },
  })
  return vm.runInContext(code, ctx)
}

const created: FakeWin[] = []
let throwOnPermission = false
class FakeWin {
  opts: Record<string, any>
  destroyed = false
  handlers: Record<string, Function> = {}
  permHandlers: Function[] = []
  private closedCb?: () => void
  webContents: Record<string, any>
  isolatedWorlds: number[] = []
  constructor(opts: Record<string, any>) {
    this.opts = opts
    this.webContents = {
      on: (ev: string, fn: Function) => { this.handlers[ev] = fn },
      setWindowOpenHandler: (fn: Function) => { this.handlers.__open = fn },
      session: { setPermissionRequestHandler: (fn: Function) => { if (throwOnPermission) throw new Error('simulated Electron failure after the window'); this.permHandlers.push(fn) } },
      executeJavaScriptInIsolatedWorld: async (world: number, scripts: Array<{ code: string }>) => {
        this.isolatedWorlds.push(world)
        return evalInPage(scripts[0].code)
      },
      executeJavaScript: async (code: string) => evalInPage(code),
      isDestroyed: () => this.destroyed,
    }
    created.push(this)
  }
  loadURL = vi.fn(async () => {})
  isDestroyed() { return this.destroyed }
  destroy() { if (!this.destroyed) events.push('window destroyed'); this.destroyed = true; this.closedCb?.() }
  on(ev: string, fn: () => void) { if (ev === 'closed') this.closedCb = fn }
  userClose() { this.destroyed = true; this.closedCb?.() }
}

vi.mock('electron', () => ({ BrowserWindow: FakeWin, session: { fromPartition } }))
const logs: string[] = []
vi.mock('../../src/main/debug-logger', () => ({
  logInfo: (...a: unknown[]) => { logs.push(a.map(String).join(' ')) },
  logError: (...a: unknown[]) => { logs.push(a.map(String).join(' ')) },
}))

const {
  CODEX_WEB_SERVICE, webPartitionForCodexAccount, httpsDefaultPortHost, isWebServiceUrl, isWebServiceSignInHop,
  webServiceSessionFromCookies,
} = await import('../../src/shared/account-web-session')
const { serviceEmailExpression, readServiceAccountEmail, serviceIdentityShapeExpression } = await import('../../src/main/account-web/account-email-read')
const {
  runServiceSignIn, runInAppSignIn, closeInAppSignInWindow, createSignInWindowHandle, signInNavAllowed,
} = await import('../../src/main/account-web/in-app-sign-in')
const {
  runCodexWebSignIn, cancelCodexWebSignIn, clearCodexWebSession, getCodexWebSignInState, onCodexWebSessionCleared,
  onCodexWebSessionClosing, prepareCodexWebArchive, isCodexWebArchiving, isCodexWebClearing, discardCodexWebRun,
  _resetCodexWebForTest,
} = await import('../../src/main/account-web/codex-web-session')
const { registerSignInFlight, signInInFlightElsewhere } = await import('../../src/main/account-web/sign-in-flight')

const ACCT = 'acct-0123456789abcdef'
const OTHER = 'acct-fedcba9876543210'
const PART = webPartitionForCodexAccount(ACCT)
const SESSION_TOKEN = '__Secure-next-auth.session-token'
const IDENTITY = {
  user: { id: 'user-abc', name: 'Me', email: 'me@example.com', image: 'https://x.example/a.png' },
  expires: '2030-01-01T00:00:00.000Z',
  accessToken: 'eyJhbGciOi.SECRET-ACCESS-TOKEN.sig',
  authProvider: 'openai',
}
/** A signed-out visit's jar (names illustrative: PB7 recorded no names). */
const SIGNED_OUT_JAR: FakeCookie[] = [
  { name: '__cf_bm', value: 'cf' }, { name: '_cfuvid', value: 'u' }, { name: 'oai-did', value: 'd' },
  { name: '__Host-next-auth.csrf-token', value: 'csrf' }, { name: '__Secure-next-auth.callback-url', value: 'cb' },
]
const SIGNED_IN_JAR: FakeCookie[] = [...SIGNED_OUT_JAR, { name: SESSION_TOKEN, value: 'SESSION-SECRET-VALUE', expirationDate: 1_900_000_000 }]

let claudeBusy = false
beforeEach(() => {
  created.length = 0
  for (const k of Object.keys(jars)) delete jars[k]
  cookieGets.length = 0
  clears.length = 0
  logs.length = 0
  onCookiesGet = null
  failClear = null
  page.origin = 'https://chatgpt.com'
  page.identity = null
  page.fetched.length = 0
  page.onFetch = null
  page.status = 200
  events.length = 0
  clearGate = null
  throwOnPermission = false
  for (const k of Object.keys(sessionEvents)) delete sessionEvents[k]
  fromPartition.mockClear()
  claudeBusy = false
  registerSignInFlight('claude', () => claudeBusy)
  closeInAppSignInWindow()
  _resetCodexWebForTest()
})

const flush = () => new Promise((r) => setTimeout(r, 0))
const tick = (ms = 15) => new Promise((r) => setTimeout(r, ms))

describe('[host] the chatgpt.com descriptor', () => {
  it('names chatgpt.com, its start and sign-in pages (PB7), and an explicit off-site host list', () => {
    expect(CODEX_WEB_SERVICE.service).toBe('codex')
    expect(CODEX_WEB_SERVICE.label).toBe('chatgpt.com')
    expect(CODEX_WEB_SERVICE.origin).toBe('https://chatgpt.com')
    expect(CODEX_WEB_SERVICE.hosts).toEqual(['chatgpt.com'])
    expect(CODEX_WEB_SERVICE.startUrl).toBe('https://chatgpt.com/')
    expect(CODEX_WEB_SERVICE.signInUrl).toBe('https://chatgpt.com/auth/login')
    expect(CODEX_WEB_SERVICE.signInHosts.length).toBeGreaterThan(0)
    for (const h of CODEX_WEB_SERVICE.signInHosts) {
      // Plain host names only: no scheme, no wildcard, no port, no path.
      expect(h, h).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/)
    }
    expect(CODEX_WEB_SERVICE.sessionCookieNames.length).toBeGreaterThan(0)
    expect(Object.isFrozen(CODEX_WEB_SERVICE)).toBe(true)
  })

  it('reads a URL host only for https on the default port, lower-cased, one trailing dot dropped', () => {
    expect(httpsDefaultPortHost('https://ChatGPT.com./c/1')).toBe('chatgpt.com')
    expect(httpsDefaultPortHost('https://chatgpt.com@evil.example/')).toBe('evil.example')
    for (const bad of ['http://chatgpt.com/', 'https://chatgpt.com:444/', 'javascript:alert(1)', 'file:///C:/x', 'not a url', '', undefined, 7]) {
      expect(httpsDefaultPortHost(bad as never), String(bad)).toBeNull()
    }
  })

  it('a service URL is chatgpt.com exactly; a sign-in hop is a listed host exactly', () => {
    expect(isWebServiceUrl(CODEX_WEB_SERVICE, 'https://chatgpt.com/auth/login')).toBe(true)
    for (const bad of [
      'https://chatgpt.com.evil.example/', 'https://evil.example/?next=https://chatgpt.com', 'https://sub.chatgpt.com.evil/', 'http://chatgpt.com/',
      // Exact host: neither a name ending in it nor a subdomain of it.
      'https://evilchatgpt.com/', 'https://x.chatgpt.com/', 'https://www.chatgpt.com/',
    ]) {
      expect(isWebServiceUrl(CODEX_WEB_SERVICE, bad), bad).toBe(false)
      expect(signInNavAllowed(CODEX_WEB_SERVICE, bad, true), bad).toBe(false)
    }
    for (const host of CODEX_WEB_SERVICE.signInHosts) {
      expect(isWebServiceSignInHop(CODEX_WEB_SERVICE, `https://${host}/x?y=1`), host).toBe(true)
      expect(isWebServiceSignInHop(CODEX_WEB_SERVICE, `https://evil.${host}/`), host).toBe(false)
      expect(isWebServiceSignInHop(CODEX_WEB_SERVICE, `http://${host}/`), host).toBe(false)
      expect(isWebServiceSignInHop(CODEX_WEB_SERVICE, `https://${host}:8443/`), host).toBe(false)
    }
    expect(isWebServiceSignInHop(CODEX_WEB_SERVICE, 'https://evil.example/')).toBe(false)
  })
})

describe('[host] the completion predicate (pure)', () => {
  it('a signed-out jar is not signed in', () => {
    expect(webServiceSessionFromCookies(CODEX_WEB_SERVICE, SIGNED_OUT_JAR)).toEqual({ hasSessionCookie: false, expiresAt: null })
    expect(webServiceSessionFromCookies(CODEX_WEB_SERVICE, [])).toEqual({ hasSessionCookie: false, expiresAt: null })
  })

  it('the named session cookie is the signal, its expiry the session lifetime (seconds to ms)', () => {
    expect(webServiceSessionFromCookies(CODEX_WEB_SERVICE, SIGNED_IN_JAR)).toEqual({ hasSessionCookie: true, expiresAt: 1_900_000_000_000 })
    expect(webServiceSessionFromCookies(CODEX_WEB_SERVICE, [{ name: SESSION_TOKEN, session: true }])).toEqual({ hasSessionCookie: true, expiresAt: null })
    // A large token is split into numbered chunks.
    expect(webServiceSessionFromCookies(CODEX_WEB_SERVICE, [{ name: `${SESSION_TOKEN}.0` }]).hasSessionCookie).toBe(true)
  })

  it('near-miss names are not the session cookie (fails closed)', () => {
    for (const name of [`${SESSION_TOKEN}-x`, 'next-auth.session-token', '__Host-next-auth.session-token', `${SESSION_TOKEN}.1`, 'sessionKey', SESSION_TOKEN.toUpperCase()]) {
      expect(webServiceSessionFromCookies(CODEX_WEB_SERVICE, [{ name }]).hasSessionCookie, name).toBe(false)
    }
  })
})

describe('[host] the identity read returns ONLY the email', () => {
  it('against a fixture that also holds a token, the answer is the email string and nothing else', async () => {
    page.identity = IDENTITY
    const out = await evalInPage(serviceEmailExpression(CODEX_WEB_SERVICE))
    expect(out).toBe('me@example.com')
    expect(typeof out).toBe('string')
    expect(page.fetched).toHaveLength(1)
    expect(page.fetched[0].url).toBe('/api/auth/session')
    expect(page.fetched[0].opts).toMatchObject({ credentials: 'include', cache: 'no-store' })
  })

  it('the expression never names the token, keeps nothing global, and is origin-gated inside itself', async () => {
    const expr = serviceEmailExpression(CODEX_WEB_SERVICE)
    expect(expr).not.toMatch(/accessToken|console|localStorage|sessionStorage|window\./)
    // No globals left behind in the page's world.
    page.identity = IDENTITY
    const ctx = vm.createContext({ location: { origin: 'https://chatgpt.com' }, fetch: () => Promise.resolve({ json: () => Promise.resolve(IDENTITY) }) })
    const before = Object.keys(ctx).sort()
    expect(await vm.runInContext(expr, ctx)).toBe('me@example.com')
    expect(Object.keys(ctx).sort()).toEqual(before)
    // Another origin: no fetch at all, null.
    page.origin = 'https://evil.example'
    expect(await evalInPage(expr)).toBeNull()
    expect(page.fetched).toHaveLength(0)
  })

  it('anything other than a string email at that path is null', async () => {
    const expr = serviceEmailExpression(CODEX_WEB_SERVICE)
    for (const identity of [null, {}, { user: null }, { user: {} }, { user: { email: { value: 'x@y.z' } } }, { user: { email: 7 } }, { email: 'top@level.example' }, 'string']) {
      page.identity = identity
      expect(await evalInPage(expr), JSON.stringify(identity)).toBeNull()
    }
  })

  it('reads in an isolated world and validates the shape: a token-shaped answer is refused', async () => {
    const win = new FakeWin({})
    page.identity = IDENTITY
    expect(await readServiceAccountEmail(win.webContents as never, CODEX_WEB_SERVICE)).toBe('me@example.com')
    expect(win.isolatedWorlds).toEqual([1])
    page.identity = { user: { email: 'eyJhbGciOi.SECRET-ACCESS-TOKEN.sig' } }
    expect(await readServiceAccountEmail(win.webContents as never, CODEX_WEB_SERVICE)).toBeNull()
    page.identity = { user: { email: 'spoof\u202e@example.com' } }
    expect(await readServiceAccountEmail(win.webContents as never, CODEX_WEB_SERVICE)).toBeNull()
  })
})

describe('[host] the sign-in window navigation (pure)', () => {
  const allowed = (url: string, isMainFrame?: boolean) => signInNavAllowed(CODEX_WEB_SERVICE, url, isMainFrame)
  it('the main frame may go to chatgpt.com and the listed sign-in hosts, nowhere else', () => {
    expect(allowed('https://chatgpt.com/auth/login', true)).toBe(true)
    for (const host of CODEX_WEB_SERVICE.signInHosts) expect(allowed(`https://${host}/authorize?x=1`, true), host).toBe(true)
    for (const bad of [
      'https://evil.example/', 'https://chatgpt.com.evil.example/', 'http://chatgpt.com/', 'https://chatgpt.com:444/',
      'javascript:alert(1)', 'file:///C:/x', 'data:text/html,x', 'https://login.microsoftonline.com/x',
    ]) {
      expect(allowed(bad, true), bad).toBe(false)
    }
  })

  it('an event that does not say it is a sub-frame is treated as the main frame', () => {
    expect(allowed('https://evil.example/')).toBe(false)
  })

  it('a sub-frame is left to same-origin policy but must be https', () => {
    expect(allowed('https://challenges.cloudflare.com/x', false)).toBe(true)
    expect(allowed('http://challenges.cloudflare.com/x', false)).toBe(false)
    expect(allowed('file:///C:/x', false)).toBe(false)
  })
})

const RUN = (over: Record<string, unknown> = {}) => ({
  service: CODEX_WEB_SERVICE, ownerId: ACCT, partition: PART, handle: createSignInWindowHandle(),
  timeoutMs: 2000, pollMs: 5, shouldCancel: () => false, ...over,
})

describe('[host] the sign-in window', () => {
  it('opens on that account partition, hardened, presenting a Chrome UA, on the sign-in page', async () => {
    jars[PART] = SIGNED_IN_JAR
    page.identity = IDENTITY
    const res = await runServiceSignIn(RUN())
    expect(res.ok).toBe(true)
    expect(fromPartition).toHaveBeenCalledWith(PART)
    const w = created[0]
    expect(w.opts.title).toBe('Sign in to chatgpt.com')
    expect(w.loadURL).toHaveBeenCalledWith('https://chatgpt.com/auth/login')
    const wp = w.opts.webPreferences
    expect(wp).toMatchObject({ partition: PART, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false })
    expect(wp.preload).toBeUndefined()
    expect(uaValue).not.toContain('Electron')
    // Permissions denied; popups denied.
    const cb = vi.fn()
    w.permHandlers[0](null, 'media', cb)
    expect(cb).toHaveBeenCalledWith(false)
    expect(w.handlers.__open({ url: 'https://accounts.google.com/x' })).toEqual({ action: 'deny' })
    expect(w.handlers.__open({ url: 'https://chatgpt.com/x' })).toEqual({ action: 'deny' })
    expect(w.destroyed).toBe(true)
  })

  it('completes with the email and the session lifetime when the cookie AND the identity both answer', async () => {
    jars[PART] = SIGNED_IN_JAR
    page.identity = IDENTITY
    const res = await runServiceSignIn(RUN())
    expect(res).toMatchObject({ ok: true, email: 'me@example.com', expiresAt: 1_900_000_000_000 })
    expect(JSON.stringify(res)).not.toContain('SECRET')
  })

  it('a signed-out jar never completes, however long it waits', async () => {
    jars[PART] = SIGNED_OUT_JAR
    page.identity = IDENTITY
    const res = await runServiceSignIn(RUN({ timeoutMs: 80 }))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Timed out/)
    expect(created[0].destroyed).toBe(true)
  })

  it('the session cookie WITHOUT an email never completes (no grace for this service)', async () => {
    vi.useFakeTimers()
    try {
      jars[PART] = SIGNED_IN_JAR
      page.identity = { user: {} }
      let settled: { ok: boolean; error?: string } | null = null
      void runServiceSignIn(RUN({ timeoutMs: 10_000, pollMs: 50 })).then((r) => { settled = r })
      // Well past the 4 s grace a service with an optional email allows: the
      // run keeps waiting for the email, neither completing nor giving up.
      await vi.advanceTimersByTimeAsync(6_000)
      expect(settled).toBeNull()
      expect(created[0].destroyed).toBe(false)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(settled).toMatchObject({ ok: false, error: expect.stringMatching(/Timed out/) })
      expect(created[0].destroyed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('an identity read off chatgpt.com never counts (the page is elsewhere)', async () => {
    jars[PART] = SIGNED_IN_JAR
    page.identity = IDENTITY
    page.origin = 'https://auth.openai.com'
    const res = await runServiceSignIn(RUN({ timeoutMs: 80 }))
    expect(res.ok).toBe(false)
  })

  it('does not complete if the cookie vanishes during the identity read (the sign-out race)', async () => {
    jars[PART] = SIGNED_IN_JAR
    page.identity = IDENTITY
    // The first read sees the cookie; a sign-out empties the jar DURING the
    // identity read, so the recheck after it does not.
    page.onFetch = () => { jars[PART] = SIGNED_OUT_JAR }
    const res = await runServiceSignIn(RUN({ timeoutMs: 120 }))
    expect(res.ok).toBe(false)
  })

  it('does not complete if cancel lands during the recheck read', async () => {
    jars[PART] = SIGNED_IN_JAR
    page.identity = IDENTITY
    let cancel = false
    onCookiesGet = (n) => { if (n === 2) cancel = true }
    const res = await runServiceSignIn(RUN({ shouldCancel: () => cancel }))
    expect(res).toMatchObject({ ok: false, cancelled: true })
    expect(created[0].destroyed).toBe(true)
  })

  it('wires the navigation guard on will-navigate and will-redirect', async () => {
    jars[PART] = SIGNED_OUT_JAR
    const p = runServiceSignIn(RUN({ timeoutMs: 60 }))
    await tick(5)
    const w = created[0]
    for (const ev of ['will-navigate', 'will-redirect']) {
      const ok = { preventDefault: vi.fn(), isMainFrame: true }
      w.handlers[ev](ok, `https://${CODEX_WEB_SERVICE.signInHosts[0]}/authorize`)
      expect(ok.preventDefault, ev).not.toHaveBeenCalled()
      const own = { preventDefault: vi.fn(), isMainFrame: true }
      w.handlers[ev](own, 'https://chatgpt.com/')
      expect(own.preventDefault, ev).not.toHaveBeenCalled()
      const off = { preventDefault: vi.fn(), isMainFrame: true }
      w.handlers[ev](off, 'https://evil.example/landing')
      expect(off.preventDefault, ev).toHaveBeenCalled()
      const noFlag = { preventDefault: vi.fn() }
      w.handlers[ev](noFlag, 'https://evil.example/landing')
      expect(noFlag.preventDefault, ev).toHaveBeenCalled()
      const sub = { preventDefault: vi.fn(), isMainFrame: false }
      w.handlers[ev](sub, 'https://challenges.cloudflare.com/turnstile')
      expect(sub.preventDefault, ev).not.toHaveBeenCalled()
      const badSub = { preventDefault: vi.fn(), isMainFrame: false }
      w.handlers[ev](badSub, 'file:///C:/secrets')
      expect(badSub.preventDefault, ev).toHaveBeenCalled()
    }
    await p
  })

  it('a run that does not complete logs cookie NAMES and off-site HOSTS, never values or query strings', async () => {
    jars[PART] = [...SIGNED_OUT_JAR, { name: 'bad name\u0007', value: 'x' }, { name: 'oai-sc', value: 'COOKIE-VALUE-SECRET' }]
    const p = runServiceSignIn(RUN({ timeoutMs: 60 }))
    await tick(5)
    const w = created[0]
    w.handlers['will-navigate']({ preventDefault: vi.fn(), isMainFrame: true }, 'https://evil.example/landing?token=QUERY-SECRET#frag')
    w.handlers['will-redirect']({ preventDefault: vi.fn(), isMainFrame: true }, `https://${CODEX_WEB_SERVICE.signInHosts[0]}/authorize?client_id=QUERY-SECRET`)
    w.handlers.__open({ url: 'https://popup.example/x?code=QUERY-SECRET' })
    const res = await p
    expect(res.ok).toBe(false)
    const diag = logs.filter((l) => /did not complete/.test(l))
    expect(diag).toHaveLength(1)
    const line = diag[0]
    expect(line).toContain('__cf_bm')
    expect(line).toContain('oai-sc')
    expect(line).toContain('evil.example (blocked)')
    expect(line).toContain(`${CODEX_WEB_SERVICE.signInHosts[0]} (allowed)`)
    expect(line).toContain('popup.example (popup denied)')
    expect(line).not.toMatch(/SECRET|token=|client_id|\?|#/)
    expect(line).not.toContain('\u0007')
    // Every log line of the run, not just the diagnostic, is clean.
    for (const l of logs) expect(l).not.toMatch(/SECRET/)
  })

  it('a run whose identity read finds no email logs the answer\'s HTTP status and key NAMES, never a value', async () => {
    jars[PART] = SIGNED_IN_JAR
    // The email sits somewhere else than the descriptor says: the line must
    // show where, without showing it.
    page.identity = { user: { id: 'user-abc', name: 'Me', mail: 'me@example.com' }, accessToken: 'eyJ.SECRET-ACCESS-TOKEN.sig', expires: '2030-01-01' }
    const res = await runServiceSignIn(RUN({ timeoutMs: 80 }))
    expect(res.ok).toBe(false)
    const line = logs.find((l) => /did not complete/.test(l))!
    expect(line).toContain('Session cookie seen: yes.')
    expect(line).toMatch(/Identity reads: [1-9]\d*, none gave an email\./)
    expect(line).toContain('Identity answer: HTTP 200, JSON keys user, user.id, user.name, user.mail, accessToken, expires; an email-shaped value at user.mail.')
    expect(line).toContain(SESSION_TOKEN)
    for (const value of ['me@example.com', 'user-abc', 'SECRET', '2030-01-01', 'Me,']) expect(line, value).not.toContain(value)
    for (const l of logs) expect(l).not.toMatch(/SECRET|me@example\.com/)
  })

  it('a run whose session cookie never matched still reads the identity answer\'s shape before the window closes', async () => {
    jars[PART] = [...SIGNED_OUT_JAR, { name: 'session-under-another-name', value: 'SECRET' }]
    page.identity = IDENTITY
    page.status = 200
    const res = await runServiceSignIn(RUN({ timeoutMs: 60 }))
    expect(res.ok).toBe(false)
    const line = logs.find((l) => /did not complete/.test(l))!
    expect(line).toContain('Session cookie seen: no.')
    expect(line).toContain('Identity reads: none (the session cookie was never seen).')
    expect(line).toContain('JSON keys user, user.id, user.name, user.email, user.image, expires, accessToken, authProvider; an email-shaped value at user.email.')
    expect(line).toContain('session-under-another-name')
    expect(line).not.toMatch(/SECRET|me@example\.com/)
  })

  it('a key name that is not a plain name (an email used as a key, say) is dropped, never logged', async () => {
    jars[PART] = SIGNED_IN_JAR
    page.identity = { accounts: { 'me@example.com': { plan: 'x' }, 'two words': 1, ok_key: 2 } }
    await runServiceSignIn(RUN({ timeoutMs: 60 }))
    const line = logs.find((l) => /did not complete/.test(l))!
    expect(line).toContain('JSON keys accounts, accounts.ok_key (and 2 not shown); no email-shaped value.')
    expect(line).not.toMatch(/me@example\.com|two words/)
  })

  it('the shape is read at the first identity read that finds no email, while the page is still the one that answered', async () => {
    jars[PART] = SIGNED_IN_JAR
    page.identity = { user: { id: 'u', mail: 'me@example.com' } }
    const p = runServiceSignIn(RUN({ timeoutMs: 120 }))
    await tick(40)
    // The page then moves on (a sign-in hop): it no longer answers.
    page.origin = 'https://auth.openai.com'
    await p
    const line = logs.find((l) => /did not complete/.test(l))!
    expect(line).toContain('Identity answer: HTTP 200, JSON keys user, user.id, user.mail; an email-shaped value at user.mail.')
  })

  it('a key that looks like an id or a secret is dropped and counted, never logged', async () => {
    jars[PART] = SIGNED_IN_JAR
    const HEX64 = 'ab'.repeat(32)
    page.identity = {
      user: { id: 'u', mail: 'me@example.com' },
      byId: { '123e4567-e89b-12d3-a456-426614174000': 1, 'sk-AbCdEf0123456789xyz': 2, [HEX64]: 3, '9876543210': 4, user_4f9a8b7c6d5e: 5, plan: 6 },
      byEmail: { 'me@example.com': 'other@example.com' },
    }
    await runServiceSignIn(RUN({ timeoutMs: 60 }))
    const line = logs.find((l) => /did not complete/.test(l))!
    expect(line).toContain('JSON keys user, user.id, user.mail, byId, byId.plan, byEmail (and 6 not shown); an email-shaped value at user.mail.')
    for (const k of ['123e4567', 'sk-AbCdEf', HEX64.slice(0, 16), '9876543210', '4f9a8b7c6d5e', 'me@example.com']) expect(line, k).not.toContain(k)
  })

  it('a first read while the page is off chatgpt.com is not the last: a later read on it answers', async () => {
    jars[PART] = SIGNED_IN_JAR
    // The cookie is set while the page is still on the sign-in host.
    page.origin = 'https://auth.openai.com'
    page.identity = { user: { id: 'u', mail: 'me@example.com' } }
    const p = runServiceSignIn(RUN({ timeoutMs: 200 }))
    await tick(40)
    page.origin = 'https://chatgpt.com'
    await tick(40)
    // Off again before the close: only a look taken while it was on answers.
    page.origin = 'https://auth.openai.com'
    await p
    const line = logs.find((l) => /did not complete/.test(l))!
    expect(line).toContain('Identity answer: HTTP 200, JSON keys user, user.id, user.mail; an email-shaped value at user.mail.')
  })

  it('an answer from a signed-out page is not the last word: the read before the close takes a newer one', async () => {
    jars[PART] = SIGNED_OUT_JAR
    page.identity = {}
    const p = runServiceSignIn(RUN({ timeoutMs: 120 }))
    await tick(40)
    page.identity = { user: { id: 'u', mail: 'me@example.com' } }
    await p
    const line = logs.find((l) => /did not complete/.test(l))!
    expect(line).toContain('Identity answer: HTTP 200, JSON keys user, user.id, user.mail; an email-shaped value at user.mail.')
  })

  it('Cancel reads the identity answer before its window closes', async () => {
    jars[PART] = SIGNED_OUT_JAR
    page.origin = 'https://auth.openai.com'
    page.identity = { user: { id: 'u', mail: 'me@example.com' } }
    const run = runCodexWebSignIn({ accountId: ACCT, timeoutMs: 5_000, pollMs: 5 })
    await tick(30)
    // The page reaches chatgpt.com and the user cancels at once.
    page.origin = 'https://chatgpt.com'
    cancelCodexWebSignIn(ACCT)
    expect((await run).phase).toBe('failed')
    const line = logs.find((l) => /did not complete/.test(l))!
    expect(line).toContain('Identity answer: HTTP 200, JSON keys user, user.id, user.mail; an email-shaped value at user.mail.')
    expect(created[0].destroyed).toBe(true)
  })

  it('a status that is not an HTTP status reads as no answer', async () => {
    jars[PART] = SIGNED_IN_JAR
    // No email where the descriptor looks, so the run does not complete.
    page.identity = { user: { id: 'u' } }
    page.status = 0
    await runServiceSignIn(RUN({ timeoutMs: 60 }))
    const line = logs.find((l) => /did not complete/.test(l))!
    expect(line).toContain('Identity answer: no answer from the page.')
    expect(line).not.toContain('HTTP 0')
  })

  it('an identity answer from a page off chatgpt.com is never read, and the line says so', async () => {
    jars[PART] = SIGNED_IN_JAR
    page.identity = IDENTITY
    page.origin = 'https://auth.openai.com'
    await runServiceSignIn(RUN({ timeoutMs: 60 }))
    expect(page.fetched).toHaveLength(0)
    expect(logs.find((l) => /did not complete/.test(l))).toContain('Identity answer: not read; the page was not on https://chatgpt.com when asked.')
  })

  it('the shape read is origin-gated, returns only the status and key names, and leaves nothing global', async () => {
    const expr = serviceIdentityShapeExpression(CODEX_WEB_SERVICE)
    expect(expr).not.toMatch(/accessToken|console|localStorage|window\./)
    page.identity = IDENTITY
    page.fetched.length = 0
    const out = await evalInPage(expr) as { status: number; json: boolean; keys: string[] }
    // Uncached, as the email read: the answer leaves no copy in the HTTP cache.
    expect(page.fetched).toHaveLength(1)
    expect(page.fetched[0].opts).toMatchObject({ credentials: 'include', cache: 'no-store' })
    expect(JSON.parse(JSON.stringify(out))).toEqual({ status: 200, json: true, keys: ['user', 'user.id', 'user.name', 'user.email', 'user.image', 'expires', 'accessToken', 'authProvider'], emailAt: ['user.email'] })
    expect(JSON.stringify(out)).not.toMatch(/me@example|SECRET|user-abc/)
    // Off the service: a constant, so the caller can tell "elsewhere" from "no answer".
    page.origin = 'https://evil.example'
    expect(await evalInPage(expr)).toBe('off-origin')
  })

  it('a completed run logs no diagnostic and never logs a value', async () => {
    jars[PART] = SIGNED_IN_JAR
    page.identity = IDENTITY
    expect((await runServiceSignIn(RUN())).ok).toBe(true)
    expect(logs.some((l) => /did not complete/.test(l))).toBe(false)
    for (const l of logs) expect(l).not.toMatch(/SECRET/)
  })

  it('the user closing the window fails the run', async () => {
    jars[PART] = SIGNED_OUT_JAR
    const p = runServiceSignIn(RUN())
    await tick(5)
    created[0].userClose()
    const res = await p
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/closed/)
  })
})

describe('[host] each run owns its own window', () => {
  it("a Claude cancel never closes a Codex window, and a Codex cancel never closes Claude's", async () => {
    jars[PART] = SIGNED_OUT_JAR
    jars['persist:claude-web-profile-web1'] = []
    const codex = runCodexWebSignIn({ accountId: ACCT, timeoutMs: 400, pollMs: 5 })
    const claude = runInAppSignIn({ profileId: 'profile-web1', partition: 'persist:claude-web-profile-web1', timeoutMs: 400, pollMs: 5, shouldCancel: () => false })
    await tick(10)
    const codexWin = created.find((w) => w.opts.webPreferences.partition === PART)!
    const claudeWin = created.find((w) => w.opts.webPreferences.partition === 'persist:claude-web-profile-web1')!
    expect(codexWin && claudeWin).toBeTruthy()
    // Claude's own close (cancel, sign-out) takes Claude's window only.
    closeInAppSignInWindow()
    expect(claudeWin.destroyed).toBe(true)
    expect(codexWin.destroyed).toBe(false)
    await claude
    // Re-open a Claude window, then cancel the Codex run: Claude's stays.
    const claude2 = runInAppSignIn({ profileId: 'profile-web1', partition: 'persist:claude-web-profile-web1', timeoutMs: 400, pollMs: 5, shouldCancel: () => false })
    await tick(10)
    const claudeWin2 = created.filter((w) => w.opts.webPreferences.partition === 'persist:claude-web-profile-web1')[1]
    cancelCodexWebSignIn(ACCT)
    // The Codex run closes its own window at its next poll, after one last look.
    await tick(20)
    expect(codexWin.destroyed).toBe(true)
    expect(claudeWin2.destroyed).toBe(false)
    closeInAppSignInWindow()
    await Promise.all([codex, claude2])
  })
})

describe('[host] the Codex sign-in run', () => {
  it('completes into a metadata record: account, email, lifetime, in-app; nothing wiped', async () => {
    jars[PART] = SIGNED_IN_JAR
    page.identity = IDENTITY
    const st = await runCodexWebSignIn({ accountId: ACCT, pollMs: 5 })
    expect(st.phase).toBe('done')
    expect(st.session).toEqual({ accountId: ACCT, accountEmail: 'me@example.com', acquiredAt: expect.any(Number), expiresAt: 1_900_000_000_000, origin: 'in-app' })
    expect(JSON.stringify(st)).not.toContain('SECRET')
    expect(clears).toEqual([])
    expect(getCodexWebSignInState().phase).toBe('done')
  })

  it('refuses anything but a registry account id before building a partition', async () => {
    for (const bad of ['profile-web1', 'acct-0123', '../x', '', 'ACCT-0123456789ABCDEF']) {
      const st = await runCodexWebSignIn({ accountId: bad, pollMs: 5 })
      expect(st.phase, bad).toBe('failed')
    }
    expect(fromPartition).not.toHaveBeenCalled()
    expect(created).toHaveLength(0)
  })

  it('a run that does not complete WIPES the partition and forgets the record and panes', async () => {
    jars[PART] = SIGNED_IN_JAR
    page.identity = { user: {} } // the cookie guessed right, the identity never answers
    const cleared = vi.fn()
    onCodexWebSessionCleared(cleared)
    const st = await runCodexWebSignIn({ accountId: ACCT, timeoutMs: 60, pollMs: 5 })
    expect(st.phase).toBe('failed')
    expect(clears).toContainEqual({ partition: PART, what: 'storage' })
    expect(cleared).toHaveBeenCalledWith(ACCT)
  })

  it('one sign-in at a time, across both services', async () => {
    jars[PART] = SIGNED_OUT_JAR
    claudeBusy = true
    expect((await runCodexWebSignIn({ accountId: ACCT, pollMs: 5 })).error).toMatch(/already in progress/)
    expect(created).toHaveLength(0)
    claudeBusy = false
    const first = runCodexWebSignIn({ accountId: ACCT, timeoutMs: 200, pollMs: 5 })
    await tick(5)
    expect(signInInFlightElsewhere('claude')).toBe(true)
    expect((await runCodexWebSignIn({ accountId: OTHER, pollMs: 5 })).error).toMatch(/already in progress/)
    cancelCodexWebSignIn(ACCT)
    expect((await first).phase).toBe('failed')
    expect(signInInFlightElsewhere('claude')).toBe(false)
  })

  it('cancel is scoped to the account: another account cannot cancel this run', async () => {
    jars[PART] = SIGNED_OUT_JAR
    const run = runCodexWebSignIn({ accountId: ACCT, timeoutMs: 120, pollMs: 5 })
    await tick(5)
    cancelCodexWebSignIn(OTHER)
    await tick(20)
    expect(created[0].destroyed).toBe(false)
    cancelCodexWebSignIn(ACCT)
    expect((await run).error).toMatch(/cancelled/i)
    expect(created[0].destroyed).toBe(true)
  })
})

describe('[host] clearing a Codex web session', () => {
  it('cancels a run first, wipes storage then cache, then forgets the record and panes', async () => {
    jars[PART] = SIGNED_OUT_JAR
    const order: string[] = []
    onCodexWebSessionCleared((id) => order.push(`cleared ${id}`))
    const run = runCodexWebSignIn({ accountId: ACCT, timeoutMs: 400, pollMs: 5 })
    await tick(5)
    await clearCodexWebSession(ACCT)
    expect(created[0].destroyed).toBe(true)
    expect(clears.filter((c) => c.partition === PART).map((c) => c.what)).toContain('storage')
    expect(clears.filter((c) => c.partition === PART).map((c) => c.what)).toContain('cache')
    expect(order).toContain(`cleared ${ACCT}`)
    await run
  })

  it('a wipe that fails THROWS and leaves the record (nothing reports signed out over a live session)', async () => {
    failClear = PART
    const cleared = vi.fn()
    onCodexWebSessionCleared(cleared)
    await expect(clearCodexWebSession(ACCT)).rejects.toThrow(/simulated wipe failure/)
    expect(cleared).not.toHaveBeenCalled()
  })

  it('refuses a malformed id', async () => {
    await expect(clearCodexWebSession('profile-web1')).rejects.toThrow()
    expect(fromPartition).not.toHaveBeenCalled()
  })
})

describe('[host] the archive hook', () => {
  it('does nothing for another provider', async () => {
    const release = await prepareCodexWebArchive(ACCT, 'claude')
    expect(fromPartition).not.toHaveBeenCalled()
    expect(isCodexWebArchiving(ACCT)).toBe(false)
    release()
  })

  it('bars the account, clears its web session, and lifts the bar on release', async () => {
    const release = await prepareCodexWebArchive(ACCT, 'codex')
    expect(isCodexWebArchiving(ACCT)).toBe(true)
    expect(clears).toContainEqual({ partition: PART, what: 'storage' })
    // Barred: no sign-in starts while the archive runs.
    expect((await runCodexWebSignIn({ accountId: ACCT, pollMs: 5 })).phase).toBe('failed')
    release()
    expect(isCodexWebArchiving(ACCT)).toBe(false)
  })

  it('a clear that fails rejects (the archive is refused) and leaves no bar behind', async () => {
    failClear = PART
    await expect(prepareCodexWebArchive(ACCT, 'codex')).rejects.toThrow()
    expect(isCodexWebArchiving(ACCT)).toBe(false)
    await flush()
  })
})

describe('[host] the sign-in window holds downloads, sub-frames and its own teardown', () => {
  it('blocks every download on the partition and logs the host only, never the path or query', async () => {
    jars[PART] = SIGNED_OUT_JAR
    const p = runServiceSignIn(RUN({ timeoutMs: 60 }))
    await tick(5)
    const dl = sessionEvents[PART]?.['will-download']
    expect(typeof dl).toBe('function')
    const ev = { preventDefault: vi.fn() }
    dl(ev, { getURL: () => 'https://files.example/a/b.exe?sig=QUERY-SECRET#frag' })
    expect(ev.preventDefault).toHaveBeenCalled()
    await p
    const line = logs.find((l) => /blocked a download/.test(l))!
    expect(line).toContain('files.example')
    expect(line).not.toMatch(/SECRET|\?|#|b\.exe/)
  })

  it("holds a sub-frame's own navigation to https, and leaves the main frame to will-navigate", async () => {
    jars[PART] = SIGNED_OUT_JAR
    const p = runServiceSignIn(RUN({ timeoutMs: 60 }))
    await tick(5)
    const frameNav = created[0].handlers['will-frame-navigate']
    expect(typeof frameNav).toBe('function')
    const httpSub = { preventDefault: vi.fn(), isMainFrame: false, url: 'http://ads.example/x' }
    frameNav(httpSub)
    expect(httpSub.preventDefault).toHaveBeenCalled()
    const httpsSub = { preventDefault: vi.fn(), isMainFrame: false, url: 'https://challenges.cloudflare.com/x' }
    frameNav(httpsSub)
    expect(httpsSub.preventDefault).not.toHaveBeenCalled()
    // The main frame is will-navigate's to decide (and to count): this
    // listener neither blocks it nor notes it as a sub-frame.
    const main = { preventDefault: vi.fn(), isMainFrame: true, url: 'http://main.example/' }
    frameNav(main)
    expect(main.preventDefault).not.toHaveBeenCalled()
    await p
    const line = logs.find((l) => /did not complete/.test(l))!
    expect(line).toContain('ads.example (sub-frame blocked)')
    expect(line).not.toContain('main.example')
  })

  it('a failure after the window exists still destroys the window and reports', async () => {
    throwOnPermission = true
    const res = await runServiceSignIn(RUN())
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/after the window/) })
    expect(created).toHaveLength(1)
    expect(created[0].destroyed).toBe(true)
  })
})

describe('[host] a run that does not complete is wiped, panes first, the record last', () => {
  it('Cancel wipes the partition and forgets the record', async () => {
    jars[PART] = SIGNED_OUT_JAR
    const order: string[] = []
    onCodexWebSessionClosing((id) => order.push(`panes ${id}`))
    onCodexWebSessionCleared((id) => { order.push(`record ${id}`) })
    const run = runCodexWebSignIn({ accountId: ACCT, timeoutMs: 400, pollMs: 5 })
    await tick(5)
    cancelCodexWebSignIn(ACCT)
    expect((await run).phase).toBe('failed')
    expect(clears).toContainEqual({ partition: PART, what: 'storage' })
    expect(order).toEqual([`panes ${ACCT}`, `record ${ACCT}`])
    expect(events.indexOf('window destroyed')).toBeLessThan(events.indexOf('clear storage'))
  })

  it('closing the window wipes the partition and forgets the record', async () => {
    jars[PART] = SIGNED_OUT_JAR
    const cleared = vi.fn()
    onCodexWebSessionCleared(cleared)
    const run = runCodexWebSignIn({ accountId: ACCT, timeoutMs: 400, pollMs: 5 })
    await tick(5)
    created[0].userClose()
    expect((await run).error).toMatch(/closed/)
    expect(clears).toContainEqual({ partition: PART, what: 'storage' })
    expect(cleared).toHaveBeenCalledWith(ACCT)
  })

  it('a wipe that fails keeps the record (Sign out stays offered); the panes still closed first', async () => {
    jars[PART] = SIGNED_OUT_JAR
    failClear = PART
    const closing = vi.fn()
    const cleared = vi.fn()
    onCodexWebSessionClosing(closing)
    onCodexWebSessionCleared(cleared)
    const st = await runCodexWebSignIn({ accountId: ACCT, timeoutMs: 40, pollMs: 5 })
    expect(st.phase).toBe('failed')
    expect(closing).toHaveBeenCalledWith(ACCT)
    expect(cleared).not.toHaveBeenCalled()
  })
})

describe('[host] clearing: nothing holding the session stays open through the wipe', () => {
  it('cancels the run (its window closes), closes the panes, THEN wipes, THEN forgets the record', async () => {
    jars[PART] = SIGNED_OUT_JAR
    onCodexWebSessionClosing(() => { events.push('panes closed') })
    onCodexWebSessionCleared(() => { events.push('record forgotten') })
    const run = runCodexWebSignIn({ accountId: ACCT, timeoutMs: 400, pollMs: 5 })
    await tick(5)
    await clearCodexWebSession(ACCT)
    const first = events.indexOf('clear storage')
    expect(events.slice(0, 3)).toEqual(['window destroyed', 'panes closed', 'clear storage'])
    expect(events.indexOf('record forgotten')).toBeGreaterThan(first)
    await run
  })

  it('a record that cannot be removed fails the clear (never "signed out" over a record on disk)', async () => {
    onCodexWebSessionCleared(() => false)
    await expect(clearCodexWebSession(ACCT)).rejects.toThrow(/record could not be removed/)
  })

  it('bars a new sign-in for the whole clear, and lifts the bar after it', async () => {
    let release!: () => void
    clearGate = new Promise<void>((r) => { release = r })
    const clearing = clearCodexWebSession(ACCT)
    try {
      await tick(5)
      expect(isCodexWebClearing(ACCT)).toBe(true)
      expect((await runCodexWebSignIn({ accountId: ACCT, pollMs: 5 })).error).toMatch(/being cleared/)
      expect(created).toHaveLength(0)
    } finally {
      release()
      await clearing
    }
    expect(isCodexWebClearing(ACCT)).toBe(false)
  })

  it('a clear that fails lifts its bar too', async () => {
    failClear = PART
    await expect(clearCodexWebSession(ACCT)).rejects.toThrow()
    expect(isCodexWebClearing(ACCT)).toBe(false)
  })
})

describe('[host] a finished run the IPC layer discards reads failed', () => {
  it('discardCodexWebRun turns that account\'s done state into failed, and nobody else\'s', async () => {
    jars[PART] = SIGNED_IN_JAR
    page.identity = IDENTITY
    expect((await runCodexWebSignIn({ accountId: ACCT, pollMs: 5 })).phase).toBe('done')
    discardCodexWebRun(OTHER, 'no')
    expect(getCodexWebSignInState().phase).toBe('done')
    discardCodexWebRun(ACCT, 'The account changed during the sign-in, so the session was discarded.')
    expect(getCodexWebSignInState()).toMatchObject({ phase: 'failed', accountId: ACCT })
    expect(JSON.stringify(getCodexWebSignInState())).not.toContain('me@example.com')
  })
})

describe('[host] the sign-in window lets embedded local frames load', () => {
  it('about:blank, about:srcdoc, blob: and data: load in a sub-frame; http, file and custom schemes do not', async () => {
    jars[PART] = SIGNED_OUT_JAR
    const p = runServiceSignIn(RUN({ timeoutMs: 60 }))
    await tick(5)
    const frameNav = created[0].handlers['will-frame-navigate']
    for (const url of ['about:blank', 'about:srcdoc', 'blob:https://chatgpt.com/3f2c9a1e-0000-4000-8000-000000000000', 'data:text/html,<p>hi</p>']) {
      const e = { preventDefault: vi.fn(), isMainFrame: false, url }
      frameNav(e)
      expect(e.preventDefault, url).not.toHaveBeenCalled()
      expect(signInNavAllowed(CODEX_WEB_SERVICE, url, false), url).toBe(true)
    }
    for (const url of ['http://frames.example/x', 'file:///C:/Windows/win.ini', 'ms-settings:privacy', 'javascript:alert(1)', 'about:config']) {
      const e = { preventDefault: vi.fn(), isMainFrame: false, url }
      frameNav(e)
      expect(e.preventDefault, url).toHaveBeenCalled()
    }
    // Never in the main frame: there the service and its sign-in hosts only.
    for (const url of ['about:blank', 'data:text/html,x', 'blob:https://chatgpt.com/x']) expect(signInNavAllowed(CODEX_WEB_SERVICE, url, true), url).toBe(false)
    await p
  })
})

describe('[host] the identity answer is looked at spaced and bounded while a run polls', () => {
  it('at most every 20 s, at most 15 times, and once more before the window closes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      jars[PART] = SIGNED_OUT_JAR
      // A page that answers, but never with keys: the looks go on, bounded.
      page.identity = 'not json'
      page.status = 404
      const p = runServiceSignIn(RUN({ timeoutMs: 10 * 60_000, pollMs: 1000 }))
      await vi.advanceTimersByTimeAsync(65_000)
      const early = page.fetched.length
      expect(early).toBeGreaterThanOrEqual(3)
      expect(early).toBeLessThanOrEqual(4)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      await p
      expect(page.fetched).toHaveLength(15 + 1)
      const line = logs.find((l) => /did not complete/.test(l))!
      expect(line).toContain('Identity answer: HTTP 404, not a JSON object.')
    } finally {
      vi.useRealTimers()
    }
  })
})
