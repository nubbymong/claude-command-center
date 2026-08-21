import { create } from 'zustand'
import type { WebviewNavState } from '../../shared/browser-url'

/**
 * Per-session state for the browser pane (the "webview").
 *
 * Two things live here and they are deliberately separate:
 *
 *  1. The WATCH -- a command can "watch for a page": the command bar polls
 *     the command's URL and the Browser button is tinted by the outcome.
 *       idle      -> nothing is being watched
 *       pending   -> URL is being polled; button shows a neutral pulse
 *       available -> URL responded; button pulses GREEN ("ready to view")
 *       failed    -> polling timed out / server died; button shows RED
 *     `watchUrl` is what is being watched.
 *
 *  2. The PANE -- `isOpen`, and `currentUrl`: the page the pane has been
 *     ASKED to show (by a watch that fired, the address bar, a favourite,
 *     home, or an "open a page" command). `page` is what main reports the
 *     view is ACTUALLY on -- after redirects, with title and history flags.
 *
 * The pane is always there (item 26): the Browser button renders for every
 * session, and clicking it with nothing loaded opens the pane on its start
 * page. The watch is a convenience that can point the pane somewhere; it is
 * not the door in.
 */
export type WebviewStatus = 'idle' | 'pending' | 'available' | 'failed'

export interface WebviewPageState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}

export interface WebviewSessionState {
  status: WebviewStatus
  /** The URL a command watch is polling / last polled. Null when nothing was watched. */
  watchUrl: string | null
  /** The page the pane has been asked to show. Null = start page. */
  currentUrl: string | null
  loadedAt: number | null
  isOpen: boolean
  /** What main reports the view is actually on. Null until the first navigation event. */
  page: WebviewPageState | null
  /** A home page set for THIS session and not persisted (config-less sessions;
   *  the persisted per-config home lives in browserStore). */
  homeUrl: string | null
  /**
   * Monotonically-incremented per session on every `startActivation`.
   * Long-running pollers capture this token and pass it back to
   * `markAvailable` / `markFailed` so a stale poll can't overwrite a
   * newer one's result. Without this, double-clicking a webview
   * command (or running two with different URLs) lets the older 30 s
   * poll win the race and clobber the newer state.
   */
  activationId: number
}

interface State {
  bySessionId: Record<string, WebviewSessionState>
}

interface Actions {
  /**
   * Begin polling for content. Sets status='pending', stores URL,
   * and returns a fresh activation token. Callers that run a long
   * poll afterwards must pass this token back to mark*() so a stale
   * resolution doesn't overwrite a newer activation's result.
   *
   * An activation is the user pressing a command that watches a page, so it
   * also points the pane at that page.
   */
  startActivation: (sessionId: string, url: string) => number
  /**
   * Polling found content. When `token` is provided and doesn't
   * match the latest activationId, the call is dropped (stale poll).
   *
   * Points the pane at the URL ONLY when it is showing nothing yet. A
   * re-probe (any command-button press re-checks the watch URLs) must not
   * yank a page the user navigated to out from under them.
   */
  markAvailable: (sessionId: string, url: string, token?: number) => void
  /** Polling timed out. Same stale-token guard as markAvailable. */
  markFailed: (sessionId: string, token?: number) => void
  /** Toggle the pane visibility — flips `isOpen` only. */
  togglePane: (sessionId: string) => void
  /** Explicit set, used by main when WebContentsView errors out. */
  setOpen: (sessionId: string, open: boolean) => void
  /** Ask the pane to show `url` and open it. The address bar, favourites,
   *  home and "open a page" commands all come through here. The caller has
   *  already normalised + validated (shared/browser-url). */
  navigate: (sessionId: string, url: string) => void
  /** Main's report of where the view actually is. */
  setPage: (state: WebviewNavState) => void
  /** Session-scoped home (not persisted). */
  setHomeUrl: (sessionId: string, url: string | null) => void
  /** Wipe state for a session — e.g. on session removal. */
  reset: (sessionId: string) => void
  /**
   * Emergency escape hatch — closes every open pane in the renderer.
   * Used in lock-step with `webview.closeAll()` IPC so the main-process
   * WebContentsViews are destroyed at the same time as the React state.
   */
  closeAllPanes: () => void
}

const defaultState = (): WebviewSessionState => ({
  status: 'idle',
  watchUrl: null,
  currentUrl: null,
  loadedAt: null,
  isOpen: false,
  page: null,
  homeUrl: null,
  activationId: 0,
})

