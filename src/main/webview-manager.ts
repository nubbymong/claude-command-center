import { BrowserWindow, WebContentsView, net, session, shell } from 'electron'
import type { Session as ElectronSession } from 'electron'
import { logInfo, logError } from './debug-logger'
import { IPC } from '../shared/ipc-channels'
import { isAllowedBrowserUrl, type WebviewNavState } from '../shared/browser-url'

interface ManagedView {
  view: WebContentsView
  url: string
  attachedTo: BrowserWindow | null
}

const views = new Map<string, ManagedView>()

export interface WebviewBounds {
  x: number
  y: number
  width: number
  height: number
}

/**
 * HEAD-probe a URL via Electron's net.request (CORS-bypass + same trust
 * store as the main process). Resolves to { reachable, status }.
 *
 * Some servers reject HEAD with 405 ("Method Not Allowed"); we retry
 * with GET in that single case so the activation poller doesn't get a
 * false-negative for those origins. We do NOT retry on 404/401/403/etc
 * — a doubled request count there wouldn't change the verdict.
 */
export async function checkUrl(url: string, timeoutMs = 3000): Promise<{ reachable: boolean; status?: number }> {
  const probe = (method: 'HEAD' | 'GET') =>
    new Promise<{ reachable: boolean; status?: number }>((resolve) => {
      let settled = false
      const finish = (result: { reachable: boolean; status?: number }) => {
        if (settled) return
        settled = true
        resolve(result)
      }
      try {
        const req = net.request({ method, url })
        const timer = setTimeout(() => {
          try { req.abort() } catch { /* noop */ }
          finish({ reachable: false })
        }, timeoutMs)
        req.on('response', (res) => {
          clearTimeout(timer)
          // 2xx-3xx counts as reachable. 4xx/5xx still mean a server is
          // there, but the URL the user gave isn't usable — treat as
          // not-reachable for the polling UX.
          const status = res.statusCode
          finish({ reachable: status >= 200 && status < 400, status })
          // Drain so the request doesn't leak.
          try { res.on('data', () => { /* drain */ }) } catch { /* noop */ }
        })
        req.on('error', () => {
          clearTimeout(timer)
          finish({ reachable: false })
        })
        req.end()
      } catch {
        finish({ reachable: false })
      }
    })

  const head = await probe('HEAD')
  if (head.reachable) return head
  // Only retry with GET when the server explicitly told us "method not
  // allowed" — that's the case the GET fallback was designed for. The
  // old code retried on any 4xx (404, 401, 403, etc.) which doubled
  // the per-probe request count without ever changing the answer.
  if (head.status === 405) {
    const get = await probe('GET')
    if (get.reachable) return get
  }
  return head
}

/**
 * The pane loads whatever the user types, so its partition session is locked
 * down the way a browser window with every permission prompt set to "block"
 * would be: no camera, microphone, geolocation, notifications, MIDI,
 * clipboard-read, HID/USB/serial. A page that needs one of those is a page
 * for the user's real browser ("Open in your real browser" is on the toolbar).
 *
 * Idempotent per partition: Electron returns the same Session object for the
 * same partition string, and setting the handlers again just replaces them.
 */
function hardenPartitionSession(ses: ElectronSession): void {
  try {
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)
    ses.setDevicePermissionHandler(() => false)
  } catch (err) {
    logError(`[webview] could not harden partition session: ${(err as Error)?.message ?? err}`)
  }
}

/** Push the view's navigation state to the host renderer. Best-effort. */
function emitNavState(parent: BrowserWindow, sessionId: string, view: WebContentsView, loading: boolean): void {
  try {
    if (!parent || parent.isDestroyed()) return
    const wc = view.webContents
    const state: WebviewNavState = {
      sessionId,
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading,
    }
    parent.webContents.send(IPC.WEBVIEW_NAVIGATED, state)
  } catch { /* view or parent gone */ }
}

