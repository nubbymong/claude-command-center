import { create } from 'zustand'
import type { HookEvent, HookEventKind } from '../../shared/hook-types'

const MAX_PER_SESSION = 200

/**
 * Renderer-only wrapper on top of HookEvent that carries a monotonic
 * sequence number assigned at ingest time. Needed as a stable React key
 * in list views: two events can arrive in the same millisecond with the
 * same kind+tool under bursty hook streams, so `ts + event + toolName`
 * is not guaranteed unique. __seq is monotonic across all sessions and
 * never changes once assigned.
 */
export type StoredHookEvent = HookEvent & { __seq: number }

let nextSeq = 1

interface State {
  eventsBySession: Map<string, StoredHookEvent[]>
  droppedBySession: Map<string, boolean>
  paused: boolean
  filter: Set<HookEventKind> | null
  ingest: (e: HookEvent) => void
  rehydrate: (sid: string, events: HookEvent[]) => void
  clearSession: (sid: string) => void
  markDropped: (sid: string) => void
  setPaused: (p: boolean) => void
  setFilter: (f: Set<HookEventKind> | null) => void
}

export const useHooksStore = create<State>((set) => ({
  eventsBySession: new Map(),
  droppedBySession: new Map(),
  paused: false,
  filter: null,

  ingest: (e) => {
    set((s) => {
      const next = new Map(s.eventsBySession)
      const list = next.get(e.sessionId) ?? []
      const appended: StoredHookEvent[] = [...list, { ...e, __seq: nextSeq++ }]
      if (appended.length > MAX_PER_SESSION) {
        appended.splice(0, appended.length - MAX_PER_SESSION)
      }
      next.set(e.sessionId, appended)
      return { eventsBySession: next }
    })
  },

  rehydrate: (sid, events) => {
    set((s) => {
      const next = new Map(s.eventsBySession)
      // Attach seq to rehydrated events too so list keys stay stable.
      const tagged: StoredHookEvent[] = events.map((e) => ({ ...e, __seq: nextSeq++ }))
      next.set(sid, tagged.slice(-MAX_PER_SESSION))
      return { eventsBySession: next }
    })
  },

  clearSession: (sid) => {
    set((s) => {
      const next = new Map(s.eventsBySession)
      next.delete(sid)
      const d = new Map(s.droppedBySession)
      d.delete(sid)
      return { eventsBySession: next, droppedBySession: d }
    })
  },

  markDropped: (sid) => {
    set((s) => {
      const d = new Map(s.droppedBySession)
      d.set(sid, true)
      return { droppedBySession: d }
    })
  },

  setPaused: (p) => set({ paused: p }),
  setFilter: (f) => set({ filter: f }),
}))
