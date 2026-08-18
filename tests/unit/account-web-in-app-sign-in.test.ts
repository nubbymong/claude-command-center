// #265 follow-up — the in-app claude.ai sign-in (no launched browser, no debug
// port). Covers the pure helpers and the window flow. Electron is mocked with a
// controllable window + partition cookie store so the poll loop is exercised
// without a GPU or a real browser.
import { describe, it, expect, vi, beforeEach } from 'vitest'

let uaValue = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) AI Code Conductor/2.1.0 Chrome/128.0.0.0 Electron/33.0.0 Safari/537.36'
const setUA = vi.fn((v: string) => { uaValue = v })
let cookieResponse: Array<Record<string, unknown>> = []
let evalResult: string | null = null
let onEval: (() => void) | null = null
let cookiesGetCalls = 0
let onCookiesGet: ((call: number) => void) | null = null
let throwOnPartition = false
const cookiesGet = vi.fn(async () => { cookiesGetCalls++; onCookiesGet?.(cookiesGetCalls); return cookieResponse })
const fromPartition = vi.fn(() => {
  if (throwOnPartition) throw new Error('simulated Electron failure')
  return {
    getUserAgent: () => uaValue,
    setUserAgent: setUA,
    cookies: { get: cookiesGet },
  }
})

const created: FakeWin[] = []
const permHandlers: Array<(wc: unknown, perm: string, cb: (v: boolean) => void) => void> = []

class FakeWin {
  opts: Record<string, any>
  destroyed = false
  destroyCalls = 0
  handlers: Record<string, Function> = {}
  private closedCb?: () => void
  webContents: Record<string, any>
  constructor(opts: Record<string, any>) {
    this.opts = opts
    this.webContents = {
      on: (ev: string, fn: Function) => { this.handlers[ev] = fn },
      setWindowOpenHandler: (fn: Function) => { this.handlers.__open = fn },
      session: { setPermissionRequestHandler: (fn: any) => { permHandlers.push(fn) } },
      executeJavaScript: async () => { onEval?.(); return evalResult },
      isDestroyed: () => this.destroyed,
    }
    created.push(this)
  }
  loadURL = vi.fn(async () => {})
  isDestroyed() { return this.destroyed }
  destroy() { this.destroyed = true; this.destroyCalls++; this.closedCb?.() }
  on(ev: string, fn: () => void) { if (ev === 'closed') this.closedCb = fn }
  /** Simulate the USER closing the window. */
  userClose() { this.destroyed = true; this.closedCb?.() }
}

