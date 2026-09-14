// #439/#475 — the pane's account VIEW: the invariants a mutation could break
// silently (same lesson as the artifacts-window tests: partition, sandbox,
// nav guards and teardown live in side-effecting code no pure test covers).
import { describe, it, expect, vi, beforeEach } from 'vitest'

const createdViews: { opts: any; view: any }[] = []
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
    setDevicePermissionHandler: vi.fn(),
    sessionEvents: {} as Record<string, Function>,
    on(ev: string, fn: Function) { this.sessionEvents[ev] = fn },
    cookies: {
      listeners: [] as any[],
      get: vi.fn(async () => []),
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
      loadURL: vi.fn(async () => {}),
      close() { this.destroyed = true },
      isDestroyed() { return this.destroyed },
      executeJavaScript: vi.fn(async () => null),
      currentUrl: 'https://claude.ai/artifacts',
      getURL() { return this.currentUrl },
      getTitle: () => 'Artifacts',
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      reloadIgnoringCache: vi.fn(),
    }
    createdViews.push({ opts, view: this })
  }
  setBounds(b: any) { this.bounds = b }
}

let nextWindowId = 1
class FakeParentWindow {
  id = nextWindowId++
  contentView = {
    children: [] as any[],
    addChildView: (v: any) => { this.contentView.children.push(v) },
    removeChildView: (v: any) => { this.contentView.children = this.contentView.children.filter((x) => x !== v) },
  }
  webContents = { send: vi.fn() }
  closedCb?: () => void
  once(ev: string, fn: () => void) { if (ev === 'closed') this.closedCb = fn }
  on(_ev: string, _fn: () => void) { /* noop */ }
  isDestroyed() { return false }
}

vi.mock('electron', () => ({
  BrowserWindow: class {},
  WebContentsView: FakeWebContentsView,
  shell: { openExternal: async (u: string) => { openedExternal.push(u) } },
  session: { fromPartition: (p: string) => fakeSession(p) },
}))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

/** In-memory session-store file so recording is observable without disk. */
const fake = { disk: null as unknown }
vi.mock('../../src/main/channel-storage', () => ({
  readJsonFile: (_n: string, seed: () => unknown) => (fake.disk ?? seed()),
  writeJsonFile: (_n: string, v: unknown) => { fake.disk = JSON.parse(JSON.stringify(v)) },
}))

const {
  openAccountPane,
  closeAccountPane,
  closeAccountPanesForProfile,
  closeAllAccountPanes,
  getAccountPaneState,
} = await import('../../src/main/account-web/account-pane')
const { webPartitionForProfile } = await import('../../src/shared/account-web-session')

const BOUNDS = { x: 0, y: 0, width: 800, height: 600 }

beforeEach(() => {
  // The module registry is per-import; close anything a prior test left open
  // BEFORE resetting the fakes it will unhook from.
  closeAllAccountPanes()
  createdViews.length = 0
  openedExternal.length = 0
  for (const k of Object.keys(partitions)) delete partitions[k]
  fake.disk = null
})

