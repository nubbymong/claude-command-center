// [host] WP2 PR 4, P4.6 second half (row 58): the pane's account surface for a
// Codex account, on chatgpt.com.
//
// The security-relevant difference from Claude's surface is the signed-out
// rule. Claude's pane lets a confirmed-signed-out view go to ANY https host
// (an SSO hop). A Codex view may only go to the listed sign-in hosts: if the
// session cookie name is guessed wrong, a signed-in view reads as signed out,
// and "any https" would then let a session-bearing chatgpt.com view roam.
// With the list, a wrong guess widens navigation at most to those hosts.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import vm from 'node:vm'

const createdViews: { opts: any; view: any }[] = []
/** When set, every view's loadURL rejects with it (as Electron's does, the URL in the message). */
let loadFails: (Error & { code?: string; errno?: number }) | null = null
/** When set, loadURL throws it at once, before any promise. */
let loadThrowsNow: (Error & { code?: string; errno?: number }) | null = null
const openedExternal: string[] = []
const partitions: Record<string, any> = {}

function fakeSession(partition: string) {
  if (partitions[partition]) return partitions[partition]
  const ses = {
    partition,
    ua: 'FakeUA (KHTML, like Gecko) App/1 Chrome/1 Electron/1',
    getUserAgent() { return this.ua },
    setUserAgent(v: string) { this.ua = v },
    permissionRequestHandlers: [] as any[],
    setPermissionRequestHandler(fn: any) { this.permissionRequestHandlers.push(fn) },
    setPermissionCheckHandler: vi.fn(),
    sessionEvents: {} as Record<string, Function>,
    on(ev: string, fn: Function) { this.sessionEvents[ev] = fn },
    cookies: {
      listeners: [] as any[],
      get: vi.fn(async () => [] as unknown[]),
      on(_ev: string, fn: any) { this.listeners.push(fn) },
      removeListener(_ev: string, fn: any) { this.listeners = this.listeners.filter((f: any) => f !== fn) },
    },
  }
  partitions[partition] = ses
  return ses
}

class FakeWebContentsView {
  webContents: any
  bounds: any = null
  constructor(public opts: any) {
    const handlers: Record<string, Function> = {}
    this.webContents = {
      handlers,
      destroyed: false,
      on: (ev: string, fn: Function) => { handlers[ev] = fn },
      setWindowOpenHandler: (fn: Function) => { handlers.__open = fn },
      loadURL: vi.fn((): Promise<void> => { if (loadThrowsNow) throw loadThrowsNow; return loadFails ? Promise.reject(loadFails) : Promise.resolve() }),
      close() { this.destroyed = true },
      isDestroyed() { return this.destroyed },
      executeJavaScriptInIsolatedWorld: vi.fn(async () => null),
      executeJavaScript: vi.fn(async () => null),
      currentUrl: 'https://chatgpt.com/',
      getURL() { return this.currentUrl },
      getTitle: () => 'ChatGPT',
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      reloadIgnoringCache: vi.fn(),
    }
    createdViews.push({ opts, view: this })
  }
  setBounds(b: any) { this.bounds = b }
}

class FakeParentWindow {
  contentView = {
    children: [] as any[],
    addChildView: (v: any) => { this.contentView.children.push(v) },
    removeChildView: (v: any) => { this.contentView.children = this.contentView.children.filter((x) => x !== v) },
  }
  webContents = { send: vi.fn() }
  once(_ev: string, _fn: () => void) { /* noop */ }
  on(_ev: string, _fn: () => void) { /* noop */ }
  isDestroyed() { return false }
}

vi.mock('electron', () => ({
  BrowserWindow: class {},
  WebContentsView: FakeWebContentsView,
  shell: { openExternal: async (u: string) => { openedExternal.push(u) } },
  session: { fromPartition: (p: string) => fakeSession(p) },
}))
const logged: string[] = []
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: (...a: unknown[]) => { logged.push(a.map(String).join(' ')) } }))

/** One in-memory JSON file per name, so Claude's and Codex's records stay apart. */
const disk: Record<string, unknown> = {}
const cleared = vi.hoisted(() => [] as string[])
const writeFails = vi.hoisted(() => ({ on: false }))
vi.mock('../../src/main/account-web/codex-web-session', () => ({
  clearCodexWebSession: async (id: string) => { cleared.push(id) },
}))
vi.mock('../../src/main/channel-storage', () => ({
  readJsonFile: (n: string, seed: () => unknown) => (disk[n] ?? seed()),
  writeJsonFile: (n: string, v: unknown) => { if (writeFails.on) return false; disk[n] = JSON.parse(JSON.stringify(v)); return true },
  peekJsonFile: (n: string) => (disk[n] !== undefined ? { kind: 'ok', value: disk[n] } : { kind: 'absent' }),
  quarantinedCopyOf: () => null,
}))

const {
  openAccountPane, openCodexAccountPane, closeAccountPane, closeAccountPanesForProfile, closeCodexAccountPanes, closeCodexAccountPanesWhere,
  closeAllAccountPanes, getAccountPaneState, codexPaneNavDecision, FOCUSED_CONTROL_PROBE,
} = await import('../../src/main/account-web/account-pane')
const { webPartitionForCodexAccount, webPartitionForProfile, CODEX_WEB_SERVICE } = await import('../../src/shared/account-web-session')
const { getCodexWebSession, saveCodexWebSession, removeCodexWebSession, codexWebViewFor } = await import('../../src/main/account-web/codex-web-store')

const ACCT = 'acct-0123456789abcdef'
const ACCT2 = 'acct-fedcba9876543210'
const BOUNDS = { x: 0, y: 0, width: 800, height: 600 }
const TOKEN_COOKIE = [{ name: '__Secure-next-auth.session-token', expirationDate: 4102444800 }]
const IDP = `https://${CODEX_WEB_SERVICE.signInHosts[0]}/authorize`
const flush = () => new Promise((r) => setTimeout(r, 0))
/** The user presses a mouse button in the view (an OS input event). */
const click = (wc: any, type = 'mouseDown') => wc.handlers['before-mouse-event']?.({ preventDefault() {} }, { type, button: 'left', x: 10, y: 10 })
/** The user taps the view on a touch screen (Chromium's gesture for a tap). */
const tap = (wc: any, type = 'gestureTap') => wc.handlers['input-event']?.({ preventDefault() {} }, { type, modifiers: [] })
/** The user presses a key in the view. */
const press = (wc: any, input: Record<string, unknown>) => wc.handlers['before-input-event']?.({ preventDefault() {} }, { type: 'keyDown', ...input })
/** A popup's details as Electron hands them over: its URL and the page that opened it. */
const popup = (url: string, referrer?: string) => (referrer === undefined
  ? { url, frameName: '', features: '', disposition: 'foreground-tab' }
  : { url, referrer: { url: referrer, policy: 'strict-origin-when-cross-origin' }, frameName: '', features: '', disposition: 'foreground-tab' })
/** A popup as Electron hands it over for a link written the way both services
 *  write their links out, `<a href=... target="_blank" rel="noopener noreferrer">`:
 *  such a link sends no referrer, so the page that opened it is named as ''. */
const newTabLink = (url: string) => ({ url, referrer: { url: '', policy: 'no-referrer' }, frameName: '', features: '', disposition: 'foreground-tab' })
/** What the view's read of its focused element answers after a key press:
 *  true when the key landed on a link or a button. Every other script the
 *  view runs (the email read) gets nothing. */
const keyLandsOn = (wc: any, answer: () => unknown) => wc.executeJavaScriptInIsolatedWorld.mockImplementation(
  async (_world: number, scripts: Array<{ code: string }>) => (scripts?.[0]?.code === FOCUSED_CONTROL_PROBE ? answer() : null))

beforeEach(() => {
  closeAllAccountPanes()
  createdViews.length = 0
  openedExternal.length = 0
  for (const k of Object.keys(partitions)) delete partitions[k]
  for (const k of Object.keys(disk)) delete disk[k]
  logged.length = 0
  loadFails = null
  loadThrowsNow = null
})

