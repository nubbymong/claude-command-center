import { create } from 'zustand'

/**
 * Per-session state for the webview tool.
 *
 *   idle      → no webview command has fired; URL not yet probed
 *   pending   → URL is being polled; button shows neutral pulse
 *   available → URL responded; button pulses GREEN ("ready to view")
 *   failed    → polling timed out / server died; button shows RED
 *
 * The button is rendered whenever the session has at least one
 * webview-enabled command (`hasWebviewCommand` prop on WebviewButton).
 * In the `idle` state the button is greyed out + disabled with a
 * tooltip explaining how to activate it. Clicking when non-idle
 * toggles `isOpen`, which the App-level layout uses to swap the
 * webview pane in for the Claude/Partner pane.
 */
export type WebviewStatus = 'idle' | 'pending' | 'available' | 'failed'

export interface WebviewSessionState {
  status: WebviewStatus
  currentUrl: string | null
  loadedAt: number | null
  isOpen: boolean
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
   */
  startActivation: (sessionId: string, url: string) => number
  /**
   * Polling found content. When `token` is provided and doesn't
   * match the latest activationId, the call is dropped (stale poll).
   */
  markAvailable: (sessionId: string, url: string, token?: number) => void
  /** Polling timed out. Same stale-token guard as markAvailable. */
  markFailed: (sessionId: string, token?: number) => void
  /** Toggle the pane visibility — flips `isOpen` only. */
  togglePane: (sessionId: string) => void
  /** Explicit set, used by main when WebContentsView errors out. */
  setOpen: (sessionId: string, open: boolean) => void
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
  currentUrl: null,
  loadedAt: null,
  isOpen: false,
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
    set((s) => ({
      bySessionId: {
        ...s.bySessionId,
        [sessionId]: {
          ...(s.bySessionId[sessionId] || defaultState()),
          status: 'available',
          currentUrl: url,
          loadedAt: Date.now(),
        },
      },
    }))
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