export async function openWebview(
  parent: BrowserWindow,
  sessionId: string,
  url: string,
  bounds: WebviewBounds,
): Promise<boolean> {
  // Last gate before the id becomes part of an on-disk partition path
  // (`persist:webview-<sessionId>` -> sessionData/Partitions/webview-<id>).
  // The IPC schema already enforces this charset; this is the line that holds
  // if a future caller does not go through it.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) {
    logError(`[webview] refused open: session id is not path-safe`)
    return false
  }
  // Idempotent: if already open, just nav to the new URL + reposition.
  const existing = views.get(sessionId)
  if (existing) {
    try {
      existing.view.setBounds(bounds)
      if (existing.url !== url) {
        existing.view.webContents.loadURL(url)
        existing.url = url
      }
      return true
    } catch (err) {
      logError(`[webview] reuse failed for ${sessionId}: ${(err as Error)?.message ?? err}`)
      try { existing.view.webContents.close() } catch { /* noop */ }
      views.delete(sessionId)
    }
  }

  try {
    // Per-partition session so each webview has its own cookie jar +
    // cache, but shared across reloads of the same sessionId.
    const partition = `persist:webview-${sessionId}`
    hardenPartitionSession(session.fromPartition(partition))
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition,
      },
    })

    // Lock down navigation + popups before loadURL so a malicious page
    // can't escape via location.href = 'file://...' or window.open.
    // The toolbar's Back/Forward/Reload/Home all stay inside http(s)
    // because those calls go through `view.webContents.*` directly,
    // not through the page; this guard catches in-page nav only.
    const guardScheme = (label: string) => (event: { preventDefault: () => void }, target: string) => {
      if (!isAllowedBrowserUrl(target)) {
        event.preventDefault()
        logError(`[webview] blocked ${label} to disallowed scheme: ${String(target).slice(0, 200)}`)
      }
    }
    view.webContents.on('will-navigate', guardScheme('will-navigate'))
    // A server can answer an http(s) request with a redirect to any scheme
    // it likes; will-navigate does not see that hop. Same allowlist.
    view.webContents.on('will-redirect', guardScheme('will-redirect'))
    // Forward Escape to the host renderer when focus is inside the
    // embedded page. Without this hook, key events go to the
    // WebContentsView's own webContents and never reach the App-level
    // Esc handler — so a user looking at a stuck/oversized view
    // couldn't press Esc to close it (they'd have to find the red
    // banner button). Only main-frame Escape; lets sub-frame inputs
    // (e.g. an iframed Excalidraw) handle their own cancel paths.
    view.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        try {
          if (parent && !parent.isDestroyed()) {
            parent.webContents.send(IPC.WEBVIEW_ESCAPE_PRESSED, sessionId)
          }
        } catch { /* parent gone */ }
      }
    })
    view.webContents.setWindowOpenHandler(({ url: openUrl }) => {
      // Open external links in the system browser via shell, not in
      // the embedded view. Same allowlist — file://, javascript:,
      // chrome:// are dropped on the floor.
      if (isAllowedBrowserUrl(openUrl)) {
        void shell.openExternal(new URL(openUrl).href)
      } else {
        logError(`[webview] blocked window.open to disallowed scheme: ${String(openUrl).slice(0, 200)}`)
      }
      return { action: 'deny' }
    })
    // Navigation state for the pane's address bar and history buttons. The
    // URL reported is the one the view is actually on (after redirects), not
    // the one that was asked for -- the address bar must never show a URL the
    // page is not at.
    const wc = view.webContents
    wc.on('did-start-loading', () => emitNavState(parent, sessionId, view, true))
    wc.on('did-stop-loading', () => emitNavState(parent, sessionId, view, false))
    wc.on('did-navigate', () => emitNavState(parent, sessionId, view, false))
    wc.on('did-navigate-in-page', () => emitNavState(parent, sessionId, view, false))
    wc.on('page-title-updated', () => emitNavState(parent, sessionId, view, false))

    view.setBounds(bounds)
    parent.contentView.addChildView(view)
    // loadURL rejects when the page fails (DNS, refused, etc.). Don't
    // let that take down the pane — Chromium has already rendered an
    // error page inside the view, the user can fix DNS / retry from
    // the toolbar. Without this catch the renderer treats `open`
    // failure as "close the pane" and the user sees nothing happen.
    view.webContents.loadURL(url).catch((err) => {
      logError(`[webview] loadURL failed for ${sessionId} (${url}): ${(err as Error)?.message ?? err} — view stays open with Chromium error page`)
    })
    views.set(sessionId, { view, url, attachedTo: parent })
    logInfo(`[webview] opened ${sessionId} -> ${url}`)
    return true
  } catch (err) {
    logError(`[webview] open failed for ${sessionId}: ${(err as Error)?.message ?? err}`)
    return false
  }
}

/**
 * Load a URL in the session's EXISTING view -- the address bar, a favourite,
 * the home button, an "open a page" command. Returns false when there is no
 * view (the pane then creates one with `openWebview`). The handler has
 * already validated the scheme; this re-checks because it is the last gate
 * before Chromium.
 */
