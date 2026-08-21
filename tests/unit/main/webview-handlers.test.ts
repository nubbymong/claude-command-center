/**
 * The browser pane's IPC surface (item 26). Drives the REAL handlers through
 * a fake ipcMain, with the manager mocked, because the property under test
 * lives in the handlers: every URL that reaches the manager, and every URL
 * that reaches the OS, has passed the http/https gate and is the normalised
 * href -- never the renderer's raw string.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const handlers = new Map<string, (...a: unknown[]) => unknown>()
const openExternal = vi.fn(() => Promise.resolve())
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) }, on: vi.fn() },
  BrowserWindow: class {},
  shell: { openExternal: (...a: unknown[]) => openExternal(...a) },
}))
const manager = {
  checkUrl: vi.fn(() => Promise.resolve({ reachable: true, status: 200 })),
  openWebview: vi.fn(() => Promise.resolve(true)),
  closeWebview: vi.fn(() => true),
  closeAllWebviews: vi.fn(),
  setWebviewBounds: vi.fn(),
  setWebviewVisible: vi.fn(),
  reloadWebview: vi.fn(),
  captureWebview: vi.fn(() => Promise.resolve(null)),
  navBackWebview: vi.fn(),
  navForwardWebview: vi.fn(),
  goHomeWebview: vi.fn(),
  navigateWebview: vi.fn(() => true),
}
vi.mock('../../../src/main/webview-manager', () => manager)
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn() }))

const { registerWebviewHandlers } = await import('../../../src/main/ipc/webview-handlers')
const { IPC } = await import('../../../src/shared/ipc-channels')
const fakeWin = { id: 1 }
registerWebviewHandlers(() => fakeWin as never)

const call = (ch: string, ...args: unknown[]) => handlers.get(ch)!({}, ...args)
const SID = 'session-1'
const BOUNDS = { x: 0, y: 0, width: 100, height: 100 }

beforeEach(() => {
  for (const fn of Object.values(manager)) (fn as ReturnType<typeof vi.fn>).mockClear()
  openExternal.mockClear()
})

const BAD_URLS = [
  'file:///C:/Windows/win.ini',
  'javascript:alert(1)',
  'chrome://settings',
  'about:blank',
  'data:text/html,x',
  'ftp://h/',
  'localhost:5173', // scheme-less: the RENDERER normalises; main takes only finished URLs
  '',
  42,
  null,
  undefined,
  'https://x.y/' + 'a'.repeat(5000),
]

describe('webview:navigate', () => {
  it('hands a good URL to the manager and returns its answer', async () => {
    expect(await call(IPC.WEBVIEW_NAVIGATE, SID, 'http://localhost:5173/app')).toBe(true)
    expect(manager.navigateWebview).toHaveBeenCalledWith(SID, 'http://localhost:5173/app')
    manager.navigateWebview.mockReturnValueOnce(false)
    expect(await call(IPC.WEBVIEW_NAVIGATE, SID, 'https://example.com/')).toBe(false)
  })
  it('rejects every non-http(s) URL BEFORE the manager sees it', async () => {
    for (const bad of BAD_URLS) {
      await expect(call(IPC.WEBVIEW_NAVIGATE, SID, bad), String(bad)).rejects.toThrow()
    }
    expect(manager.navigateWebview).not.toHaveBeenCalled()
  })
  it('rejects a bad session id', async () => {
    await expect(call(IPC.WEBVIEW_NAVIGATE, '', 'https://x.y/')).rejects.toThrow()
    await expect(call(IPC.WEBVIEW_NAVIGATE, 'x'.repeat(201), 'https://x.y/')).rejects.toThrow()
    expect(manager.navigateWebview).not.toHaveBeenCalled()
  })
})

describe('webview:openExternal', () => {
  it('hands the OS the NORMALISED href of a good URL', async () => {
    expect(await call(IPC.WEBVIEW_OPEN_EXTERNAL, 'HTTP://LocalHost:5173')).toBe(true)
    expect(openExternal).toHaveBeenCalledWith('http://localhost:5173/')
    await call(IPC.WEBVIEW_OPEN_EXTERNAL, 'https://example.com/a b')
    expect(openExternal).toHaveBeenLastCalledWith('https://example.com/a%20b')
  })
  it('never hands the OS anything that is not http(s)', async () => {
    for (const bad of BAD_URLS) {
      await expect(call(IPC.WEBVIEW_OPEN_EXTERNAL, bad), String(bad)).rejects.toThrow()
    }
    expect(openExternal).not.toHaveBeenCalled()
  })
})

describe('webview:open (unchanged gate, re-asserted)', () => {
  it('opens a good URL at validated bounds', async () => {
    expect(await call(IPC.WEBVIEW_OPEN, SID, 'https://example.com/', BOUNDS)).toBe(true)
    expect(manager.openWebview).toHaveBeenCalledWith(fakeWin, SID, 'https://example.com/', BOUNDS)
  })
  it('refuses bad URLs and bad bounds', async () => {
    await expect(call(IPC.WEBVIEW_OPEN, SID, 'file:///x', BOUNDS)).rejects.toThrow()
    await expect(call(IPC.WEBVIEW_OPEN, SID, 'https://x.y/', { x: -1, y: 0, width: 1, height: 1 })).rejects.toThrow()
    await expect(call(IPC.WEBVIEW_OPEN, SID, 'https://x.y/', { x: 0, y: 0, width: 0, height: 1 })).rejects.toThrow()
    expect(manager.openWebview).not.toHaveBeenCalled()
  })
})

describe('webview:check', () => {
  it('answers unreachable for a bad URL without probing', async () => {
    expect(await call(IPC.WEBVIEW_CHECK, 'file:///x')).toEqual({ reachable: false })
    expect(manager.checkUrl).not.toHaveBeenCalled()
  })
})