export const useWebviewStore = create<State & Actions>((set, get) => ({
  bySessionId: {},
  startActivation: (sessionId, url) => {
    const cur = get().bySessionId[sessionId] || defaultState()
    const nextToken = cur.activationId + 1
    set((s) => ({
      bySessionId: {
        ...s.bySessionId,
        [sessionId]: {
          ...cur,
          status: 'pending',
          watchUrl: url,
          currentUrl: url,
          loadedAt: null,
          activationId: nextToken,
        },
      },
    }))
    return nextToken
  },
  markAvailable: (sessionId, url, token) => {
    const cur = get().bySessionId[sessionId]
    if (token !== undefined && cur && cur.activationId !== token) return
    set((s) => {
      const prev = s.bySessionId[sessionId] || defaultState()
      return {
        bySessionId: {
          ...s.bySessionId,
          [sessionId]: {
            ...prev,
            status: 'available',
            watchUrl: url,
            currentUrl: prev.currentUrl ?? url,
            loadedAt: Date.now(),
          },
        },
      }
    })
  },
  markFailed: (sessionId, token) => {
    const cur = get().bySessionId[sessionId]
    if (token !== undefined && cur && cur.activationId !== token) return
    set((s) => ({
      bySessionId: {
        ...s.bySessionId,
        [sessionId]: {
          ...(s.bySessionId[sessionId] || defaultState()),
          status: 'failed',
        },
      },
    }))
  },
  // Flip `isOpen` only — status (idle/pending/available/failed) is
  // owned by activation / probe / poll callers and unaffected by
  // showing or hiding the pane.
  togglePane: (sessionId) => {
    const cur = get().bySessionId[sessionId] || defaultState()
    set((s) => ({
      bySessionId: {
        ...s.bySessionId,
        [sessionId]: { ...cur, isOpen: !cur.isOpen },
      },
    }))
  },
  setOpen: (sessionId, open) => {
    const cur = get().bySessionId[sessionId] || defaultState()
    set((s) => ({
      bySessionId: {
        ...s.bySessionId,
        [sessionId]: { ...cur, isOpen: open },
      },
    }))
  },
  navigate: (sessionId, url) => {
    const cur = get().bySessionId[sessionId] || defaultState()
    set((s) => ({
      bySessionId: {
        ...s.bySessionId,
        [sessionId]: { ...cur, currentUrl: url, isOpen: true },
      },
    }))
  },
  setPage: (state) => {
    const cur = get().bySessionId[state.sessionId]
    // A report for a session whose pane has never existed is a stale event
    // from a view that has since been torn down; there is nothing to update.
    if (!cur) return
    set((s) => ({
      bySessionId: {
        ...s.bySessionId,
        [state.sessionId]: {
          ...cur,
          page: {
            url: state.url,
            title: state.title,
            canGoBack: state.canGoBack,
            canGoForward: state.canGoForward,
            loading: state.loading,
          },
        },
      },
    }))
  },
  setHomeUrl: (sessionId, url) => {
    const cur = get().bySessionId[sessionId] || defaultState()
    set((s) => ({
      bySessionId: {
        ...s.bySessionId,
        [sessionId]: { ...cur, homeUrl: url },
      },
    }))
  },
  reset: (sessionId) => {
    set((s) => {
      const next = { ...s.bySessionId }
      delete next[sessionId]
      return { bySessionId: next }
    })
  },
  closeAllPanes: () => {
    set((s) => {
      const next: Record<string, WebviewSessionState> = {}
      for (const [id, st] of Object.entries(s.bySessionId)) {
        next[id] = { ...st, isOpen: false }
      }
      return { bySessionId: next }
    })
  },
}))

/**
 * Poll a URL via the main-process HEAD probe (CORS-bypass) until it
 * responds or the deadline expires. Resolves to true on first 2xx-3xx.
 *
 * Uses the main process because renderer fetch() is bound by CORS
 * for cross-origin URLs — a user's `http://localhost:3000` could be
 * served without CORS headers and fail to even HEAD-probe from here.
 */
export async function pollUrlForContent(url: string, opts: { intervalMs?: number; timeoutMs?: number } = {}): Promise<boolean> {
  const interval = opts.intervalMs ?? 1000
  const deadline = Date.now() + (opts.timeoutMs ?? 30_000)
  while (Date.now() < deadline) {
    try {
      const result = await window.electronAPI.webview.check(url)
      if (result?.reachable) return true
    } catch {
      // network error, registry unavailable, etc — keep polling
    }
    if (Date.now() + interval >= deadline) break
    await new Promise((r) => setTimeout(r, interval))
  }
  return false
}

/**
 * One round of "is anything serving?" — HEAD-probes each URL in order,
 * sets the session to `available` for the first that responds, or
 * downgrades to `failed` when none do *and* we previously thought a
 * server was up.
 *
 * Two callers:
 *   1. CommandBar mount  — auto-detects a server already running before
 *      the app launched.
 *   2. Any command-button press in the session — natural moment to
 *      re-verify (picked over constant polling, which is wasteful and
 *      the user vetoed). Catches "user stopped the dev server, then
 *      clicked a command" without the cost of a background interval.
 *
 * Skips when status is `pending` (an active 30s poll owns the state).
 * Re-probes `available` URLs (intentionally — that's how we catch a
 * server that died). `failed` → `available` transitions are allowed:
 * a server can come back up after a previous timeout.
 */
export async function probeWebviewUrls(sessionId: string, urls: string[]): Promise<boolean> {
  if (urls.length === 0) return false
  const current = useWebviewStore.getState().bySessionId[sessionId]
  if (current?.status === 'pending') return false
  for (const url of urls) {
    try {
      const result = await window.electronAPI.webview.check(url)
      if (result?.reachable) {
        useWebviewStore.getState().markAvailable(sessionId, url)
        return true
      }
    } catch { /* network error — try next URL */ }
  }
  // Nothing reachable. Only downgrade if we previously thought a
  // server was up — leaving `idle` as `idle` (no false-failure state
  // for sessions that have never seen a reachable URL).
  if (current?.status === 'available') {
    useWebviewStore.getState().markFailed(sessionId)
  }
  return false
}
