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
  closeAllAccountPanes, getAccountPaneState, codexPaneNavDecision,
} = await import('../../src/main/account-web/account-pane')
const { webPartitionForCodexAccount, webPartitionForProfile, CODEX_WEB_SERVICE } = await import('../../src/shared/account-web-session')
const { getCodexWebSession, saveCodexWebSession, removeCodexWebSession, codexWebViewFor } = await import('../../src/main/account-web/codex-web-store')

const ACCT = 'acct-0123456789abcdef'
const ACCT2 = 'acct-fedcba9876543210'
const BOUNDS = { x: 0, y: 0, width: 800, height: 600 }
const TOKEN_COOKIE = [{ name: '__Secure-next-auth.session-token', expirationDate: 4102444800 }]
const IDP = `https://${CODEX_WEB_SERVICE.signInHosts[0]}/authorize`
const flush = () => new Promise((r) => setTimeout(r, 0))

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
    for (const bad of ['https://evil.example/', 'https://login.microsoftonline.com/x', 'https://chatgpt.com.evil.example/', `https://${CODEX_WEB_SERVICE.signInHosts[0]}:8443/`]) {
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
    expect(wc.handlers.__open({ url: IDP })).toEqual({ action: 'deny' })
    expect(wc.loadURL).not.toHaveBeenCalled()
    expect(wc.handlers.__open({ url: 'https://chatgpt.com/c/2' })).toEqual({ action: 'deny' })
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
      // A popup to the service's own URL is followed in this view.
      wc.handlers.__open({ url: 'https://chatgpt.com/c/2?q=SECRET' })
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
  it('a record that cannot be written: the session is cleared, never left live without one', async () => {
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
