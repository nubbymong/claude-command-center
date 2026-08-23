import { app, BrowserWindow, WebContentsView, net, session } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import type { Session as ElectronSession } from 'electron'
import { logInfo, logError } from './debug-logger'
import { IPC } from '../shared/ipc-channels'
import { isAllowedBrowserUrl, isAllowedBrowserScheme, type WebviewNavState } from '../shared/browser-url'

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
    // No downloads from the pane. Electron's default for an unhandled
    // will-download is the OS Save-As dialog from the main window, with no
    // download UI, no Safe Browsing and the file landing wherever the user
    // clicks -- a `Content-Disposition: attachment` or an `<a download>` must
    // not get that. Guarded: fromPartition hands back the same Session each
    // time and `on` would stack a listener per open.
    const sesWithFlag = ses as ElectronSession & { __cccDownloadsBlocked?: boolean }
    if (!sesWithFlag.__cccDownloadsBlocked) {
      sesWithFlag.__cccDownloadsBlocked = true
      ses.on('will-download', (event, item) => {
        event.preventDefault()
        logError(`[webview] blocked download: ${String(item?.getURL?.() ?? '').slice(0, 200)}`)
      })
    }
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
        // Browser-style consecutive-dialog protection. Electron's default is
        // OFF, and every alert()/confirm()/prompt() from the page is a native
        // dialog parented to the MAIN window: a page that loops alert() blocks
        // the whole app, the pane's Close button and Esc included. With this
        // on, the second dialog in a row carries "stop this page opening more
        // dialogs", exactly as Chrome does.
        safeDialogs: true,
        safeDialogsMessage: 'Stop this page from opening more dialogs',
      },
    })

    // Lock down navigation + popups before loadURL so a malicious page
    // can't escape via location.href = 'file://...' or window.open.
    // The toolbar's Back/Forward/Reload/Home all stay inside http(s)
    // because those calls go through `view.webContents.*` directly,
    // not through the page; this guard catches in-page nav only.
    // SCHEME only on this path (isAllowedBrowserScheme, not isAllowedBrowserUrl):
    // the app-side length cap must not cancel an OAuth/SAML hop whose URL
    // runs past it -- a cancelled will-redirect aborts the whole navigation.
    const guardScheme = (label: string) => (event: { preventDefault: () => void }, target: string) => {
      if (!isAllowedBrowserScheme(target)) {
        event.preventDefault()
        logError(`[webview] blocked ${label} to disallowed scheme: ${String(target).slice(0, 200)}`)
      }
    }
    view.webContents.on('will-navigate', guardScheme('will-navigate'))
    // A server can answer an http(s) request with a redirect to any scheme
    // it likes; will-navigate does not see that hop. Same allowlist.
    view.webContents.on('will-redirect', guardScheme('will-redirect'))
    // A page's beforeunload handler would otherwise make every toolbar
    // navigation (address bar, favourites, Home, Back, Reload) fail silently:
    // loadURL reports did-fail-load when the page prevents unload and nothing
    // asks the user. The pane is a preview surface, not where unsaved forms
    // live -- the user's navigation wins.
    view.webContents.on('will-prevent-unload', (event) => { event.preventDefault() })
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
      // A popup (window.open, target=_blank) never becomes a new window and
      // never reaches the user's real browser: the page would otherwise hold
      // the "open in your real browser" primitive the toolbar reserves for a
      // click -- Electron has no popup blocker and the handler carries no
      // user-gesture flag, so a page could fire it in a loop, hidden pane or
      // not. An http(s) popup loads in THIS pane instead (the user can still
      // send the page to their real browser with the toolbar button);
      // anything else is dropped.
      if (isAllowedBrowserScheme(openUrl)) {
        try { view.webContents.loadURL(new URL(openUrl).href) } catch { /* view gone */ }
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

/** A partition wipe must not be able to hang the close path (#371). The
 *  account-web sign-out learned this the hard way — a `clearStorageData()` that
 *  never settles left sign-out stuck forever. */
const CLEAR_TIMEOUT_MS = 5_000

/** Cancellable race, so a fast clear does not leave a 5 s timer holding a
 *  reject closure. "Close all" across 50 tiles scheduled 100 of them. */
function withClearTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const guard = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out`)), CLEAR_TIMEOUT_MS)
  })
  return Promise.race([p, guard]).finally(() => { if (timer) clearTimeout(timer) }) as Promise<T>
}

/** The on-disk directory name Chromium gives `persist:webview-<id>`. Our ids
 *  are `[A-Za-z0-9_-]` so nothing is percent-encoded. */
const WEBVIEW_PARTITION_PREFIX = 'webview-'
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/**
 * Empty a session's browser profile, and remove its directory.
 *
 * Each pane gets `persist:webview-<sessionId>`, which Chromium turns into a
 * profile directory under `sessionData/Partitions/webview-<id>` holding that
 * pane's cookies, localStorage and cache. Nothing ever removed one: a session
 * id is minted per tile and never reused, so every closed tile left a fully
 * populated profile on disk for the life of the install — logged-in cookies for
 * whatever the user browsed, unreachable through the app and invisible in it.
 *
 * `clearStorageData()` EMPTIES the stores; Chromium leaves the directory in
 * place with its scaffolding, so the directory is removed afterwards too (#371
 * review MINOR-2 — the doc used to say "delete" while the code only emptied,
 * and an auditor looking at `Partitions/` would have concluded the fix never
 * ran). The clear still comes first: it is what releases the open handles, and
 * it is the part that must succeed.
 *
 * Called when a session is CLOSED BY THE USER, which in this app is the same
 * act as deleting it: the tile is gone from the saved-tile file and its id
 * never comes back. It is deliberately NOT wired to the store's
 * `removeSession`, which a restart and an in-tile account switch also call —
 * those re-add the SAME id and must keep their cookies (a restart that signed
 * you out of every site in the pane would be its own bug).
 */
export async function forgetWebviewProfile(sessionId: string): Promise<boolean> {
  // Same gate as `openWebview`: this id names an on-disk partition.
  if (!SESSION_ID_RE.test(sessionId)) {
    logError(`[webview] refused profile wipe: session id is not path-safe`)
    return false
  }
  const entry = views.get(sessionId)
  // Do not MATERIALISE a partition just to clear it (#371 review MINOR-5).
  // `session.fromPartition` creates a persist-backed session, so calling this
  // for a tile that never opened a pane — the launch-gate cancel does exactly
  // that — could leave behind the very empty profile directory the sweep is
  // here to remove. Nothing open and nothing on disk means nothing to do.
  if (!entry && !partitionDirExists(sessionId)) return true

  // Destroy the view first: clearing a partition a live WebContents is still
  // writing to races the wipe and can leave the cookie jar behind. `close()`
  // only INITIATES that, so wait for the WebContents to actually go — the
  // previous cut asserted call order, which cannot detect the race it names
  // (#371 review MINOR-3).
  const wc = entry?.view.webContents
  closeWebview(sessionId)
  if (wc && !wc.isDestroyed?.()) {
    try {
      await withClearTimeout(
        new Promise<void>((resolve) => {
          if (wc.isDestroyed?.()) return resolve()
          wc.once('destroyed', () => resolve())
        }),
        'webContents destroy',
      )
    } catch {
      // It did not confirm in time; clear anyway rather than leaving the jar.
      logError(`[webview] view for ${sessionId} did not confirm destruction; clearing regardless`)
    }
  }
  const partition = `persist:webview-${sessionId}`
  try {
    const ses = session.fromPartition(partition)
    // Storage first (cookies, localStorage, IndexedDB, service workers), then
    // the HTTP cache — a wipe that left the cache holds page content.
    await withClearTimeout(Promise.resolve(ses.clearStorageData()), 'clearStorageData')
    await withClearTimeout(Promise.resolve(ses.clearCache()), 'clearCache')
    removePartitionDir(sessionId)
    logInfo(`[webview] cleared browser profile for closed session ${sessionId}`)
    return true
  } catch (err) {
    // Best effort: a session that will not clear must not block the tab close.
    logError(`[webview] could not clear profile for ${sessionId}: ${(err as Error)?.message ?? err}`)
    return false
  }
}

/** Where Chromium keeps the `persist:` partition directories. */
function partitionsRoot(): string {
  return path.join(app.getPath('sessionData'), 'Partitions')
}


/** True when this session has a profile directory on disk. */
function partitionDirExists(sessionId: string): boolean {
  try {
    return fs.existsSync(path.join(partitionsRoot(), `${WEBVIEW_PARTITION_PREFIX}${sessionId}`))
  } catch {
    return false
  }
}

/** Remove one partition directory. Best-effort: Chromium may still hold a
 *  handle, and an emptied-but-present directory is not a leak. */
function removePartitionDir(sessionId: string): void {
  try {
    fs.rmSync(path.join(partitionsRoot(), `${WEBVIEW_PARTITION_PREFIX}${sessionId}`), { recursive: true, force: true })
  } catch {
    /* the clear is what matters; the directory is scaffolding */
  }
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
