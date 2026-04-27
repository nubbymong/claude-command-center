import { BrowserWindow, WebContentsView, net, session, shell } from 'electron'
import { logInfo, logError } from './debug-logger'
import { IPC } from '../shared/ipc-channels'

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

export async function openWebview(
  parent: BrowserWindow,
  sessionId: string,
  url: string,
  bounds: WebviewBounds,
): Promise<boolean> {
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
    const ALLOWED = new Set(['http:', 'https:'])
    view.webContents.on('will-navigate', (event, target) => {
      try {
        if (!ALLOWED.has(new URL(target).protocol)) {
          event.preventDefault()
          logError(`[webview] blocked will-navigate to disallowed scheme: ${target}`)
        }
      } catch {
        event.preventDefault()
      }
    })
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
      try {
        if (ALLOWED.has(new URL(openUrl).protocol)) {
          void shell.openExternal(openUrl)
        } else {
          logError(`[webview] blocked window.open to disallowed scheme: ${openUrl}`)
        }
      } catch { /* invalid URL — drop */ }
      return { action: 'deny' }
    })

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
  try { if (entry.view.webContents.canGoBack()) entry.view.webContents.goBack() } catch { /* noop */ }
}

export function navForwardWebview(sessionId: string): void {
  const entry = views.get(sessionId)
  if (!entry) return
  try { if (entry.view.webContents.canGoForward()) entry.view.webContents.goForward() } catch { /* noop */ }
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

// Suppress unused-import lint — `session` is intentionally imported in
// case future helpers want to clear cookies for a webview partition.
void session