vi.mock('electron', () => ({
  BrowserWindow: FakeWin,
  session: { fromPartition },
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

const { runInAppSignIn, toChromeUserAgent, closeInAppSignInWindow } = await import('../../src/main/account-web/in-app-sign-in')
const { webSessionFromElectronCookies } = await import('../../src/main/account-web/cookie-harvest')

const SK = (over: Record<string, unknown> = {}) => ({ name: 'sessionKey', value: 'sk', ...over })

beforeEach(() => {
  created.length = 0
  permHandlers.length = 0
  setUA.mockClear()
  cookiesGet.mockClear()
  fromPartition.mockClear()
  cookieResponse = []
  evalResult = null
  onEval = null
  cookiesGetCalls = 0
  onCookiesGet = null
  throwOnPartition = false
  uaValue = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) AI Code Conductor/2.1.0 Chrome/128.0.0.0 Electron/33.0.0 Safari/537.36'
  closeInAppSignInWindow()
})

const RUN = { profileId: 'profile-web1', partition: 'persist:claude-web-profile-web1', timeoutMs: 2000, pollMs: 5 }

describe('toChromeUserAgent (pure)', () => {
  it('strips the Electron token and the app-name token, keeping a real Chrome UA', () => {
    const out = toChromeUserAgent(uaValue)
    expect(out).not.toContain('Electron/')
    expect(out).not.toContain('AI Code Conductor')
    expect(out).toContain('Chrome/128.0.0.0')
    expect(out).toBe('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36')
  })
  it('leaves an already-clean Chrome UA unchanged', () => {
    const clean = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
    expect(toChromeUserAgent(clean)).toBe(clean)
  })
})

describe('webSessionFromElectronCookies (pure)', () => {
  it('is not signed in without a sessionKey cookie', () => {
    expect(webSessionFromElectronCookies([{ name: 'ajs_anonymous_id' }])).toEqual({ hasSessionCookie: false, expiresAt: null })
    expect(webSessionFromElectronCookies([])).toEqual({ hasSessionCookie: false, expiresAt: null })
  })
  it('maps the sessionKey expiry (seconds) to epoch ms', () => {
    expect(webSessionFromElectronCookies([SK({ expirationDate: 1_800_000_000 })])).toEqual({ hasSessionCookie: true, expiresAt: 1_800_000_000_000 })
  })
  it('treats a session cookie (no expiry) as active with null expiresAt', () => {
    expect(webSessionFromElectronCookies([SK({ session: true })])).toEqual({ hasSessionCookie: true, expiresAt: null })
  })
})

describe('runInAppSignIn — window flow', () => {
  it('signs in when the sessionKey cookie appears, stamping origin in-app + expiry + email', async () => {
    cookieResponse = [SK({ expirationDate: 1_800_000_000 })]
    evalResult = 'me@example.com'
    const res = await runInAppSignIn({ ...RUN, shouldCancel: () => false })
    expect(res.ok).toBe(true)
    expect(res.session?.origin).toBe('in-app')
    expect(res.session?.accountEmail).toBe('me@example.com')
    expect(res.session?.expiresAt).toBe(1_800_000_000_000)
    expect(res.session?.profileId).toBe('profile-web1')
    // The window is torn down on success — a session-bearing window never lingers.
    expect(created[0].destroyed).toBe(true)
  })

  it('opens on THAT account partition, hardened, presenting a Chrome UA', async () => {
    cookieResponse = [SK({ expirationDate: 1_800_000_000 })]
    evalResult = 'me@example.com'
    await runInAppSignIn({ ...RUN, shouldCancel: () => false })
    expect(fromPartition).toHaveBeenCalledWith('persist:claude-web-profile-web1')
    const wp = created[0].opts.webPreferences
    expect(wp.partition).toBe('persist:claude-web-profile-web1')
    expect(wp.sandbox).toBe(true)
    expect(wp.contextIsolation).toBe(true)
    expect(wp.nodeIntegration).toBe(false)
    expect(wp.preload).toBeUndefined()
    // UA presented as Chrome, not Electron.
    expect(setUA).toHaveBeenCalledTimes(1)
    expect(setUA.mock.calls[0][0]).not.toContain('Electron')
    expect(setUA.mock.calls[0][0]).toContain('Chrome/')
  })

  it('denies permissions, blocks non-https navigation, allows https, denies popups', async () => {
    cookieResponse = [SK({ expirationDate: 1_800_000_000 })]
    evalResult = 'me@example.com'
    await runInAppSignIn({ ...RUN, shouldCancel: () => false })
    const w = created[0]
    // permission deny
    expect(permHandlers).toHaveLength(1)
    const pcb = vi.fn()
    permHandlers[0](null, 'media', pcb)
    expect(pcb).toHaveBeenCalledWith(false)
    // https allowed (IdP hop), non-https blocked
    for (const ev of ['will-navigate', 'will-redirect']) {
      const okE = { preventDefault: vi.fn() }
      w.handlers[ev](okE, 'https://accounts.google.com/o/oauth2/x')
      expect(okE.preventDefault).not.toHaveBeenCalled()
      const badE = { preventDefault: vi.fn() }
      w.handlers[ev](badE, 'javascript:alert(1)')
      expect(badE.preventDefault).toHaveBeenCalled()
    }
    // popups denied
    expect(w.handlers.__open({ url: 'https://claude.ai/x' })).toEqual({ action: 'deny' })
  })

  it('completes with a null email after the grace when the identity read never answers', async () => {
    cookieResponse = [SK({ expirationDate: 1_800_000_000 })]
    evalResult = null
    const res = await runInAppSignIn({ ...RUN, emailGraceMs: 0, shouldCancel: () => false })
    expect(res.ok).toBe(true)
    expect(res.session?.accountEmail).toBeNull()
    expect(res.session?.origin).toBe('in-app')
  })

  it('does NOT complete if the session cookie vanishes during the identity read (sign-out race)', async () => {
    // sessionKey present on the first read, then cleared by a sign-out landing
    // during the email read: the recheck must catch it and NOT report done.
    cookieResponse = [SK({ expirationDate: 1_800_000_000 })]
    evalResult = 'me@example.com'
    onEval = () => { cookieResponse = [] }   // partition cleared mid-read
    const res = await runInAppSignIn({ ...RUN, timeoutMs: 120, pollMs: 5, shouldCancel: () => false })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Timed out/)
  })

  it('does NOT record done if cancel fires during the recheck read (sign-out race)', async () => {
    // clearWebSession sets the cancel flag SYNCHRONOUSLY, then awaits the
    // partition wipe — so a cancel can land after the pre-recheck gate while the
    // recheck read still sees the cookie. The post-recheck cancel check must
    // catch it rather than saving a record over a partition about to be emptied.
    cookieResponse = [SK({ expirationDate: 1_800_000_000 })]
    evalResult = 'me@example.com'
    let cancel = false
    // 1st get = main poll read; 2nd get = the recheck — signal cancel THEN, so the
    // cookie is still present on that read but cancel is set right after it.
    onCookiesGet = (n) => { if (n === 2) cancel = true }
    const res = await runInAppSignIn({ ...RUN, shouldCancel: () => cancel })
    expect(res.ok).toBe(false)
    expect(res.cancelled).toBe(true)
    expect(created[0].destroyed).toBe(true)
  })

  it('never throws, even when Electron fails to build the window (single-flight stays releasable)', async () => {
    throwOnPartition = true
    const res = await runInAppSignIn({ ...RUN, shouldCancel: () => false })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/simulated Electron failure/)
    // No window was created, and nothing was left dangling.
    expect(created).toHaveLength(0)
  })

  it('fails when the user closes the window before signing in', async () => {
    cookieResponse = []   // never signs in
    const p = runInAppSignIn({ ...RUN, shouldCancel: () => false })
    created[0].userClose()
    const res = await p
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/closed/)
  })

  it('returns cancelled and destroys the window when cancel is signalled', async () => {
    cookieResponse = []
    let cancel = false
    const p = runInAppSignIn({ ...RUN, shouldCancel: () => cancel })
    cancel = true
    const res = await p
    expect(res.cancelled).toBe(true)
    expect(created[0].destroyed).toBe(true)
  })

  it('times out (and tears the window down) if the user never signs in', async () => {
    cookieResponse = []
    const res = await runInAppSignIn({ ...RUN, timeoutMs: 60, pollMs: 5, shouldCancel: () => false })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/Timed out/)
    expect(created[0].destroyed).toBe(true)
  })
})

describe('closeInAppSignInWindow', () => {
  it('destroys an open sign-in window (used by cancel / sign-out)', async () => {
    cookieResponse = []
    const p = runInAppSignIn({ ...RUN, timeoutMs: 5000, pollMs: 5, shouldCancel: () => false })
    // Give the loop a tick to open the window.
    await new Promise((r) => setTimeout(r, 10))
    expect(created[0].destroyed).toBe(false)
    closeInAppSignInWindow()
    expect(created[0].destroyed).toBe(true)
    await p
  })
})