describe('[host] codexPaneNavDecision (pure, tri-state)', () => {
  it('chatgpt.com is always allowed; non-https is always blocked', () => {
    for (const authed of [true, false, null]) {
      expect(codexPaneNavDecision('https://chatgpt.com/c/1', authed)).toBe('allow')
      expect(codexPaneNavDecision('http://chatgpt.com/', authed)).toBe('block')
      expect(codexPaneNavDecision('javascript:alert(1)', authed)).toBe('block')
      expect(codexPaneNavDecision('not a url', authed)).toBe('block')
    }
  })

  it('confirmed signed out: the listed sign-in hosts ONLY, never any other https host', () => {
    for (const host of CODEX_WEB_SERVICE.signInHosts) expect(codexPaneNavDecision(`https://${host}/x`, false), host).toBe('allow')
    for (const bad of ['https://evil.example/', 'https://login.microsoftonline.com.example.net/x', 'https://chatgpt.com.evil.example/', `https://${CODEX_WEB_SERVICE.signInHosts[0]}:8443/`]) {
      expect(codexPaneNavDecision(bad, false), bad).toBe('block')
    }
  })

  it('unknown: every off-site host is blocked, the sign-in hosts included', () => {
    expect(codexPaneNavDecision(IDP, null)).toBe('block')
    expect(codexPaneNavDecision('https://evil.example/', null)).toBe('block')
  })

  it('signed in: off-site goes to the real browser, the sign-in hosts included (a session-bearing view never roams)', () => {
    expect(codexPaneNavDecision(IDP, true)).toBe('external')
    expect(codexPaneNavDecision('https://example.com/paper', true)).toBe('external')
  })
})

describe('[host] the Codex account view', () => {
  it("opens on THAT account's partition, hardened, on chatgpt.com, and blocks downloads", () => {
    const win = new FakeParentWindow()
    expect(openCodexAccountPane(win as never, 'sess-a', ACCT, BOUNDS).ok).toBe(true)
    const { opts, view } = createdViews[0]
    expect(opts.webPreferences).toMatchObject({ partition: webPartitionForCodexAccount(ACCT), sandbox: true, contextIsolation: true, nodeIntegration: false })
    expect(opts.webPreferences.preload).toBeUndefined()
    expect(view.webContents.loadURL).toHaveBeenCalledWith('https://chatgpt.com/')
    const ses = partitions[webPartitionForCodexAccount(ACCT)]
    const cb = vi.fn()
    ses.permissionRequestHandlers[0](null, 'media', cb)
    expect(cb).toHaveBeenCalledWith(false)
    const ev = { preventDefault: vi.fn() }
    ses.sessionEvents['will-download'](ev, { getURL: () => 'https://chatgpt.com/x.exe' })
    expect(ev.preventDefault).toHaveBeenCalled()
    expect(getAccountPaneState('sess-a')).toEqual({ sessionId: 'sess-a', service: 'codex', accountId: ACCT, authed: null, email: null })
  })

  it('refuses a malformed account id or a Claude profile id, creating nothing', () => {
    const win = new FakeParentWindow()
    for (const bad of ['profile-p1a', 'acct-0123', '../x', '']) {
      expect(openCodexAccountPane(win as never, 'sess-x', bad, BOUNDS).ok, bad).toBe(false)
    }
    expect(openCodexAccountPane(win as never, 'a/../b', ACCT, BOUNDS).ok).toBe(false)
    expect(createdViews).toHaveLength(0)
  })

  it('wires the guard: unknown blocks the sign-in host; signed out allows it and blocks any other host; signed in sends off-site to the real browser', async () => {
    const win = new FakeParentWindow()
    openCodexAccountPane(win as never, 'sess-nav', ACCT, BOUNDS)
    const ses = partitions[webPartitionForCodexAccount(ACCT)]
    const nav = createdViews[0].view.webContents.handlers['will-navigate'] as (e: { preventDefault: () => void; isMainFrame?: boolean }, url: string) => void

    const unknown = { preventDefault: vi.fn() }
    nav(unknown, IDP)
    expect(unknown.preventDefault).toHaveBeenCalled()

    await flush() // the first read: no cookie, authed=false
    const idp = { preventDefault: vi.fn() }
    nav(idp, IDP)
    expect(idp.preventDefault).not.toHaveBeenCalled()
    const evil = { preventDefault: vi.fn() }
    nav(evil, 'https://evil.example/landing')
    expect(evil.preventDefault).toHaveBeenCalled()
    expect(openedExternal).toEqual([])

    ses.cookies.get.mockResolvedValue(TOKEN_COOKIE)
    ses.cookies.listeners[0](null, { name: '__Secure-next-auth.session-token' })
    await flush(); await flush()
    const off = { preventDefault: vi.fn(), isMainFrame: true }
    click(createdViews[0].view.webContents)
    nav(off, 'https://example.com/paper')
    expect(off.preventDefault).toHaveBeenCalled()
    expect(openedExternal).toEqual(['https://example.com/paper'])
    // A sub-frame is left to same-origin policy (https only), never sent out.
    const sub = { preventDefault: vi.fn(), isMainFrame: false }
    nav(sub, 'https://challenges.cloudflare.com/x')
    expect(sub.preventDefault).not.toHaveBeenCalled()
    expect(openedExternal).toHaveLength(1)
    closeAccountPane('sess-nav')
  })

  it('a popup loads in the view only when it is chatgpt.com; a sign-in host popup while signed out is dropped', async () => {
    const win = new FakeParentWindow()
    openCodexAccountPane(win as never, 'sess-pop', ACCT, BOUNDS)
    const wc = createdViews[0].view.webContents
    await flush()
    wc.loadURL.mockClear()
    click(wc)
    expect(wc.handlers.__open(popup(IDP, 'https://chatgpt.com/'))).toEqual({ action: 'deny' })
    expect(wc.loadURL).not.toHaveBeenCalled()
    expect(wc.handlers.__open(popup('https://chatgpt.com/c/2', 'https://chatgpt.com/'))).toEqual({ action: 'deny' })
    expect(wc.loadURL).toHaveBeenCalledWith('https://chatgpt.com/c/2')
    closeAccountPane('sess-pop')
  })

  it('recalls a signed-in view parked off chatgpt.com to the start page', async () => {
    const win = new FakeParentWindow()
    openCodexAccountPane(win as never, 'sess-recall', ACCT, BOUNDS)
    const ses = partitions[webPartitionForCodexAccount(ACCT)]
    const view = createdViews[0].view
    await flush()
    view.webContents.loadURL.mockClear()
    view.webContents.currentUrl = IDP
    ses.cookies.get.mockResolvedValue(TOKEN_COOKIE)
    ses.cookies.listeners[0](null, { name: '__Secure-next-auth.session-token' })
    await flush(); await flush()
    expect(view.webContents.loadURL).toHaveBeenCalledWith('https://chatgpt.com/')
    closeAccountPane('sess-recall')
  })

  it('ignores cookie changes that are not the session cookie', async () => {
    const win = new FakeParentWindow()
    openCodexAccountPane(win as never, 'sess-ck', ACCT, BOUNDS)
    const ses = partitions[webPartitionForCodexAccount(ACCT)]
    await flush()
    const before = ses.cookies.get.mock.calls.length
    ses.cookies.listeners[0](null, { name: '__cf_bm' })
    ses.cookies.listeners[0](null, { name: 'sessionKey' })
    await flush()
    expect(ses.cookies.get.mock.calls.length).toBe(before)
    closeAccountPane('sess-ck')
  })
})

