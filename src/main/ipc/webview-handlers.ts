import { ipcMain, BrowserWindow, shell } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc-channels'
import { isAllowedBrowserUrl, BROWSER_URL_MAX_LENGTH } from '../../shared/browser-url'
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
  navigateWebview,
} from '../webview-manager'

// Restrict to plain web schemes — without this the user could
// (intentionally or via a typo) load file://, chrome://, javascript:,
// or custom protocols inside a webview that has node integration off
// but still inherits the main BrowserWindow's session trust. The
// webview pane is meant for arbitrary user URLs, not for browsing
// the local filesystem or privileged Chromium internals.
//
// The rule itself lives in shared/browser-url so the renderer's inline
// validation (address bar, command dialog) and this gate cannot drift.
const urlSchema = z
  .string()
  .max(BROWSER_URL_MAX_LENGTH)
  .refine((value) => isAllowedBrowserUrl(value), { message: 'Webview URLs must use http or https' })
// Session ids are app-minted (24 hex) and this one becomes part of an ON-DISK
// path: the view's partition is `persist:webview-<sessionId>`, which Chromium
// turns into a profile directory under sessionData/Partitions. A loose schema
// let `a/../../x` build a partition string that escaped that directory and
// `webview-x/../claude-web-<id>` alias another session's cookie jar (ADR-009
// pass, beta.16; a compromised renderer was required, but the renderer is the
// boundary). Same strict charset pty-handlers and canvas-handlers use.
const sessionIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)
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
    // The NORMALISED href, never the renderer's raw string: the WHATWG parser
    // strips leading whitespace and ASCII tab/newline before it reads the
    // scheme, so a raw string that passes the gate can still carry a CR/LF --
    // harmless to Chromium, but it reached the log, the stored entry.url and
    // the address bar verbatim (log-line forging from the renderer).
    return openWebview(win, sessionId, new URL(url).href, parsedBounds)
  })

  // The address bar, favourites, home and the "open a page" command all come
  // through here. Same gate as open; a view that does not exist yet resolves
  // false and the pane falls back to open.
  ipcMain.handle(IPC.WEBVIEW_NAVIGATE, async (_event, sessionId: string, url: string) => {
    sessionIdSchema.parse(sessionId)
    urlSchema.parse(url)
    return navigateWebview(sessionId, new URL(url).href)
  })

  // "Open in your real browser". The OS is handed the NORMALISED href of a
  // URL that passed the http/https gate -- never the renderer's raw string.
  // This is deliberately separate from the app-wide 'shell:openExternal'
  // (https-only, for links the app itself emits): the pane exists for local
  // dev servers, which are plain http.
  ipcMain.handle(IPC.WEBVIEW_OPEN_EXTERNAL, async (_event, url: string) => {
    urlSchema.parse(url)
    const href = new URL(url).href
    await shell.openExternal(href)
    return true
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
