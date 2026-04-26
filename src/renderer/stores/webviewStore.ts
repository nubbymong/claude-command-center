import { create } from 'zustand'

/**
 * Per-session state for the webview tool.
 *
 *   idle      → no webview command has been launched (button hidden)
 *   pending   → URL is being polled; button shows neutral pulse
 *   available → URL responded; button pulses GREEN ("ready to view")
 *   failed    → polling timed out; button pulses RED
 *
 * The button is only rendered when status !== 'idle'. Clicking it
 * toggles `isOpen`, which the App-level layout uses to swap the
 * webview pane in for the Claude/Partner pane.
 */
export type WebviewStatus = 'idle' | 'pending' | 'available' | 'failed'

export interface WebviewSessionState {
  status: WebviewStatus
  currentUrl: string | null
  loadedAt: number | null
  isOpen: boolean
}

interface State {
  bySessionId: Record<string, WebviewSessionState>
}

interface Actions {
  /** Begin polling for content. Sets status='pending' and stores URL. */
  startActivation: (sessionId: string, url: string) => void
  /** Polling found content. Sets status='available' (green pulse). */
  markAvailable: (sessionId: string, url: string) => void
  /** Polling timed out. Sets status='failed' (red pulse). */
  markFailed: (sessionId: string) => void
  /** Toggle the pane visibility. Auto-clears the pulse on first open. */
  togglePane: (sessionId: string) => void
  /** Explicit set, used by main when WebContentsView errors out. */
  setOpen: (sessionId: string, open: boolean) => void
  /** Wipe state for a session — e.g. on session removal. */
  reset: (sessionId: string) => void
}

const defaultState = (): WebviewSessionState => ({
  status: 'idle',
  currentUrl: null,
  loadedAt: null,
  isOpen: false,
})

export const useWebviewStore = create<State & Actions>((set, get) => ({
  bySessionId: {},
  startActivation: (sessionId, url) => {
    set((s) => ({
      bySessionId: {
        ...s.bySessionId,
        [sessionId]: {
          ...(s.bySessionId[sessionId] || defaultState()),
          status: 'pending',
          currentUrl: url,
          loadedAt: null,
        },
      },
    }))
  },
  markAvailable: (sessionId, url) => {
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
  markFailed: (sessionId) => {
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
