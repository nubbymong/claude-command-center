import { BrowserWindow, WebContentsView, net, session } from 'electron'
import { logInfo, logError } from './logger'

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
 * Some servers reject HEAD with 405; we fall back to GET on 4xx so the
 * activation poller doesn't get false-negatives for those origins.
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
  if (head.status && head.status >= 400 && head.status < 500) {
    // Some origins reject HEAD entirely (405) — try GET once.
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
    view.setBounds(bounds)
    parent.contentView.addChildView(view)
    await view.webContents.loadURL(url)
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
