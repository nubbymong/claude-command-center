/**
 * The browser pane's WebContentsView guards, driven through a fake Electron:
 * what `openWebview` actually installs on the view and its partition session.
 * These are the guarantees the pane makes about an arbitrary page -- no
 * dialog loop can hang the app, a popup never reaches the user's real browser
 * or spawns a window, in-page navigation is scheme-gated (and ONLY scheme-
 * gated, so a long OAuth hop is not cancelled), beforeunload cannot pin the
 * pane, downloads and permissions are refused -- asserted here rather than
 * read off the source, because the re-attack found two of them missing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Handler = (...args: unknown[]) => unknown

// Everything the electron mock needs lives in vi.hoisted: vi.mock factories are
// hoisted above module-level declarations, so a class declared at top level
// is not yet initialised when the factory runs.
const h = vi.hoisted(() => {
  class FakeWebContents {
    handlers = new Map<string, Handler[]>()
    windowOpenHandler: ((details: { url: string }) => { action: string }) | null = null
    loadURL = vi.fn(() => Promise.resolve())
    close = vi.fn()
    getURL = () => 'https://example.com/'
    getTitle = () => 'Example'
    navigationHistory = { canGoBack: () => false, canGoForward: () => false }
    on(event: string, fn: Handler) {
      const list = this.handlers.get(event) ?? []
      list.push(fn)
      this.handlers.set(event, list)
      return this
    }
    setWindowOpenHandler(fn: (details: { url: string }) => { action: string }) { this.windowOpenHandler = fn }
    emit(event: string, ...args: unknown[]) {
      for (const fn of this.handlers.get(event) ?? []) fn(...args)
    }
  }
  class FakeView {
    webContents = new FakeWebContents()
    setBounds = vi.fn()
    constructor(public opts: { webPreferences: Record<string, unknown> }) { state.views.push(this) }
  }
  class FakeSession {
    permissionRequest: Handler | null = null
    permissionCheck: Handler | null = null
    devicePermission: Handler | null = null
    handlers = new Map<string, Handler[]>()
    setPermissionRequestHandler(fn: Handler) { this.permissionRequest = fn }
    setPermissionCheckHandler(fn: Handler) { this.permissionCheck = fn }
    setDevicePermissionHandler(fn: Handler) { this.devicePermission = fn }
    on(event: string, fn: Handler) {
      const list = this.handlers.get(event) ?? []
      list.push(fn)
      this.handlers.set(event, list)
      return this
    }
    emit(event: string, ...args: unknown[]) {
      for (const fn of this.handlers.get(event) ?? []) fn(...args)
    }
  }
  const state = {
    views: [] as InstanceType<typeof FakeView>[],
    sessions: new Map<string, InstanceType<typeof FakeSession>>(),
    openExternal: vi.fn(),
    FakeView,
    FakeSession,
  }
  return state
})

vi.mock('electron', () => ({
  BrowserWindow: class {},
  WebContentsView: h.FakeView,
  net: { request: vi.fn() },
  session: {
    fromPartition: (name: string) => {
      let s = h.sessions.get(name)
      if (!s) { s = new h.FakeSession(); h.sessions.set(name, s) }
      return s
    },
  },
  shell: { openExternal: (...a: unknown[]) => h.openExternal(...a) },
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

import { openWebview, closeWebview } from '../../../src/main/webview-manager'

const parent = () => ({
  isDestroyed: () => false,
  contentView: { addChildView: vi.fn(), removeChildView: vi.fn(), children: [] as unknown[] },
  webContents: { send: vi.fn() },
}) as unknown as import('electron').BrowserWindow

const bounds = { x: 0, y: 0, width: 800, height: 600 }
const prevented = () => { const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }; return e }

beforeEach(() => {
  h.views.length = 0
  h.sessions.clear()
  h.openExternal.mockClear()
})

async function open(id = 'sess1') {
  const ok = await openWebview(parent(), id, 'https://example.com/', bounds)
  expect(ok).toBe(true)
  const view = h.views.at(-1)!
  const ses = h.sessions.get(`persist:webview-${id}`)!
  return { view, wc: view.webContents, ses }
}

describe('the view is built with dialog protection on', () => {
  it('sets safeDialogs (an alert() loop cannot hang the app) alongside the sandbox flags', async () => {
    const { view } = await open()
    expect(view.opts.webPreferences).toMatchObject({
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      partition: 'persist:webview-sess1',
      safeDialogs: true,
    })
    expect(typeof view.opts.webPreferences.safeDialogsMessage).toBe('string')
    closeWebview('sess1')
  })
})

describe('popups never leave the pane', () => {
  it('loads an http(s) popup in the same view, never openExternal, and denies the window', async () => {
    const { wc } = await open()
    wc.loadURL.mockClear()
    const res = wc.windowOpenHandler!({ url: 'https://evil.example/landing' })
    expect(res).toEqual({ action: 'deny' })
    expect(wc.loadURL).toHaveBeenCalledWith('https://evil.example/landing')
    expect(h.openExternal).not.toHaveBeenCalled()
    closeWebview('sess1')
  })

  it('drops a non-http popup entirely', async () => {
    const { wc } = await open()
    wc.loadURL.mockClear()
    for (const bad of ['javascript:alert(1)', 'file:///C:/Windows/win.ini', 'ms-' + 'msdt:/id x', 'data:text/html,hi', 'chrome://settings']) {
      expect(wc.windowOpenHandler!({ url: bad })).toEqual({ action: 'deny' })
    }
    expect(wc.loadURL).not.toHaveBeenCalled()
    expect(h.openExternal).not.toHaveBeenCalled()
    closeWebview('sess1')
  })
})

describe('in-page navigation is scheme-gated, and only scheme-gated', () => {
  it('cancels will-navigate / will-redirect to any non-http(s) scheme, case and whitespace included', async () => {
    const { wc } = await open()
    const bad = ['file:///etc/passwd', 'JavaScript:void 0', 'java\u0000script:x', 'data:text/html,x', 'chrome://gpu', 'devtools://x', 'about:blank', 'blob:https://x/y', 'ms-' + 'msdt:/id x', '\tjavascript:1']
    for (const event of ['will-navigate', 'will-redirect']) {
      for (const url of bad) {
        const e = prevented()
        wc.emit(event, e, url)
        expect(e.defaultPrevented, `${event} ${JSON.stringify(url)}`).toBe(true)
      }
    }
    closeWebview('sess1')
  })

  it('lets an http(s) navigation through even when the URL is longer than the app-side cap (an OAuth hop)', async () => {
    const { wc } = await open()
    const long = 'https://login.example/authorize?state=' + 'x'.repeat(6000)
    for (const event of ['will-navigate', 'will-redirect']) {
      const e = prevented()
      wc.emit(event, e, long)
      expect(e.defaultPrevented).toBe(false)
    }
    closeWebview('sess1')
  })

  it('overrides a page that tries to prevent unload, so the toolbar can always navigate away', async () => {
    const { wc } = await open()
    const e = prevented()
    wc.emit('will-prevent-unload', e)
    expect(e.defaultPrevented).toBe(true)
    closeWebview('sess1')
  })
})

describe('the partition session refuses what a page could ask for', () => {
  it('denies permission requests and checks, device permissions, and downloads', async () => {
    const { ses } = await open()
    let granted: unknown = 'unset'
    ses.permissionRequest!({}, 'media', (v: unknown) => { granted = v })
    expect(granted).toBe(false)
    expect(ses.permissionCheck!({}, 'notifications')).toBe(false)
    expect(ses.devicePermission!({})).toBe(false)
    const e = prevented()
    ses.emit('will-download', e, { getURL: () => 'https://example.com/setup.exe' })
    expect(e.defaultPrevented).toBe(true)
    closeWebview('sess1')
  })

  it('installs the download block once per partition, not once per open', async () => {
    await open('again')
    closeWebview('again')
    await open('again')
    const ses = h.sessions.get('persist:webview-again')!
    expect(ses.handlers.get('will-download')?.length).toBe(1)
    closeWebview('again')
  })
})

describe('the session id gate inside openWebview', () => {
  it('refuses an id that is not path-safe before any partition is named', async () => {
    for (const bad of ['..', 'a/b', 'a\\b', 'persist:x', 'x\n', 'x'.repeat(129), '']) {
      expect(await openWebview(parent(), bad, 'https://example.com/', bounds)).toBe(false)
    }
    expect(h.sessions.size).toBe(0)
  })
})
