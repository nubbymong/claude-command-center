import { create } from 'zustand'
import type { DetachedRemote } from '../../shared/types'

/**
 * SSH Persistent — "Resume a Running Session" (Phase 1): the in-memory registry
 * of remote tmux sessions the user LEFT RUNNING.
 *
 * Hydrated from session-state.json on restore (App.tsx) and folded back into it
 * by buildSessionState (session-persistence.ts), so an entry survives an app
 * restart. Lifecycle: `add` on Leave running; `remove` on reattach (Phase 3) or
 * End remote. No default export (project convention).
 */
interface DetachedRemotesState {
  entries: DetachedRemote[]
  /** Add (or replace, by sessionId) a left-running remote. */
  add: (entry: DetachedRemote) => void
  /** Drop the entry for a session id (reattached / ended / stale). */
  remove: (sessionId: string) => void
  /** Replace the whole registry from persisted state on restore. */
  hydrate: (entries: DetachedRemote[] | undefined) => void
}

export const useDetachedRemotesStore = create<DetachedRemotesState>((set) => ({
  entries: [],
  add: (entry) =>
    set((s) => ({
      // Dedupe by sessionId: a re-detach of the same id supersedes the old
      // record rather than stacking a second, stale one.
      entries: [...s.entries.filter((e) => e.sessionId !== entry.sessionId), entry],
    })),
  remove: (sessionId) =>
    set((s) => {
      const entries = s.entries.filter((e) => e.sessionId !== sessionId)
      // Preserve array identity when nothing changed (no-op remove of an id that
      // was never registered — the common End-remote case), so subscribers don't
      // re-render on a teardown that touched no entry.
      return entries.length === s.entries.length ? s : { entries }
    }),
  hydrate: (entries) => set({ entries: Array.isArray(entries) ? entries : [] }),
}))