describe('[host] recording a sign-in made in the Codex pane', () => {
  it('records only with a valid email read on chatgpt.com, into the Codex record, never Claude\'s', async () => {
    const win = new FakeParentWindow()
    openCodexAccountPane(win as never, 'sess-rec', ACCT, BOUNDS)
    const ses = partitions[webPartitionForCodexAccount(ACCT)]
    const wc = createdViews[0].view.webContents
    await flush()
    ses.cookies.get.mockResolvedValue(TOKEN_COOKIE)
    wc.executeJavaScriptInIsolatedWorld.mockResolvedValue('me@example.com')
    ses.cookies.listeners[0](null, { name: '__Secure-next-auth.session-token' })
    for (let i = 0; i < 6; i++) await flush()
    expect(getCodexWebSession(ACCT)).toMatchObject({ accountId: ACCT, accountEmail: 'me@example.com', origin: 'in-pane' })
    expect(disk['account-web-sessions.json']).toBeUndefined()
    // The strip is told, as the Codex account.
    const states = (win.webContents.send as any).mock.calls.filter((c: any[]) => c[0] === 'accountWeb:paneState').map((c: any[]) => c[1])
    expect(states.at(-1)).toEqual({ sessionId: 'sess-rec', service: 'codex', accountId: ACCT, authed: true, email: 'me@example.com' })
    closeAccountPane('sess-rec')
  })

  it('a cookie with no email never records (fail closed)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const win = new FakeParentWindow()
      openCodexAccountPane(win as never, 'sess-noemail', ACCT, BOUNDS)
      const ses = partitions[webPartitionForCodexAccount(ACCT)]
      await vi.advanceTimersByTimeAsync(1)
      ses.cookies.get.mockResolvedValue(TOKEN_COOKIE)
      ses.cookies.listeners[0](null, { name: '__Secure-next-auth.session-token' })
      await vi.advanceTimersByTimeAsync(6000)
      expect(getCodexWebSession(ACCT)).toBeUndefined()
      // The pane refuses before any write: not even a write the store has to
      // refuse (the store's own check is a further layer, tested below).
      expect(logged.some((l) => /could not record/.test(l))).toBe(false)
      closeAccountPane('sess-noemail')
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses to record when the view is not on chatgpt.com', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const win = new FakeParentWindow()
      openCodexAccountPane(win as never, 'sess-off', ACCT, BOUNDS)
      const ses = partitions[webPartitionForCodexAccount(ACCT)]
      const wc = createdViews[0].view.webContents
      await vi.advanceTimersByTimeAsync(1)
      wc.currentUrl = IDP
      wc.executeJavaScriptInIsolatedWorld.mockResolvedValue('attacker@evil.example')
      ses.cookies.get.mockResolvedValue(TOKEN_COOKIE)
      ses.cookies.listeners[0](null, { name: '__Secure-next-auth.session-token' })
      await vi.advanceTimersByTimeAsync(6000)
      expect(getCodexWebSession(ACCT)?.accountEmail).not.toBe('attacker@evil.example')
      closeAccountPane('sess-off')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('[host] teardown keeps the two services apart', () => {
  it("closing a Codex account's panes leaves Claude's, and closing a Claude profile's leaves Codex's", () => {
    const win = new FakeParentWindow()
    openCodexAccountPane(win as never, 'sess-c1', ACCT, BOUNDS)
    openCodexAccountPane(win as never, 'sess-c2', ACCT2, BOUNDS)
    openAccountPane(win as never, 'sess-p1', 'profile-p1a', BOUNDS)
    closeAccountPanesForProfile('profile-p1a')
    expect(getAccountPaneState('sess-p1')).toBeNull()
    expect(getAccountPaneState('sess-c1')).not.toBeNull()
    openAccountPane(win as never, 'sess-p1', 'profile-p1a', BOUNDS)
    closeCodexAccountPanes(ACCT)
    expect(getAccountPaneState('sess-c1')).toBeNull()
    expect(getAccountPaneState('sess-c2')).not.toBeNull()
    expect(getAccountPaneState('sess-p1')).not.toBeNull()
    // The cookie listener left with the pane.
    expect(partitions[webPartitionForCodexAccount(ACCT)].cookies.listeners).toHaveLength(0)
    expect(partitions[webPartitionForProfile('profile-p1a')].cookies.listeners).toHaveLength(1)
  })

  it('a session switching from a Claude view to a Codex view rebuilds it on the Codex partition', () => {
    const win = new FakeParentWindow()
    openAccountPane(win as never, 'sess-sw', 'profile-p1a', BOUNDS)
    openCodexAccountPane(win as never, 'sess-sw', ACCT, BOUNDS)
    expect(createdViews[0].view.webContents.destroyed).toBe(true)
    expect(createdViews[1].opts.webPreferences.partition).toBe(webPartitionForCodexAccount(ACCT))
    expect(getAccountPaneState('sess-sw')).toMatchObject({ service: 'codex', accountId: ACCT })
    closeAccountPane('sess-sw')
  })
})

describe('[host] the Codex web record: metadata only, in its own file', () => {
  const VALID = { accountId: ACCT, accountEmail: 'me@example.com', acquiredAt: 1, expiresAt: null, origin: 'in-app' as const }

  it('keeps only the metadata fields, in codex-web-sessions.json, never Claude\'s file', () => {
    saveCodexWebSession({ ...VALID, accessToken: 'SECRET-TOKEN', cookie: 'SECRET-COOKIE' } as never)
    expect(getCodexWebSession(ACCT)).toEqual(VALID)
    expect(JSON.stringify(disk)).not.toContain('SECRET')
    expect(Object.keys(disk)).toEqual(['codex-web-sessions.json'])
    expect(codexWebViewFor(ACCT)).toMatchObject({ accountId: ACCT, status: 'active', accountEmail: 'me@example.com' })
    expect(codexWebViewFor(ACCT2)).toEqual({ accountId: ACCT2, status: 'none' })
    expect(codexWebViewFor(ACCT, 10).status).toBe('active')
  })

  it('refuses a record with no valid email or a non-registry id, and drops malformed ones on read', () => {
    for (const bad of [
      { ...VALID, accountEmail: null }, { ...VALID, accountEmail: 'not-an-email' }, { ...VALID, accountId: 'profile-p1a' },
      { ...VALID, origin: 'system-browser' }, { ...VALID, acquiredAt: 'x' },
    ]) {
      expect(() => saveCodexWebSession(bad as never), JSON.stringify(bad)).toThrow(/malformed/)
    }
    expect(disk['codex-web-sessions.json']).toBeUndefined()
    disk['codex-web-sessions.json'] = { schemaVersion: 1, sessions: [VALID, { ...VALID, accountId: ACCT2, accountEmail: null }, { accountId: 'x' }] }
    expect(getCodexWebSession(ACCT)).toEqual(VALID)
    expect(getCodexWebSession(ACCT2)).toBeUndefined()
  })

  it('an expired session reads as expired; removing forgets only that account', () => {
    saveCodexWebSession({ ...VALID, expiresAt: 1000 })
    saveCodexWebSession({ ...VALID, accountId: ACCT2 })
    expect(codexWebViewFor(ACCT, 2000).status).toBe('expired')
    removeCodexWebSession(ACCT)
    expect(getCodexWebSession(ACCT)).toBeUndefined()
    expect(getCodexWebSession(ACCT2)).toBeDefined()
  })
})

describe('[host] the account view logs hosts only, and holds sub-frames to https', () => {
  it('a blocked navigation, a non-https sub-frame and a blocked download log the host, never the path, query or fragment', async () => {
    const win = new FakeParentWindow()
    openCodexAccountPane(win as never, 'sess-log', ACCT, BOUNDS)
    const wc = createdViews[0].view.webContents
    await flush()
    wc.handlers['will-navigate']({ preventDefault: vi.fn(), isMainFrame: true }, 'https://evil.example/cb?code=OAUTH-SECRET#state=OAUTH-SECRET')
    wc.handlers['will-redirect']({ preventDefault: vi.fn(), isMainFrame: false }, 'http://frames.example/x?token=FRAME-SECRET')
    const ses = partitions[webPartitionForCodexAccount(ACCT)]
    ses.sessionEvents['will-download']({ preventDefault: vi.fn() }, { getURL: () => 'https://files.example/f.zip?sig=DL-SECRET' })
    const joined = logged.join('\n')
    expect(joined).toContain('evil.example')
    expect(joined).toContain('frames.example')
    expect(joined).toContain('files.example')
    expect(joined).not.toMatch(/SECRET|\/cb|f\.zip|\?|#/)
    closeAccountPane('sess-log')
  })

  it("holds a sub-frame's own navigation to https, never hands it to the OS, and leaves the main frame alone", async () => {
    const win = new FakeParentWindow()
    openCodexAccountPane(win as never, 'sess-frame', ACCT, BOUNDS)
    const ses = partitions[webPartitionForCodexAccount(ACCT)]
    const wc = createdViews[0].view.webContents
    ses.cookies.get.mockResolvedValue(TOKEN_COOKIE)
    ses.cookies.listeners[0](null, { name: '__Secure-next-auth.session-token' })
    await flush(); await flush()
    const frameNav = wc.handlers['will-frame-navigate']
    expect(typeof frameNav).toBe('function')
    const http = { preventDefault: vi.fn(), isMainFrame: false, url: 'http://frames.example/x' }
    frameNav(http)
    expect(http.preventDefault).toHaveBeenCalled()
    const https = { preventDefault: vi.fn(), isMainFrame: false, url: 'https://challenges.cloudflare.com/x' }
    frameNav(https)
    expect(https.preventDefault).not.toHaveBeenCalled()
    const main = { preventDefault: vi.fn(), isMainFrame: true, url: 'https://example.com/paper' }
    frameNav(main)
    expect(main.preventDefault).not.toHaveBeenCalled()
    expect(openedExternal).toEqual([])
    closeAccountPane('sess-frame')
  })
})

describe('[host] an email that arrives after the grace is still recorded, a bounded number of times', () => {
  it('a later refresh records the session once the email answers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const win = new FakeParentWindow()
      openCodexAccountPane(win as never, 'sess-late', ACCT, BOUNDS)
      const ses = partitions[webPartitionForCodexAccount(ACCT)]
      const wc = createdViews[0].view.webContents
      await vi.advanceTimersByTimeAsync(1)
      ses.cookies.get.mockResolvedValue(TOKEN_COOKIE)
      ses.cookies.listeners[0](null, { name: '__Secure-next-auth.session-token' })
      await vi.advanceTimersByTimeAsync(6000)
      expect(getCodexWebSession(ACCT)).toBeUndefined()
      wc.executeJavaScriptInIsolatedWorld.mockResolvedValue('me@example.com')
      wc.handlers['did-navigate']()
      await vi.advanceTimersByTimeAsync(6000)
      expect(getCodexWebSession(ACCT)).toMatchObject({ accountEmail: 'me@example.com', origin: 'in-pane' })
      closeAccountPane('sess-late')
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops trying after its bound when the email never answers', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const win = new FakeParentWindow()
      openCodexAccountPane(win as never, 'sess-never', ACCT, BOUNDS)
      const ses = partitions[webPartitionForCodexAccount(ACCT)]
      const wc = createdViews[0].view.webContents
      await vi.advanceTimersByTimeAsync(1)
      ses.cookies.get.mockResolvedValue(TOKEN_COOKIE)
      ses.cookies.listeners[0](null, { name: '__Secure-next-auth.session-token' })
      await vi.advanceTimersByTimeAsync(6000)
      for (let i = 0; i < 8; i++) {
        wc.handlers['did-navigate']()
        await vi.advanceTimersByTimeAsync(6000)
      }
      const reads = wc.executeJavaScriptInIsolatedWorld.mock.calls.length
      wc.handlers['did-navigate']()
      await vi.advanceTimersByTimeAsync(6000)
      expect(wc.executeJavaScriptInIsolatedWorld.mock.calls.length).toBe(reads)
      expect(getCodexWebSession(ACCT)).toBeUndefined()
      closeAccountPane('sess-never')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('[host] a page load that fails is logged by host and code, and never rejects unhandled', () => {
  const failure = () => Object.assign(new Error("ERR_ABORTED (-3) loading 'https://chatgpt.com/?code=OAUTH-SECRET#state=SECRET'"), { code: 'ERR_ABORTED', errno: -3 })
  const unhandled: unknown[] = []
  const onUnhandled = (r: unknown) => { unhandled.push(r) }

  it('the open, the return to the start page and a service popup', async () => {
    process.on('unhandledRejection', onUnhandled)
    try {
      loadFails = failure()
      const win = new FakeParentWindow()
      openCodexAccountPane(win as never, 'sess-load', ACCT, BOUNDS)
      const wc = createdViews[0].view.webContents
      await flush(); await flush()
      // Signed in while the view is off the service: it is sent back to the start page.
      wc.currentUrl = 'https://elsewhere.example/'
      const ses = partitions[webPartitionForCodexAccount(ACCT)]
      ses.cookies.get.mockResolvedValue(TOKEN_COOKIE)
      ses.cookies.listeners[0](null, { name: '__Secure-next-auth.session-token' })
      await flush(); await flush()
      // A popup to the service's own URL, from its own page after a click, is followed in this view.
      click(wc)
      wc.handlers.__open(popup('https://chatgpt.com/c/2?q=SECRET', 'https://chatgpt.com/'))
      await new Promise((r) => setTimeout(r, 20))
      expect(wc.loadURL.mock.calls.length).toBeGreaterThanOrEqual(3)
      const lines = logged.filter((l) => /could not load/.test(l))
      expect(lines.length).toBeGreaterThanOrEqual(3)
      for (const l of lines) {
        expect(l).toContain('chatgpt.com')
        expect(l).toContain('ERR_ABORTED -3')
        expect(l).not.toMatch(/SECRET|\?|#|loading '/)
      }
      expect(unhandled).toEqual([])
      closeAccountPane('sess-load')
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('[host] embedded local frames load in both panes; a sub-frame elsewhere is held to https', () => {
  const LOCAL = ['about:blank', 'about:srcdoc', 'blob:https://chatgpt.com/3f2c9a1e-0000-4000-8000-000000000000', 'data:text/html,<p>hi</p>']
  const BLOCKED = ['http://frames.example/x', 'file:///C:/Windows/win.ini', 'ms-settings:privacy', 'javascript:alert(1)', 'about:config']
  for (const kind of ['Claude', 'Codex'] as const) {
    it(`${kind}'s pane`, async () => {
      const win = new FakeParentWindow()
      if (kind === 'Codex') openCodexAccountPane(win as never, 'sess-fr', ACCT, BOUNDS)
      else openAccountPane(win as never, 'sess-fr', 'profile-p1a', BOUNDS)
      const wc = createdViews[0].view.webContents
      await flush()
      for (const url of LOCAL) {
        const e = { preventDefault: vi.fn(), isMainFrame: false, url }
        wc.handlers['will-frame-navigate'](e)
        expect(e.preventDefault, url).not.toHaveBeenCalled()
      }
      for (const url of BLOCKED) {
        const e = { preventDefault: vi.fn(), isMainFrame: false, url }
        wc.handlers['will-frame-navigate'](e)
        expect(e.preventDefault, url).toHaveBeenCalled()
      }
      expect(openedExternal).toEqual([])
      closeAccountPane('sess-fr')
    })
  }
})

describe('[host] closing the Codex panes a lease change names never touches a Claude pane', () => {
  it('only chatgpt.com panes are asked about, and only those it names close', async () => {
    const win = new FakeParentWindow()
    openAccountPane(win as never, 'sess-claude', 'profile-p1a', BOUNDS)
    openCodexAccountPane(win as never, 'sess-codex-a', ACCT, BOUNDS)
    openCodexAccountPane(win as never, 'sess-codex-b', ACCT2, BOUNDS)
    await flush()
    const asked: Array<[string, string]> = []
    const n = closeCodexAccountPanesWhere((sid, acct) => { asked.push([sid, acct]); return acct === ACCT })
    expect(n).toBe(1)
    expect(asked.map(([s]) => s).sort()).toEqual(['sess-codex-a', 'sess-codex-b'])
    expect(createdViews[0].view.webContents.destroyed).toBe(false)
    expect(createdViews[1].view.webContents.destroyed).toBe(true)
    expect(createdViews[2].view.webContents.destroyed).toBe(false)
    // A predicate that throws closes (fail closed).
    expect(closeCodexAccountPanesWhere(() => { throw new Error('lookup failed') })).toBe(1)
    expect(createdViews[2].view.webContents.destroyed).toBe(true)
    expect(createdViews[0].view.webContents.destroyed).toBe(false)
    closeAccountPane('sess-claude')
  })
})

describe('[host] a load that throws at once is caught and logged by host and code too', () => {
  it('the view still opens, and the line names the host and the code, never the URL', async () => {
    loadThrowsNow = Object.assign(new Error("ERR_FAILED loading 'https://chatgpt.com/?code=SECRET'"), { code: 'ERR_FAILED', errno: -2 })
    const win = new FakeParentWindow()
    expect(openCodexAccountPane(win as never, 'sess-sync', ACCT, BOUNDS)).toEqual({ ok: true })
    await flush()
    const line = logged.find((l) => /could not load/.test(l))!
    expect(line).toContain('chatgpt.com')
    expect(line).toContain('ERR_FAILED -2')
    expect(line).not.toMatch(/SECRET|\?/)
    closeAccountPane('sess-sync')
  })
})

describe('[host] a sign-in in the pane whose record cannot be saved is cleared, as the window does', () => {
  it('a record that cannot be written: the session is cleared, never left live without one, and the view closes saying why', async () => {
    cleared.length = 0
    writeFails.on = true
    try {
      const win = new FakeParentWindow()
      openCodexAccountPane(win as never, 'sess-norec', ACCT, BOUNDS)
      const ses = partitions[webPartitionForCodexAccount(ACCT)]
      const wc = createdViews[0].view.webContents
      await flush()
      wc.executeJavaScriptInIsolatedWorld.mockResolvedValue('me@example.com')
      ses.cookies.get.mockResolvedValue(TOKEN_COOKIE)
      ses.cookies.listeners[0](null, { name: '__Secure-next-auth.session-token' })
      await flush(); await flush(); await flush()
      expect(cleared).toEqual([ACCT])
      expect(logged.some((l) => /could not be written/.test(l))).toBe(true)
      // Fix pass 9: the view closes with a reason, which the renderer shows
      // on the start page, rather than dropping to it unexplained.
      expect(wc.destroyed).toBe(true)
      const closes = (win.webContents.send as any).mock.calls.filter((c: any[]) => c[0] === 'accountWeb:paneClosed')
      expect(closes).toEqual([['accountWeb:paneClosed', { sessionId: 'sess-norec', reason: expect.stringMatching(/could not be recorded/) }]])
      closeAccountPane('sess-norec')
    } finally {
      writeFails.on = false
    }
  })

  it('a record that is written leaves the session alone', async () => {
    cleared.length = 0
    const win = new FakeParentWindow()
    openCodexAccountPane(win as never, 'sess-rec', ACCT, BOUNDS)
    const ses = partitions[webPartitionForCodexAccount(ACCT)]
    const wc = createdViews[0].view.webContents
    await flush()
    wc.executeJavaScriptInIsolatedWorld.mockResolvedValue('me@example.com')
    ses.cookies.get.mockResolvedValue(TOKEN_COOKIE)
    ses.cookies.listeners[0](null, { name: '__Secure-next-auth.session-token' })
    await flush(); await flush(); await flush()
    expect(getCodexWebSession(ACCT)).toMatchObject({ accountEmail: 'me@example.com' })
    expect(cleared).toEqual([])
    closeAccountPane('sess-rec')
  })
})

describe('[host] the account view follows a popup only from its own page, and opens the browser only after your click', () => {
  const SERVICES = [
    {
      kind: 'Claude',
      open: (win: FakeParentWindow, sid: string) => openAccountPane(win as never, sid, 'profile-p1a', BOUNDS),
      home: 'https://claude.ai/artifacts',
      page: 'https://claude.ai/chat/2',
      partition: () => webPartitionForProfile('profile-p1a'),
      cookie: [{ name: 'sessionKey', expirationDate: 4102444800 }],
    },
    {
      kind: 'Codex',
      open: (win: FakeParentWindow, sid: string) => openCodexAccountPane(win as never, sid, ACCT, BOUNDS),
      home: 'https://chatgpt.com/',
      page: 'https://chatgpt.com/c/2',
      partition: () => webPartitionForCodexAccount(ACCT),
      cookie: TOKEN_COOKIE,
    },
  ] as const

  for (const s of SERVICES) {
    /** A signed-in view of the service, with no input in it yet. */
    async function signedInView(win = new FakeParentWindow()) {
      s.open(win, 'sess-pop')
      const wc = createdViews[0].view.webContents
      const ses = partitions[s.partition()]
      ses.cookies.get.mockResolvedValue(s.cookie)
      ses.cookies.listeners[0](null, { name: s.cookie[0].name })
      await flush(); await flush()
      wc.loadURL.mockClear()
      openedExternal.length = 0
      return wc
    }

    it(`${s.kind}: a popup to the service from its own page loads in the view right after a click, once, and never without one`, async () => {
      const wc = await signedInView()
      expect(wc.handlers.__open(popup(s.page, s.home))).toEqual({ action: 'deny' })
      expect(wc.loadURL).not.toHaveBeenCalled()
      click(wc)
      expect(wc.handlers.__open(popup(s.page, s.home))).toEqual({ action: 'deny' })
      expect(wc.loadURL.mock.calls).toEqual([[s.page]])
      // The same click lets nothing else through.
      wc.handlers.__open(popup(s.page, s.home))
      expect(wc.loadURL).toHaveBeenCalledTimes(1)
      closeAccountPane('sess-pop')
    })

    it(`${s.kind}: a popup to the service opened by a page from elsewhere, or by a page that names no referrer, loads nothing even after a click`, async () => {
      const wc = await signedInView()
      click(wc)
      expect(wc.handlers.__open(popup(s.page, 'https://frames.example/embed'))).toEqual({ action: 'deny' })
      click(wc)
      expect(wc.handlers.__open(popup(s.page, ''))).toEqual({ action: 'deny' })
      click(wc)
      expect(wc.handlers.__open(popup(s.page))).toEqual({ action: 'deny' })
      click(wc)
      expect(wc.handlers.__open(popup(s.page, 'not a url'))).toEqual({ action: 'deny' })
      expect(wc.loadURL).not.toHaveBeenCalled()
      expect(openedExternal).toEqual([])
      closeAccountPane('sess-pop')
    })

    it(`${s.kind}: a popup off the service reaches the browser only after a click, one popup per click`, async () => {
      const wc = await signedInView()
      expect(wc.handlers.__open(popup('https://example.com/paper', s.home))).toEqual({ action: 'deny' })
      expect(openedExternal).toEqual([])
      click(wc)
      wc.handlers.__open(popup('https://example.com/paper', s.home))
      wc.handlers.__open(popup('https://example.com/second', s.home))
      expect(openedExternal).toEqual(['https://example.com/paper'])
      click(wc)
      wc.handlers.__open(popup('https://example.com/third', s.home))
      expect(openedExternal).toEqual(['https://example.com/paper', 'https://example.com/third'])
      expect(wc.loadURL).not.toHaveBeenCalled()
      closeAccountPane('sess-pop')
    })

    it(`${s.kind}: a click more than a second old lets nothing through`, async () => {
      const wc = await signedInView()
      const now = vi.spyOn(performance, 'now')
      try {
        now.mockReturnValue(1_000_000)
        click(wc)
        now.mockReturnValue(1_000_000 + 1_001)
        wc.handlers.__open(popup('https://example.com/paper', s.home))
        wc.handlers.__open(popup(s.page, s.home))
        expect(openedExternal).toEqual([])
        expect(wc.loadURL).not.toHaveBeenCalled()
        now.mockReturnValue(1_000_000 + 2_000)
        click(wc)
        now.mockReturnValue(1_000_000 + 2_900)
        wc.handlers.__open(popup('https://example.com/paper', s.home))
        expect(openedExternal).toEqual(['https://example.com/paper'])
      } finally {
        now.mockRestore()
      }
      closeAccountPane('sess-pop')
    })

    it(`${s.kind}: a click's age is measured on a clock that never runs back: a wall clock set back keeps no old click fresh`, async () => {
      const wc = await signedInView()
      const wall = vi.spyOn(Date, 'now')
      const steady = vi.spyOn(performance, 'now')
      try {
        wall.mockReturnValue(5_000_000_000)
        steady.mockReturnValue(10_000)
        click(wc)
        wall.mockReturnValue(5_000_000_000 - 3_600_000)
        steady.mockReturnValue(10_000 + 1_001)
        wc.handlers.__open(popup('https://example.com/paper', s.home))
        wc.handlers.__open(popup(s.page, s.home))
        expect(openedExternal).toEqual([])
        expect(wc.loadURL).not.toHaveBeenCalled()
        wall.mockReturnValue(5_000_000_000 + 3_600_000)
        steady.mockReturnValue(10_000 + 2_000)
        click(wc)
        wall.mockReturnValue(5_000_000_000 - 3_600_000)
        steady.mockReturnValue(10_000 + 2_500)
        wc.handlers.__open(popup('https://example.com/paper', s.home))
        expect(openedExternal).toEqual(['https://example.com/paper'])
      } finally {
        wall.mockRestore()
        steady.mockRestore()
      }
      closeAccountPane('sess-pop')
    })

    it(`${s.kind}: a tap on a touch screen counts as a click, once; a touch, a press, a scroll or a long press does not`, async () => {
      const wc = await signedInView()
      const out = (n: number) => wc.handlers.__open(popup(`https://example.com/t${n}`, s.home))
      tap(wc, 'touchStart'); out(1)
      tap(wc, 'gestureTapDown'); out(2)
      tap(wc, 'gestureScrollBegin'); out(3)
      tap(wc, 'gestureLongPress'); out(4)
      tap(wc, 'touchEnd'); out(5)
      expect(openedExternal).toEqual([])
      tap(wc); out(6); out(7)
      expect(openedExternal).toEqual(['https://example.com/t6'])
      tap(wc)
      wc.handlers.__open(popup(s.page, s.home))
      expect(wc.loadURL).toHaveBeenCalledTimes(1)
      closeAccountPane('sess-pop')
    })

    it(`${s.kind}: Enter or Space on a link or a button counts as a click; another key, a held key's repeat, a mouse move or a release does not`, async () => {
      const wc = await signedInView()
      keyLandsOn(wc, () => true)
      const out = (n: number) => wc.handlers.__open(popup(`https://example.com/p${n}`, s.home))
      press(wc, { key: 'a', code: 'KeyA' }); out(1)
      press(wc, { key: 'Enter', code: 'Enter', isAutoRepeat: true }); out(2)
      press(wc, { key: 'Tab', code: 'Tab' }); out(3)
      click(wc, 'mouseMove'); out(4)
      click(wc, 'mouseUp'); out(5)
      wc.handlers['before-input-event']?.({ preventDefault() {} }, { type: 'keyUp', key: 'Enter', code: 'Enter' }); out(6)
      await flush()
      expect(openedExternal).toEqual([])
      press(wc, { key: 'Enter', code: 'Enter' }); out(7)
      await flush()
      press(wc, { key: ' ', code: 'Space' }); out(8)
      await flush()
      expect(openedExternal).toEqual(['https://example.com/p7', 'https://example.com/p8'])
      closeAccountPane('sess-pop')
    })

    it(`${s.kind}: Enter or Space typed into the page's text box lets nothing out; on a link or a button, one popup or one link`, async () => {
      const wc = await signedInView()
      let onControl = false
      keyLandsOn(wc, () => onControl)
      const out = (n: number) => wc.handlers.__open(popup(`https://example.com/k${n}`, s.home))
      const servicePopup = () => wc.handlers.__open(popup(s.page, s.home))
      const nav = (url: string) => { const e = { preventDefault: vi.fn(), isMainFrame: true }; wc.handlers['will-navigate'](e, url); return e }
      // Writing a message: a Space, Shift+Enter for a new line, Enter to send.
      press(wc, { key: 'h', code: 'KeyH' })
      press(wc, { key: ' ', code: 'Space' }); out(1); servicePopup()
      press(wc, { key: 'Enter', code: 'Enter', shift: true, modifiers: ['shift'] }); out(2)
      press(wc, { key: 'Enter', code: 'Enter' }); out(3); servicePopup()
      press(wc, { key: 'Enter', code: 'NumpadEnter' })
      expect(nav('https://example.com/k4').preventDefault).toHaveBeenCalled()
      await flush(); await flush()
      expect(openedExternal).toEqual([])
      expect(wc.loadURL).not.toHaveBeenCalled()
      // The same keys on a link or a button: one hand-off each.
      onControl = true
      press(wc, { key: 'Enter', code: 'Enter' }); out(5); out(6)
      await flush()
      expect(openedExternal).toEqual(['https://example.com/k5'])
      press(wc, { key: ' ', code: 'Space' }); servicePopup()
      await flush()
      expect(wc.loadURL.mock.calls).toEqual([[s.page]])
      press(wc, { key: 'Enter', code: 'Enter' }); nav('https://example.com/k7')
      await flush()
      expect(openedExternal).toEqual(['https://example.com/k5', 'https://example.com/k7'])
      // Where the key landed is read in a world of the app's own, never by the page's scripts.
      const probes = wc.executeJavaScriptInIsolatedWorld.mock.calls.filter((c: any[]) => c[1]?.[0]?.code === FOCUSED_CONTROL_PROBE)
      expect(probes.length).toBeGreaterThan(0)
      for (const c of probes) expect(c[0]).toBeGreaterThan(0)
      expect(wc.executeJavaScript.mock.calls.filter((c: any[]) => c[0] === FOCUSED_CONTROL_PROBE)).toEqual([])
      closeAccountPane('sess-pop')
    })

    it(`${s.kind}: a key whose landing place cannot be read, or is read only after a newer key, lets nothing through`, async () => {
      const wc = await signedInView()
      const out = (n: number) => wc.handlers.__open(popup(`https://example.com/r${n}`, s.home))
      // The read fails.
      keyLandsOn(wc, () => { throw new Error('read failed') })
      press(wc, { key: 'Enter', code: 'Enter' }); out(1)
      await flush()
      // The read answers something that is not a plain yes.
      keyLandsOn(wc, () => 'true')
      press(wc, { key: 'Enter', code: 'Enter' }); out(2)
      await flush()
      expect(openedExternal).toEqual([])
      // A link's yes that lands after a key typed into the text box arms nothing.
      const answers: Array<(v: boolean) => void> = []
      keyLandsOn(wc, () => new Promise<boolean>((r) => { answers.push(r) }))
      press(wc, { key: 'Enter', code: 'Enter' })
      press(wc, { key: ' ', code: 'Space' })
      answers[1](false)
      answers[0](true)
      await flush(); await flush()
      out(3)
      await flush()
      expect(openedExternal).toEqual([])
      // A click while a key's read is still out lets one through at once.
      press(wc, { key: 'Enter', code: 'Enter' })
      click(wc)
      out(4)
      expect(openedExternal).toEqual(['https://example.com/r4'])
      answers[2](true)
      await flush()
      closeAccountPane('sess-pop')
    })

    it(`${s.kind}: a key whose landing place is never read lets nothing through once its second is up`, async () => {
      const wc = await signedInView()
      keyLandsOn(wc, () => new Promise<boolean>(() => { /* never answers */ }))
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        press(wc, { key: 'Enter', code: 'Enter' })
        wc.handlers.__open(popup('https://example.com/never', s.home))
        await vi.advanceTimersByTimeAsync(1_001)
        expect(openedExternal).toEqual([])
      } finally {
        vi.useRealTimers()
      }
      closeAccountPane('sess-pop')
    })

    it(`${s.kind}: a popup off the service that names the page that opened it reaches the browser only when that page is the service's own`, async () => {
      const wc = await signedInView()
      for (const from of ['https://embed.thirdparty.example/frame', 'not a url', 'about:srcdoc', 'about:blank', ' ']) {
        click(wc)
        expect(wc.handlers.__open(popup('https://example.com/elsewhere', from))).toEqual({ action: 'deny' })
        await flush()
      }
      expect(openedExternal).toEqual([])
      // A refused popup does not use up the click: the service's own popup after it still goes.
      click(wc)
      wc.handlers.__open(popup('https://example.com/elsewhere', 'https://embed.thirdparty.example/frame'))
      wc.handlers.__open(popup('https://example.com/paper', s.home))
      expect(openedExternal).toEqual(['https://example.com/paper'])
      expect(logged.filter((l) => /did not open a popup/.test(l)).join('\n')).not.toMatch(/elsewhere|thirdparty/)
      closeAccountPane('sess-pop')
    })

    it(`${s.kind}: a link that opens in a new tab and sends no referrer reaches the browser after a click, a tap or a key on it, once each, and never without one`, async () => {
      const wc = await signedInView()
      // No input yet: nothing, whatever the link.
      expect(wc.handlers.__open(newTabLink('https://example.com/source-0'))).toEqual({ action: 'deny' })
      expect(wc.handlers.__open(popup('https://example.com/source-0b'))).toEqual({ action: 'deny' })
      expect(openedExternal).toEqual([])
      // A click on such a link: it opens in the browser, once.
      click(wc)
      expect(wc.handlers.__open(newTabLink('https://example.com/source-1'))).toEqual({ action: 'deny' })
      wc.handlers.__open(newTabLink('https://example.com/source-1-again'))
      expect(openedExternal).toEqual(['https://example.com/source-1'])
      // A tap, and a page that names no opener at all: the same.
      tap(wc)
      wc.handlers.__open(popup('https://example.com/source-2'))
      expect(openedExternal).toEqual(['https://example.com/source-1', 'https://example.com/source-2'])
      // Enter on the link: the same, once its landing place is read.
      keyLandsOn(wc, () => true)
      press(wc, { key: 'Enter', code: 'Enter' })
      wc.handlers.__open(newTabLink('https://example.com/source-3'))
      await flush(); await flush()
      expect(openedExternal).toEqual(['https://example.com/source-1', 'https://example.com/source-2', 'https://example.com/source-3'])
      // Enter typed into the message box lets no such link out.
      keyLandsOn(wc, () => false)
      press(wc, { key: 'Enter', code: 'Enter' })
      wc.handlers.__open(newTabLink('https://example.com/source-4'))
      await flush(); await flush()
      expect(openedExternal).toHaveLength(3)
      // Right after a click, a popup that names a page from elsewhere stays refused and uses none of the click.
      click(wc)
      wc.handlers.__open(popup('https://example.com/source-5', 'https://embed.thirdparty.example/frame'))
      wc.handlers.__open(newTabLink('https://example.com/source-6'))
      expect(openedExternal).toEqual(['https://example.com/source-1', 'https://example.com/source-2', 'https://example.com/source-3', 'https://example.com/source-6'])
      // Such a link to the service itself is still not followed into the view.
      click(wc)
      wc.handlers.__open(newTabLink(s.page))
      expect(wc.loadURL).not.toHaveBeenCalled()
      expect(openedExternal).toHaveLength(4)
      closeAccountPane('sess-pop')
    })

    it(`${s.kind}: a popup or a link asked for before your click is not let through by that click`, async () => {
      const wc = await signedInView()
      const nav = (url: string) => { const e = { preventDefault: vi.fn(), isMainFrame: true }; wc.handlers['will-navigate'](e, url); return e }
      const answers: Array<(v: boolean) => void> = []
      keyLandsOn(wc, () => new Promise<boolean>((r) => { answers.push(r) }))
      // A Space typed into the message box, its landing place still being read;
      // the page asks for a popup, a link and a service popup now, with no click yet.
      press(wc, { key: ' ', code: 'Space' })
      wc.handlers.__open(popup('https://example.com/early', s.home))
      wc.handlers.__open(newTabLink('https://example.com/early-tab'))
      nav('https://example.com/early-nav')
      wc.handlers.__open(popup(s.page, s.home))
      // The user clicks something afterwards; then the read answers.
      click(wc)
      answers[0](false)
      await flush(); await flush()
      expect(openedExternal).toEqual([])
      expect(wc.loadURL).not.toHaveBeenCalled()
      // Those refusals used none of the click: a popup asked for after it goes.
      wc.handlers.__open(popup('https://example.com/after', s.home))
      expect(openedExternal).toEqual(['https://example.com/after'])
      // The same when the key was on a link but a click came before its read answered:
      // the requests made before the click wait for the key, which the click replaced.
      press(wc, { key: 'Enter', code: 'Enter' })
      wc.handlers.__open(popup('https://example.com/early-2', s.home))
      click(wc)
      answers[1](true)
      await flush(); await flush()
      expect(openedExternal).toEqual(['https://example.com/after'])
      // A key on a link with no click after it: the request made while its read was out goes, once.
      press(wc, { key: 'Enter', code: 'Enter' })
      wc.handlers.__open(popup('https://example.com/keyed', s.home))
      wc.handlers.__open(popup('https://example.com/keyed-again', s.home))
      answers[2](true)
      await flush(); await flush()
      expect(openedExternal).toEqual(['https://example.com/after', 'https://example.com/keyed'])
      // A key on a link pressed after the request, whose read answers first, does not let it through either.
      press(wc, { key: ' ', code: 'Space' })
      wc.handlers.__open(popup('https://example.com/early-3', s.home))
      press(wc, { key: 'Enter', code: 'Enter' })
      answers[4](true)
      await flush(); await flush()
      answers[3](false)
      await flush(); await flush()
      expect(openedExternal).toEqual(['https://example.com/after', 'https://example.com/keyed'])
      // That later key's own hand-off still goes.
      wc.handlers.__open(popup('https://example.com/later-key', s.home))
      expect(openedExternal).toEqual(['https://example.com/after', 'https://example.com/keyed', 'https://example.com/later-key'])
      closeAccountPane('sess-pop')
    })

    it(`${s.kind}: a key's second runs from the key press, not from when its landing place was read`, async () => {
      const wc = await signedInView()
      const now = vi.spyOn(performance, 'now')
      try {
        const answers: Array<(v: boolean) => void> = []
        keyLandsOn(wc, () => new Promise<boolean>((r) => { answers.push(r) }))
        // Enter on a link at T; the read answers 900 ms later; a popup at T + 1.5 s: refused.
        now.mockReturnValue(3_000_000)
        press(wc, { key: 'Enter', code: 'Enter' })
        now.mockReturnValue(3_000_000 + 900)
        answers[0](true)
        await flush(); await flush()
        now.mockReturnValue(3_000_000 + 1_500)
        wc.handlers.__open(popup('https://example.com/late', s.home))
        wc.handlers.__open(newTabLink('https://example.com/late-tab'))
        wc.handlers.__open(popup(s.page, s.home))
        await flush()
        expect(openedExternal).toEqual([])
        expect(wc.loadURL).not.toHaveBeenCalled()
        // The same late answer with a popup inside the key's own second: it goes.
        now.mockReturnValue(4_000_000)
        press(wc, { key: 'Enter', code: 'Enter' })
        now.mockReturnValue(4_000_000 + 900)
        answers[1](true)
        await flush(); await flush()
        now.mockReturnValue(4_000_000 + 950)
        wc.handlers.__open(popup('https://example.com/in-time', s.home))
        expect(openedExternal).toEqual(['https://example.com/in-time'])
      } finally {
        now.mockRestore()
      }
      closeAccountPane('sess-pop')
    })

    it(`${s.kind}: a link off the service in the view itself reaches the browser only after a click, once per click`, async () => {
      const wc = await signedInView()
      const nav = (url: string) => { const e = { preventDefault: vi.fn(), isMainFrame: true }; wc.handlers['will-navigate'](e, url); return e }
      expect(nav('https://example.com/paper').preventDefault).toHaveBeenCalled()
      expect(openedExternal).toEqual([])
      click(wc)
      nav('https://example.com/paper')
      nav('https://example.com/again')
      expect(openedExternal).toEqual(['https://example.com/paper'])
      // A redirect off the service right after the click: the same rule.
      click(wc)
      wc.handlers['will-redirect']({ preventDefault: vi.fn(), isMainFrame: true }, 'https://example.com/redirected')
      expect(openedExternal).toEqual(['https://example.com/paper', 'https://example.com/redirected'])
      closeAccountPane('sess-pop')
    })

    it(`${s.kind}: Escape still closes the view, and a refused popup is logged by host only`, async () => {
      const win = new FakeParentWindow()
      const wc = await signedInView(win)
      press(wc, { key: 'Escape', code: 'Escape' })
      expect(win.webContents.send).toHaveBeenCalledWith('webview:escapePressed', 'sess-pop')
      logged.length = 0
      wc.handlers.__open(popup('https://example.com/paper?token=POPUP-VALUE#frag', s.home))
      wc.handlers.__open(popup(`${s.page}?q=POPUP-VALUE`, 'https://frames.example/x'))
      const lines = logged.filter((l) => /popup/.test(l))
      expect(lines.length).toBe(2)
      expect(lines.join('\n')).toContain('example.com')
      expect(lines.join('\n')).not.toMatch(/POPUP-VALUE|\/paper|frag|\?/)
      closeAccountPane('sess-pop')
    })
  }
})

describe('[host] where a key landed: Enter or Space counts only on a link or a button (a menu item among them), never in a text box', () => {
  type El = Record<string, unknown>
  /** A focused element as the read sees it, in a world of its own: no page script can change these. */
  const el = (tagName: string, o: { attrs?: Record<string, string>; type?: string; editable?: boolean; shadowFocus?: El | null; frame?: 'other-site' | El | null } = {}): El => ({
    tagName,
    type: o.type ?? '',
    isContentEditable: o.editable === true,
    getAttribute: (n: string) => (o.attrs && n in o.attrs ? o.attrs[n] : null),
    hasAttribute: (n: string) => !!o.attrs && n in o.attrs,
    shadowRoot: o.shadowFocus !== undefined ? { activeElement: o.shadowFocus } : null,
    // A frame from another site gives no document; a frame of the page's own gives its focus.
    contentDocument: o.frame === undefined || o.frame === 'other-site' ? null : { activeElement: o.frame },
  })
  const landsOnControl = (active: El | null) => vm.runInNewContext(String(FOCUSED_CONTROL_PROBE), { document: { activeElement: active } })

  it('a link, a button, a menu item or a form button counts', () => {
    const yes: Array<[string, El]> = [
      ['a link', el('A', { attrs: { href: '/x' } })],
      ['an image-map link', el('AREA', { attrs: { href: '/x' } })],
      ['a button', el('BUTTON')],
      ['a summary', el('SUMMARY')],
      ['a submit input', el('INPUT', { type: 'submit' })],
      ['a button input', el('INPUT', { type: 'button' })],
      ['an image input', el('INPUT', { type: 'image' })],
      ['a reset input', el('INPUT', { type: 'reset' })],
      ['role=button', el('DIV', { attrs: { role: 'button' } })],
      ['role=link', el('SPAN', { attrs: { role: 'link' } })],
      ['role=menuitem', el('DIV', { attrs: { role: 'menuitem' } })],
      ['role=menuitemcheckbox', el('DIV', { attrs: { role: 'menuitemcheckbox' } })],
      ['role=menuitemradio', el('DIV', { attrs: { role: 'MenuItemRadio' } })],
      ['a button inside a shadow root', el('X-WIDGET', { shadowFocus: el('BUTTON') })],
      ["a link inside a frame of the page's own", el('IFRAME', { frame: el('A', { attrs: { href: '/x' } }) })],
    ]
    for (const [what, e] of yes) expect(landsOnControl(e), what).toBe(true)
  })

  it('a text box, the page itself, an editable element or a frame from another site does not', () => {
    const no: Array<[string, El | null]> = [
      ['nothing focused', null],
      ['the page body', el('BODY')],
      ['a text area', el('TEXTAREA')],
      ['a text input', el('INPUT', { type: 'text' })],
      ['a search input', el('INPUT', { type: 'search' })],
      ['an input of no type', el('INPUT')],
      ['a check box', el('INPUT', { type: 'checkbox' })],
      ['a file input', el('INPUT', { type: 'file' })],
      ['an editable composer', el('DIV', { editable: true })],
      ['role=textbox', el('DIV', { attrs: { role: 'textbox' }, editable: true })],
      ['an editable button', el('BUTTON', { editable: true })],
      ['an editable role=button', el('DIV', { attrs: { role: 'button' }, editable: true })],
      ['a link that is a text box by role', el('A', { attrs: { href: '/x', role: 'textbox' } })],
      ['a link with no address', el('A')],
      ['a plain element', el('DIV')],
      ['role=presentation', el('DIV', { attrs: { role: 'presentation' } })],
      ['a text area inside a shadow root', el('X-EDITOR', { shadowFocus: el('TEXTAREA') })],
      ['a frame from another site', el('IFRAME', { frame: 'other-site' })],
      ["a text box inside a frame of the page's own", el('IFRAME', { frame: el('TEXTAREA') })],
    ]
    for (const [what, e] of no) expect(landsOnControl(e), what).toBe(false)
  })

  it('a text area, an input that takes typed text, or a choice box never counts, whatever role it is given', () => {
    const no: Array<[string, El]> = [
      ['a text area given the button role', el('TEXTAREA', { attrs: { role: 'button' } })],
      ['a text area given the link role', el('TEXTAREA', { attrs: { role: 'link' } })],
      ['a text input given the link role', el('INPUT', { type: 'text', attrs: { role: 'link' } })],
      ['an input of no type given the menu item role', el('INPUT', { attrs: { role: 'menuitem' } })],
      ['a search input given the button role', el('INPUT', { type: 'search', attrs: { role: 'button' } })],
      ['an email input given the button role', el('INPUT', { type: 'EMAIL', attrs: { role: 'button' } })],
      ['an address input given the link role', el('INPUT', { type: 'url', attrs: { role: 'link' } })],
      ['a phone input given the button role', el('INPUT', { type: 'tel', attrs: { role: 'button' } })],
      ['a password input given the button role', el('INPUT', { type: 'password', attrs: { role: 'button' } })],
      ['a number input given the button role', el('INPUT', { type: 'number', attrs: { role: 'button' } })],
      ['a date input given the button role', el('INPUT', { type: 'date', attrs: { role: 'button' } })],
      ['an input of a type the page made up, given the link role', el('INPUT', { type: 'x-made-up', attrs: { role: 'link' } })],
      ['a choice box given the button role', el('SELECT', { attrs: { role: 'button' } })],
      ['a plain choice box', el('SELECT')],
      ['a text area given the button role inside a shadow root', el('X-EDITOR', { shadowFocus: el('TEXTAREA', { attrs: { role: 'button' } }) })],
      ["a text input given the link role inside a frame of the page's own", el('IFRAME', { frame: el('INPUT', { type: 'text', attrs: { role: 'link' } }) })],
    ]
    for (const [what, e] of no) expect(landsOnControl(e), what).toBe(false)
    // A form button keeps its role, and so does a check box or a radio in a menu.
    const yes: Array<[string, El]> = [
      ['a button input given the link role', el('INPUT', { type: 'button', attrs: { role: 'link' } })],
      ['an image input given the menu item role', el('INPUT', { type: 'image', attrs: { role: 'menuitem' } })],
      ['a check box in a menu', el('INPUT', { type: 'checkbox', attrs: { role: 'menuitemcheckbox' } })],
      ['a radio in a menu', el('INPUT', { type: 'radio', attrs: { role: 'menuitemradio' } })],
    ]
    for (const [what, e] of yes) expect(landsOnControl(e), what).toBe(true)
  })

  it('a document that throws, or nests without end, does not', () => {
    expect(vm.runInNewContext(String(FOCUSED_CONTROL_PROBE), { document: { get activeElement() { throw new Error('x') } } })).toBe(false)
    // A button whose focus never ends in an element: not a control the key landed on.
    const loop: El = { tagName: 'BUTTON', isContentEditable: false, getAttribute: () => null, hasAttribute: () => false, contentDocument: null }
    loop.shadowRoot = { activeElement: loop }
    expect(landsOnControl(loop)).toBe(false)
  })
})