describe('the account view', () => {
  it('opens on THAT ACCOUNT’S partition — never the pane’s throwaway one', () => {
    const win = new FakeParentWindow()
    expect(openAccountPane(win as never, 'sess-a', 'profile-p1a', BOUNDS).ok).toBe(true)
    expect(openAccountPane(win as never, 'sess-b', 'profile-p1b', BOUNDS).ok).toBe(true)
    const parts = createdViews.map((c) => c.opts.webPreferences.partition)
    expect(parts[0]).toBe(webPartitionForProfile('profile-p1a'))
    expect(parts[1]).toBe(webPartitionForProfile('profile-p1b'))
    expect(parts[0]).not.toBe(parts[1])
    expect(parts[0]).not.toContain('webview-')
  })

  it('is sandboxed with no bridge into the main process, denies permission REQUESTS but not CHECKS, and blocks downloads', () => {
    const win = new FakeParentWindow()
    openAccountPane(win as never, 'sess-c', 'profile-p1a', BOUNDS)
    const wp = createdViews[0].opts.webPreferences
    expect(wp.sandbox).toBe(true)
    expect(wp.contextIsolation).toBe(true)
    expect(wp.nodeIntegration).toBe(false)
    expect(wp.preload).toBeUndefined()
    const ses = partitions[webPartitionForProfile('profile-p1a')]
    // Active permission requests (camera/mic/etc.) denied…
    expect(ses.permissionRequestHandlers.length).toBeGreaterThan(0)
    const cb = vi.fn()
    ses.permissionRequestHandlers[0](null, 'media', cb)
    expect(cb).toHaveBeenCalledWith(false)
    // …but NO blanket permission-CHECK handler (that would kill claude.ai's
    // clipboard Copy, matching the artifacts window's posture, not the
    // throwaway partition's).
    expect(ses.setPermissionCheckHandler).not.toHaveBeenCalled()
    // Downloads blocked (the hardening step the account partition lacked).
    const dl = ses.sessionEvents['will-download']
    expect(typeof dl).toBe('function')
    const ev = { preventDefault: vi.fn() }
    dl(ev, { getURL: () => 'https://claude.ai/x.exe' })
    expect(ev.preventDefault).toHaveBeenCalled()
  })

  it('never stacks two pane views on one window (the arbiter): a second account view detaches the first', () => {
    const win = new FakeParentWindow()
    openAccountPane(win as never, 'sess-a1', 'profile-p1a', BOUNDS)
    expect(win.contentView.children).toHaveLength(1)
    openAccountPane(win as never, 'sess-a2', 'profile-p1b', BOUNDS)
    // Two entries, but only ONE view attached — no overlay/clickjack surface.
    expect(win.contentView.children).toHaveLength(1)
    expect(win.contentView.children[0]).toBe(createdViews[1].view)
    closeAccountPane('sess-a1'); closeAccountPane('sess-a2')
  })

  it('refuses to record when the VIEW is not on claude.ai (a page reached via any nav gap cannot answer as the account)', async () => {
    const win = new FakeParentWindow()
    openAccountPane(win as never, 'sess-inj', 'profile-inj1', BOUNDS)
    const ses = partitions[webPartitionForProfile('profile-inj1')]
    const view = createdViews[0].view
    const flush = () => new Promise((r) => setTimeout(r, 0))
    await flush()
    // The pane is parked on a hostile origin; the page would happily answer an
    // attacker email, but recording is gated on the current URL.
    view.webContents.currentUrl = 'https://evil.example/landing'
    view.webContents.executeJavaScript.mockResolvedValue('attacker@evil.example')
    ses.cookies.get.mockResolvedValue([{ name: 'sessionKey', expirationDate: 4102444800 }])
    ses.cookies.listeners[0](null, { name: 'sessionKey' })
    await flush(); await flush(); await flush()
    const stored = ((fake.disk as { sessions?: unknown[] } | null)?.sessions ?? [])
    // A record may exist (the cookie is real), but it never carries the
    // attacker email the off-claude.ai page tried to inject.
    for (const r of stored as Array<{ accountEmail: string | null }>) {
      expect(r.accountEmail).not.toBe('attacker@evil.example')
    }
    closeAccountPane('sess-inj')
  })

  it('recalls the view to the account start page when the session goes live while parked OFF claude.ai (A1)', async () => {
    const win = new FakeParentWindow()
    openAccountPane(win as never, 'sess-recall', 'profile-recall1', BOUNDS)
    const ses = partitions[webPartitionForProfile('profile-recall1')]
    const view = createdViews[0].view
    const flush = () => new Promise((r) => setTimeout(r, 0))
    await flush() // authed=false confirmed
    view.webContents.loadURL.mockClear()
    // Parked on an attacker origin (an IdP hop / open-redirect the pre-auth rule
    // allowed), the session then goes live on the shared partition.
    view.webContents.currentUrl = 'https://evil.example/landing'
    ses.cookies.get.mockResolvedValue([{ name: 'sessionKey', expirationDate: 4102444800 }])
    ses.cookies.listeners[0](null, { name: 'sessionKey' })
    await flush(); await flush()
    // The session-bearing view must not sit on the attacker origin — recalled.
    expect(view.webContents.loadURL).toHaveBeenCalledWith('https://claude.ai/artifacts')
    closeAccountPane('sess-recall')
  })

  it('recalls the view even when the cookie lands mid-navigation (getURL still on claude.ai at the edge)', async () => {
    const win = new FakeParentWindow()
    openAccountPane(win as never, 'sess-midnav', 'profile-midnav1', BOUNDS)
    const ses = partitions[webPartitionForProfile('profile-midnav1')]
    const view = createdViews[0].view
    const flush = () => new Promise((r) => setTimeout(r, 0))
    await flush() // authed=false
    // The cookie lands while a nav to the attacker origin is still PENDING:
    // getURL() is still the committed claude.ai URL, so the edge check would
    // have skipped a false->true-gated recall.
    view.webContents.loadURL.mockClear()
    ses.cookies.get.mockResolvedValue([{ name: 'sessionKey', expirationDate: 4102444800 }])
    ses.cookies.listeners[0](null, { name: 'sessionKey' }) // authed -> true, still on claude.ai
    await flush(); await flush()
    expect(view.webContents.loadURL).not.toHaveBeenCalled() // nothing to recall yet
    // The pending nav now commits off-site; the next refresh (a did-navigate)
    // sees authed already true AND off-claude.ai — the recall is NOT edge-gated.
    view.webContents.currentUrl = 'https://evil.example/landing'
    ses.cookies.listeners[0](null, { name: 'sessionKey' })
    await flush(); await flush()
    expect(view.webContents.loadURL).toHaveBeenCalledWith('https://claude.ai/artifacts')
    closeAccountPane('sess-midnav')
  })

  it('guards the MAIN frame only — a cross-origin sub-frame (Turnstile/Stripe) is left to same-origin policy, never handed to the OS', async () => {
    const win = new FakeParentWindow()
    openAccountPane(win as never, 'sess-frame', 'profile-p1a', BOUNDS)
    const ses = partitions[webPartitionForProfile('profile-p1a')]
    const nav = createdViews[0].view.webContents.handlers['will-navigate'] as (e: { preventDefault: () => void; isMainFrame?: boolean }, url: string) => void
    // Sign in so an off-site main-frame nav would go external.
    ses.cookies.get.mockResolvedValue([{ name: 'sessionKey', expirationDate: 4102444800 }])
    ses.cookies.listeners[0](null, { name: 'sessionKey' })
    await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0))
    openedExternal.length = 0

    // A cross-origin https SUB-frame (isMainFrame:false): NOT prevented, NOT
    // sent to the OS browser — an iframe must not be able to launch OS tabs.
    const sub = { preventDefault: vi.fn(), isMainFrame: false }
    nav(sub, 'https://challenges.cloudflare.com/turnstile/x')
    expect(sub.preventDefault).not.toHaveBeenCalled()
    expect(openedExternal).toHaveLength(0)

    // A NON-https sub-frame is still refused (scheme parity), but never external.
    const badSub = { preventDefault: vi.fn(), isMainFrame: false }
    nav(badSub, 'file:///C:/secrets')
    expect(badSub.preventDefault).toHaveBeenCalled()
    expect(openedExternal).toHaveLength(0)

    // A MAIN-frame off-site nav IS handed to the OS browser (one tab, gestured).
    const main = { preventDefault: vi.fn(), isMainFrame: true }
    nav(main, 'https://example.com/paper')
    expect(main.preventDefault).toHaveBeenCalled()
    expect(openedExternal).toEqual(['https://example.com/paper'])
    closeAccountPane('sess-frame')
  })

  it('a slower earlier cookie read cannot clobber a newer one (A8 generation guard)', async () => {
    const win = new FakeParentWindow()
    openAccountPane(win as never, 'sess-seq', 'profile-seq1', BOUNDS)
    const ses = partitions[webPartitionForProfile('profile-seq1')]
    const flush = () => new Promise((r) => setTimeout(r, 0))
    await flush()
    // read #1 (issued first) resolves LAST with an empty jar; read #2 resolves
    // first with the live cookie. The stale empty result must not win.
    let resolve1: (v: unknown) => void = () => {}
    ses.cookies.get.mockImplementationOnce(() => new Promise((r) => { resolve1 = r }))
    ses.cookies.get.mockResolvedValueOnce([{ name: 'sessionKey', expirationDate: 4102444800 }])
    // fire two refreshes: the first hangs, the second (newer seq) resolves.
    ses.cookies.listeners[0](null, { name: 'sessionKey' })
    ses.cookies.listeners[0](null, { name: 'sessionKey' })
    await flush()
    resolve1([]) // the stale read finally returns "no cookie"
    await flush(); await flush()
    // authed stayed true (the newer read won); an off-site nav is now external.
    const nav = createdViews[0].view.webContents.handlers['will-navigate'] as (e: { preventDefault: () => void }, url: string) => void
    const off = { preventDefault: vi.fn() }
    nav(off, 'https://example.com/x')
    expect(off.preventDefault).toHaveBeenCalled() // external, not allowed in-view
    closeAccountPane('sess-seq')
  })

  it('a crashed view is evicted and the renderer told to leave account mode', () => {
    const win = new FakeParentWindow()
    openAccountPane(win as never, 'sess-crash', 'profile-p1a', BOUNDS)
    expect(getAccountPaneState('sess-crash')).not.toBeNull()
    createdViews[0].view.webContents.handlers['render-process-gone']()
    expect(getAccountPaneState('sess-crash')).toBeNull()
    // The renderer got a PANE_CLOSED for this session.
    const sent = (win.webContents.send as any).mock.calls.map((c: any[]) => c[1])
    expect(sent.some((p: any) => p?.sessionId === 'sess-crash')).toBe(true)
  })

  it('refuses a malformed profile id or session id, creating nothing', () => {
    const win = new FakeParentWindow()
    expect(openAccountPane(win as never, 'sess-d', '../evil', BOUNDS).ok).toBe(false)
    expect(openAccountPane(win as never, 'a/../b', 'profile-p1a', BOUNDS).ok).toBe(false)
    expect(createdViews).toHaveLength(0)
  })

  const flushNav = () => new Promise((r) => setTimeout(r, 0))

  it('wires the nav guard: non-https prevented; claude.ai allowed; unknown fails closed; confirmed-signed-out allows the IdP hop; post-auth off-site → external', async () => {
    const win = new FakeParentWindow()
    openAccountPane(win as never, 'sess-nav', 'profile-nav1', BOUNDS)
    const ses = partitions[webPartitionForProfile('profile-nav1')]
    const nav = createdViews[0].view.webContents.handlers['will-navigate'] as (e: { preventDefault: () => void }, url: string) => void
    expect(nav).toBeDefined()

    const blocked = { preventDefault: vi.fn() }
    nav(blocked, 'file:///C:/secrets')
    expect(blocked.preventDefault).toHaveBeenCalled()

    const allowed = { preventDefault: vi.fn() }
    nav(allowed, 'https://claude.ai/login')
    expect(allowed.preventDefault).not.toHaveBeenCalled()

    // authed=null (first read may still be in flight): off-site FAILS CLOSED.
    const unknownIdp = { preventDefault: vi.fn() }
    nav(unknownIdp, 'https://login.microsoftonline.com/x')
    expect(unknownIdp.preventDefault).toHaveBeenCalled()

    // Once the first read confirms NO cookie (authed=false), the IdP hop opens.
    ses.cookies.get.mockResolvedValue([])
    await flushNav()
    const idp = { preventDefault: vi.fn() }
    nav(idp, 'https://login.microsoftonline.com/x')
    expect(idp.preventDefault).not.toHaveBeenCalled()
    expect(openedExternal).toHaveLength(0)

    // Signed in (authed=true): an off-site link is handed to the real browser.
    ses.cookies.get.mockResolvedValue([{ name: 'sessionKey', expirationDate: 4102444800 }])
    ses.cookies.listeners[0](null, { name: 'sessionKey' })
    await flushNav(); await flushNav()
    const offsite = { preventDefault: vi.fn() }
    nav(offsite, 'https://example.com/paper')
    expect(offsite.preventDefault).toHaveBeenCalled()
    expect(openedExternal).toContain('https://example.com/paper')
    closeAccountPane('sess-nav')
  })

  it('sign-out tears down every pane for that profile and detaches the native view', () => {
    const win = new FakeParentWindow()
    openAccountPane(win as never, 'sess-t1', 'profile-teardown', BOUNDS)
    openAccountPane(win as never, 'sess-t2', 'profile-teardown', BOUNDS)
    // The arbiter keeps ONE view attached per window — opening t2 detached t1 —
    // but both entries are tracked and both are torn down.
    expect(win.contentView.children).toHaveLength(1)
    expect(getAccountPaneState('sess-t1')).not.toBeNull()
    expect(getAccountPaneState('sess-t2')).not.toBeNull()
    closeAccountPanesForProfile('profile-teardown')
    expect(win.contentView.children).toHaveLength(0)
    expect(getAccountPaneState('sess-t1')).toBeNull()
    expect(getAccountPaneState('sess-t2')).toBeNull()
    expect(createdViews.every((c) => c.view.webContents.destroyed)).toBe(true)
    // The cookie listeners went with them — no leak on the shared partition.
    expect(partitions[webPartitionForProfile('profile-teardown')].cookies.listeners).toHaveLength(0)
  })

  it('replaces the view when the SAME session switches account', () => {
    const win = new FakeParentWindow()
    openAccountPane(win as never, 'sess-sw', 'profile-p1a', BOUNDS)
    openAccountPane(win as never, 'sess-sw', 'profile-p1b', BOUNDS)
    expect(win.contentView.children).toHaveLength(1)
    expect(getAccountPaneState('sess-sw')?.profileId).toBe('profile-p1b')
    expect(createdViews[0].view.webContents.destroyed).toBe(true)
    closeAccountPane('sess-sw')
  })
})

