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
      executeJavaScript: vi.fn(async () => null),
      getURL: () => 'https://claude.ai/artifacts',
      getTitle: () => 'Artifacts',
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

  it('is sandboxed with no bridge into the main process, and every permission denied', () => {
    const win = new FakeParentWindow()
    openAccountPane(win as never, 'sess-c', 'profile-p1a', BOUNDS)
    const wp = createdViews[0].opts.webPreferences
    expect(wp.sandbox).toBe(true)
    expect(wp.contextIsolation).toBe(true)
    expect(wp.nodeIntegration).toBe(false)
    expect(wp.preload).toBeUndefined()
    const ses = partitions[webPartitionForProfile('profile-p1a')]
    expect(ses.permissionRequestHandlers.length).toBeGreaterThan(0)
    const cb = vi.fn()
    ses.permissionRequestHandlers[0](null, 'media', cb)
    expect(cb).toHaveBeenCalledWith(false)
  })

  it('refuses a malformed profile id or session id, creating nothing', () => {
    const win = new FakeParentWindow()
    expect(openAccountPane(win as never, 'sess-d', '../evil', BOUNDS).ok).toBe(false)
    expect(openAccountPane(win as never, 'a/../b', 'profile-p1a', BOUNDS).ok).toBe(false)
    expect(createdViews).toHaveLength(0)
  })

  it('wires the nav guard: non-https prevented; claude.ai allowed; post-auth off-site pushed external', async () => {
    const win = new FakeParentWindow()
    openAccountPane(win as never, 'sess-nav', 'profile-nav1', BOUNDS)
    const handlers = createdViews[0].view.webContents.handlers
    const nav = handlers['will-navigate'] as (e: { preventDefault: () => void }, url: string) => void
    expect(nav).toBeDefined()

    const blocked = { preventDefault: vi.fn() }
    nav(blocked, 'file:///C:/secrets')
    expect(blocked.preventDefault).toHaveBeenCalled()

    const allowed = { preventDefault: vi.fn() }
    nav(allowed, 'https://claude.ai/login')
    expect(allowed.preventDefault).not.toHaveBeenCalled()

    // Pre-auth (authed=null at open): an https IdP hop stays in-view.
    const idp = { preventDefault: vi.fn() }
    nav(idp, 'https://login.microsoftonline.com/x')
    expect(idp.preventDefault).not.toHaveBeenCalled()
    expect(openedExternal).toHaveLength(0)
    closeAccountPane('sess-nav')
  })

  it('sign-out tears down every pane for that profile and detaches the native view', () => {
    const win = new FakeParentWindow()
    openAccountPane(win as never, 'sess-t1', 'profile-teardown', BOUNDS)
    openAccountPane(win as never, 'sess-t2', 'profile-teardown', BOUNDS)
    expect(win.contentView.children).toHaveLength(2)
    expect(getAccountPaneState('sess-t1')).not.toBeNull()
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
