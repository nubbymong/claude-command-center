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
const fromPartition = vi.fn((partition: string) => ({
  getUserAgent: () => uaValue,
  setUserAgent: (v: string) => { uaValue = v },
  cookies: {
    get: vi.fn(async (filter: Record<string, unknown>) => {
      cookieGets.push({ partition, filter })
      onCookiesGet?.(cookieGets.filter((g) => g.partition === partition).length, partition)
      const all = jars[partition] ?? []
      return typeof filter?.name === 'string' ? all.filter((c) => c.name === filter.name) : [...all]
    }),
  },
  clearStorageData: vi.fn(async () => {
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
}
function evalInPage(code: string): unknown {
  const ctx = vm.createContext({
    location: { origin: page.origin },
    fetch: (url: string, opts: unknown) => {
      page.fetched.push({ url, opts })
      page.onFetch?.()
      return Promise.resolve({ json: () => Promise.resolve(page.identity) })
    },
  })
  return vm.runInContext(code, ctx)
}

const created: FakeWin[] = []
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
      session: { setPermissionRequestHandler: (fn: Function) => { this.permHandlers.push(fn) } },
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
  destroy() { this.destroyed = true; this.closedCb?.() }
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
const { serviceEmailExpression, readServiceAccountEmail } = await import('../../src/main/account-web/account-email-read')
const {
  runServiceSignIn, runInAppSignIn, closeInAppSignInWindow, createSignInWindowHandle, signInNavAllowed,
} = await import('../../src/main/account-web/in-app-sign-in')
const {
  runCodexWebSignIn, cancelCodexWebSignIn, clearCodexWebSession, getCodexWebSignInState, onCodexWebSessionCleared,
  prepareCodexWebArchive, isCodexWebArchiving, _resetCodexWebForTest,
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
    for (const bad of ['https://chatgpt.com.evil.example/', 'https://evil.example/?next=https://chatgpt.com', 'https://sub.chatgpt.com.evil/', 'http://chatgpt.com/']) {
      expect(isWebServiceUrl(CODEX_WEB_SERVICE, bad), bad).toBe(false)
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
    jars[PART] = SIGNED_IN_JAR
    page.identity = { user: {} }
    const res = await runServiceSignIn(RUN({ timeoutMs: 80 }))
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Timed out/)
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
    expect(created[0].destroyed).toBe(false)
    cancelCodexWebSignIn(ACCT)
    expect(created[0].destroyed).toBe(true)
    expect((await run).error).toMatch(/cancelled/i)
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