export function navigateWebview(sessionId: string, url: string): boolean {
  const entry = views.get(sessionId)
  if (!entry) return false
  if (!isAllowedBrowserUrl(url)) return false
  try {
    entry.url = url
    entry.view.webContents.loadURL(url).catch((err) => {
      logError(`[webview] navigate failed for ${sessionId} (${url}): ${(err as Error)?.message ?? err}`)
    })
    return true
  } catch (err) {
    logError(`[webview] navigate threw for ${sessionId}: ${(err as Error)?.message ?? err}`)
    return false
  }
}

export function closeWebview(sessionId: string): boolean {
  const entry = views.get(sessionId)
  if (!entry) return false
  try {
    if (entry.attachedTo && !entry.attachedTo.isDestroyed()) {
      entry.attachedTo.contentView.removeChildView(entry.view)
    }
    entry.view.webContents.close()
  } catch (err) {
    logError(`[webview] close failed for ${sessionId}: ${(err as Error)?.message ?? err}`)
  }
  views.delete(sessionId)
  return true
}

export function setWebviewBounds(sessionId: string, bounds: WebviewBounds): void {
  const entry = views.get(sessionId)
  if (!entry) return
  try { entry.view.setBounds(bounds) } catch { /* view destroyed */ }
}

/**
 * Show or hide the WebContentsView WITHOUT destroying it. Hiding via
 * `removeChildView` keeps the page state (cookies, JS, scroll position)
 * intact so re-showing is instant. Used by WebviewPane when the session
 * tab becomes inactive — bounds-based hiding via setBounds(0,0,1,1) is
 * unreliable across `display:none` ancestors and has visible flicker
 * on macOS during the size update.
 */
export function setWebviewVisible(sessionId: string, visible: boolean): void {
  const entry = views.get(sessionId)
  if (!entry || !entry.attachedTo || entry.attachedTo.isDestroyed()) return
  try {
    const children = entry.attachedTo.contentView.children
    const isAttached = children.includes(entry.view)
    if (visible && !isAttached) {
      entry.attachedTo.contentView.addChildView(entry.view)
    } else if (!visible && isAttached) {
      entry.attachedTo.contentView.removeChildView(entry.view)
      // Belt-and-suspenders: also shrink to 1×1 in the corner. If
      // removeChildView silently failed (Windows compositor edge case
      // we've seen during HMR + session-switch), the view is at least
      // not covering the rest of the UI. Width/height must be ≥ 1
      // (Electron rejects zero-area rects on some platforms).
      try { entry.view.setBounds({ x: 0, y: 0, width: 1, height: 1 }) } catch { /* noop */ }
    }
  } catch (err) {
    logError(`[webview] setVisible ${sessionId}=${visible} failed: ${(err as Error)?.message ?? err}`)
  }
}

export function reloadWebview(sessionId: string): void {
  const entry = views.get(sessionId)
  if (!entry) return
  try {
    // Force reload bypassing cache — matches the user spec ("always do a
    // hard refresh"). reloadIgnoringCache() also re-fetches the HTML.
    entry.view.webContents.reloadIgnoringCache()
  } catch { /* view destroyed */ }
}

export async function captureWebview(sessionId: string): Promise<string | null> {
  const entry = views.get(sessionId)
  if (!entry) return null
  try {
    const image = await entry.view.webContents.capturePage()
    return image.toDataURL()
  } catch (err) {
    logError(`[webview] capture failed for ${sessionId}: ${(err as Error)?.message ?? err}`)
    return null
  }
}

export function navBackWebview(sessionId: string): void {
  const entry = views.get(sessionId)
  if (!entry) return
  try {
    const h = entry.view.webContents.navigationHistory
    if (h.canGoBack()) h.goBack()
  } catch { /* noop */ }
}

export function navForwardWebview(sessionId: string): void {
  const entry = views.get(sessionId)
  if (!entry) return
  try {
    const h = entry.view.webContents.navigationHistory
    if (h.canGoForward()) h.goForward()
  } catch { /* noop */ }
}

export function goHomeWebview(sessionId: string): void {
  const entry = views.get(sessionId)
  if (!entry) return
  try { entry.view.webContents.loadURL(entry.url) } catch { /* noop */ }
}

/** Tear down all views — used on app quit. */
export function closeAllWebviews(): void {
  for (const sessionId of [...views.keys()]) {
    closeWebview(sessionId)
  }
}
