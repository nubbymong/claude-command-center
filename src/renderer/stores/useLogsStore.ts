import { create } from 'zustand'

/**
 * Per-session Logs-pane open state. Mirrors the excalidrawStore `isOpen` slice
 * but carries no payload, so it is never persisted: pane visibility always
 * restores closed on app restart (like the Draw/Web panes).
 */
interface LogsSessionState {
  isOpen: boolean
}

interface State {
  bySessionId: Record<string, LogsSessionState>
}

interface Actions {
  togglePane: (sessionId: string) => void
  setOpen: (sessionId: string, open: boolean) => void
  reset: (sessionId: string) => void
  /** Drop entries for any sessionId not in the live set (sweep removed sessions). */
  reconcile: (liveSessionIds: string[]) => void
}

export const useLogsStore = create<State & Actions>((set, get) => ({
  bySessionId: {},

  togglePane: (sessionId) => {
    const cur = get().bySessionId[sessionId]?.isOpen ?? false
    set((s) => ({ bySessionId: { ...s.bySessionId, [sessionId]: { isOpen: !cur } } }))
  },

  setOpen: (sessionId, open) => {
    set((s) => ({ bySessionId: { ...s.bySessionId, [sessionId]: { isOpen: open } } }))
  },

  reset: (sessionId) => {
    const next = { ...get().bySessionId }
    delete next[sessionId]
    set({ bySessionId: next })
  },

  reconcile: (liveSessionIds) => {
    const live = new Set(liveSessionIds)
    const current = get().bySessionId
    const orphanIds = Object.keys(current).filter((sid) => !live.has(sid))
    if (orphanIds.length === 0) return
    const next: Record<string, LogsSessionState> = {}
    for (const [sid, s] of Object.entries(current)) if (live.has(sid)) next[sid] = s
    set({ bySessionId: next })
  },
}))