describe('sign-in recording from the pane', () => {
  const SESSION_COOKIE = [{ name: 'sessionKey', expirationDate: 4102444800 }]
  const flush = () => new Promise((r) => setTimeout(r, 0))
  const storedSessions = () => ((fake.disk as { sessions?: unknown[] } | null)?.sessions ?? [])

  it('records the session — with the email — once the cookie lands while the pane is open', async () => {
    const win = new FakeParentWindow()
    openAccountPane(win as never, 'sess-rec', 'profile-rec1', BOUNDS)
    const ses = partitions[webPartitionForProfile('profile-rec1')]
    const view = createdViews[0].view
    await flush() // initial refreshAuthed: no cookie -> authed false
    ses.cookies.get.mockResolvedValue(SESSION_COOKIE)
    view.webContents.executeJavaScript.mockResolvedValue('me@example.com')
    // The partition cookie watch is the sign-in detector.
    ses.cookies.listeners[0](null, { name: 'sessionKey' })
    await flush(); await flush(); await flush()
    const rec = storedSessions()[0] as { profileId: string; accountEmail: string; origin: string } | undefined
    expect(rec).toBeDefined()
    expect(rec!.profileId).toBe('profile-rec1')
    expect(rec!.accountEmail).toBe('me@example.com')
    expect(rec!.origin).toBe('in-pane')
    closeAccountPane('sess-rec')
  })

  it('an in-flight recording refuses to write after the pane closed (the sign-out race)', async () => {
    const win = new FakeParentWindow()
    openAccountPane(win as never, 'sess-race', 'profile-race1', BOUNDS)
    const ses = partitions[webPartitionForProfile('profile-race1')]
    const view = createdViews[0].view
    await flush()
    ses.cookies.get.mockResolvedValue(SESSION_COOKIE)
    // The email read hangs until AFTER the close — the exact window in which
    // in-app-sign-in.ts documents the record-over-empty-partition failure.
    let resolveEmail: (v: string) => void = () => {}
    view.webContents.executeJavaScript.mockImplementation(() => new Promise((r) => { resolveEmail = r }))
    ses.cookies.listeners[0](null, { name: 'sessionKey' })
    await flush()
    closeAccountPane('sess-race')
    resolveEmail('too@late.example')
    await flush(); await flush()
    expect(storedSessions()).toHaveLength(0)
  })

  it('refuses to write when the recheck finds the cookie already gone', async () => {
    const win = new FakeParentWindow()
    openAccountPane(win as never, 'sess-gone', 'profile-gone1', BOUNDS)
    const ses = partitions[webPartitionForProfile('profile-gone1')]
    const view = createdViews[0].view
    await flush()
    ses.cookies.get.mockResolvedValueOnce(SESSION_COOKIE) // the transition read
    view.webContents.executeJavaScript.mockResolvedValue('me@example.com')
    ses.cookies.listeners[0](null, { name: 'sessionKey' })
    // Every later read (the recheck) sees an emptied partition.
    ses.cookies.get.mockResolvedValue([])
    await flush(); await flush(); await flush()
    expect(storedSessions()).toHaveLength(0)
    closeAccountPane('sess-gone')
  })
})
