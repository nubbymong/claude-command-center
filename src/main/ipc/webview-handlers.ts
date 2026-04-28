import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc-channels'
import {
  checkUrl,
  openWebview,
  closeWebview,
  closeAllWebviews,
  setWebviewBounds,
  setWebviewVisible,
  reloadWebview,
  captureWebview,
  navBackWebview,
  navForwardWebview,
  goHomeWebview,
} from '../webview-manager'

// Restrict to plain web schemes — without this the user could
// (intentionally or via a typo) load file://, chrome://, javascript:,
// or custom protocols inside a webview that has node integration off
// but still inherits the main BrowserWindow's session trust. The
// webview pane is meant for arbitrary user URLs, not for browsing
// the local filesystem or privileged Chromium internals.
const ALLOWED_WEBVIEW_PROTOCOLS = new Set(['http:', 'https:'])
const urlSchema = z
  .string()
  .url()
  .max(4096)
  .refine((value) => {
    try {
      return ALLOWED_WEBVIEW_PROTOCOLS.has(new URL(value).protocol)
    } catch {
      return false
    }
  }, { message: 'Webview URLs must use http or https' })
const sessionIdSchema = z.string().min(1).max(200)
const boundsSchema = z.object({
  x: z.number().int().min(0).max(20000),
  y: z.number().int().min(0).max(20000),
  width: z.number().int().min(1).max(20000),
  height: z.number().int().min(1).max(20000),
})

export function registerWebviewHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.WEBVIEW_CHECK, async (_event, url: string) => {
    try {
      urlSchema.parse(url)
    } catch {
      return { reachable: false }
    }
    return checkUrl(url)
  })

  ipcMain.handle(IPC.WEBVIEW_OPEN, async (_event, sessionId: string, url: string, bounds: unknown) => {
    sessionIdSchema.parse(sessionId)
    urlSchema.parse(url)
    const parsedBounds = boundsSchema.parse(bounds)
    const win = getWindow()
    if (!win) return false
    return openWebview(win, sessionId, url, parsedBounds)
  })

  ipcMain.handle(IPC.WEBVIEW_CLOSE, async (_event, sessionId: string) => {
    sessionIdSchema.parse(sessionId)
    return closeWebview(sessionId)
  })

  ipcMain.handle(IPC.WEBVIEW_SET_BOUNDS, async (_event, sessionId: string, bounds: unknown) => {
    sessionIdSchema.parse(sessionId)
    setWebviewBounds(sessionId, boundsSchema.parse(bounds))
  })

  ipcMain.handle(IPC.WEBVIEW_SET_VISIBLE, async (_event, sessionId: string, visible: boolean) => {
    sessionIdSchema.parse(sessionId)
    setWebviewVisible(sessionId, !!visible)
  })

  ipcMain.handle(IPC.WEBVIEW_RELOAD, async (_event, sessionId: string) => {
    sessionIdSchema.parse(sessionId)
    reloadWebview(sessionId)
  })

  ipcMain.handle(IPC.WEBVIEW_CAPTURE, async (_event, sessionId: string) => {
    sessionIdSchema.parse(sessionId)
    return captureWebview(sessionId)
  })

  ipcMain.handle(IPC.WEBVIEW_NAV_BACK, async (_event, sessionId: string) => {
    sessionIdSchema.parse(sessionId)
    navBackWebview(sessionId)
  })

  ipcMain.handle(IPC.WEBVIEW_NAV_FORWARD, async (_event, sessionId: string) => {
    sessionIdSchema.parse(sessionId)
    navForwardWebview(sessionId)
  })

  ipcMain.handle(IPC.WEBVIEW_GO_HOME, async (_event, sessionId: string) => {
    sessionIdSchema.parse(sessionId)
    goHomeWebview(sessionId)
  })

  // Emergency escape hatch: destroy every WebContentsView. Called by
  // the renderer when the user presses Escape or hits the always-visible
  // pill. Mirrors closeAllWebviews used on app quit.
  ipcMain.handle(IPC.WEBVIEW_CLOSE_ALL, async () => {
    closeAllWebviews()
    return true
  })
}
