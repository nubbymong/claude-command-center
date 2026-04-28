import { create } from 'zustand'
import { saveConfigDebounced, saveConfigNow } from '../utils/config-saver'
import { generateId } from '../utils/id'

/**
 * Per-session Excalidraw library.
 *
 * Each session keeps its own collection of drawings. Drawings are
 * autosaved on every change (debounced 400 ms) and named — users can
 * rename via the pane header. The pane itself replaces the previous
 * fixed-overlay modal so it occupies only the same content area as
 * Claude/Partner/Webview, not the whole app window.
 *
 * Persistence: serialised under config key `excalidraw` as
 *   { bySessionId: { [sid]: { drawings, activeDrawingId } } }
 *
 * `isOpen` is intentionally session-scoped so the user can have
 * Excalidraw open in one session and Claude in another without the
 * panes fighting.
 */
export interface ExcalidrawDrawing {
  id: string
  name: string
  // Stored as-is from `serializeAsJSON` — keeps elements + appState +
  // files together. Treated opaquely here; the pane re-hydrates it.
  scene: unknown
  createdAt: number
  updatedAt: number
}

export interface ExcalidrawSessionState {
  drawings: ExcalidrawDrawing[]
  activeDrawingId: string | null
  isOpen: boolean
}

interface PersistedShape {
  bySessionId: Record<string, Omit<ExcalidrawSessionState, 'isOpen'>>
}

interface State {
  bySessionId: Record<string, ExcalidrawSessionState>
}

interface Actions {
  hydrate: (data: PersistedShape) => void
  togglePane: (sessionId: string) => void
  setOpen: (sessionId: string, open: boolean) => void
  newDrawing: (sessionId: string, name?: string) => string
  selectDrawing: (sessionId: string, drawingId: string) => void
  renameDrawing: (sessionId: string, drawingId: string, newName: string) => void
  deleteDrawing: (sessionId: string, drawingId: string) => void
  /** Autosave-friendly scene update (debounced persistence). */
  updateScene: (sessionId: string, drawingId: string, scene: unknown) => void
  /** Drop session state — call on session removal. */
  reset: (sessionId: string) => void
  /** Drop entries for any sessionId not in the provided live set. Use to
   * sweep orphans left behind by removed/expired sessions so the
   * persisted JSON doesn't grow unbounded. No-op when nothing to drop. */
  reconcile: (liveSessionIds: string[]) => void
}

const defaultState = (): ExcalidrawSessionState => ({
  drawings: [],
  activeDrawingId: null,
  isOpen: false,
})

const persist = (state: State, immediate = false) => {
  // Strip the volatile `isOpen` flag — pane visibility shouldn't carry
  // across app restarts (we always restore with everything closed).
  const persisted: PersistedShape = { bySessionId: {} }
  for (const [sid, s] of Object.entries(state.bySessionId)) {
    persisted.bySessionId[sid] = {
      drawings: s.drawings,
      activeDrawingId: s.activeDrawingId,
    }
  }
  if (immediate) saveConfigNow('excalidraw', persisted)
  else saveConfigDebounced('excalidraw', persisted, 400)
}

const nextUntitledName = (drawings: ExcalidrawDrawing[]): string => {
  const used = new Set(drawings.map((d) => d.name))
  for (let i = 1; i < 1000; i++) {
    const name = `Untitled ${i}`
    if (!used.has(name)) return name
  }
  return `Untitled ${Date.now()}`
}

export const useExcalidrawStore = create<State & Actions>((set, get) => ({
  bySessionId: {},

  hydrate: (data) => {
    const next: Record<string, ExcalidrawSessionState> = {}
    for (const [sid, s] of Object.entries(data?.bySessionId ?? {})) {
      next[sid] = {
        drawings: s.drawings ?? [],
        activeDrawingId: s.activeDrawingId ?? null,
        isOpen: false,
      }
    }
    set({ bySessionId: next })
  },

  togglePane: (sessionId) => {
    const cur = get().bySessionId[sessionId] ?? defaultState()
    set((s) => ({
      bySessionId: { ...s.bySessionId, [sessionId]: { ...cur, isOpen: !cur.isOpen } },
    }))
  },

  setOpen: (sessionId, open) => {
    const cur = get().bySessionId[sessionId] ?? defaultState()
    set((s) => ({
      bySessionId: { ...s.bySessionId, [sessionId]: { ...cur, isOpen: open } },
    }))
  },

  newDrawing: (sessionId, name) => {
    const cur = get().bySessionId[sessionId] ?? defaultState()
    const id = generateId()
    const drawing: ExcalidrawDrawing = {
      id,
      name: name?.trim() || nextUntitledName(cur.drawings),
      scene: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const newState: State = {
      bySessionId: {
        ...get().bySessionId,
        [sessionId]: {
          ...cur,
          drawings: [...cur.drawings, drawing],
          activeDrawingId: id,
        },
      },
    }
    set(newState)
    persist(newState, true)
    return id
  },

  selectDrawing: (sessionId, drawingId) => {
    const cur = get().bySessionId[sessionId] ?? defaultState()
    const next: State = {
      bySessionId: {
        ...get().bySessionId,
        [sessionId]: { ...cur, activeDrawingId: drawingId },
      },
    }
    set(next)
    persist(next, true)
  },

  renameDrawing: (sessionId, drawingId, newName) => {
    const cur = get().bySessionId[sessionId] ?? defaultState()
    const trimmed = newName.trim()
    if (!trimmed) return
    const next: State = {
      bySessionId: {
        ...get().bySessionId,
        [sessionId]: {
          ...cur,
          drawings: cur.drawings.map((d) =>
            d.id === drawingId ? { ...d, name: trimmed, updatedAt: Date.now() } : d,
          ),
        },
      },
    }
    set(next)
    persist(next, true)
  },

  deleteDrawing: (sessionId, drawingId) => {
    const cur = get().bySessionId[sessionId] ?? defaultState()
    const remaining = cur.drawings.filter((d) => d.id !== drawingId)
    const next: State = {
      bySessionId: {
        ...get().bySessionId,
        [sessionId]: {
          ...cur,
          drawings: remaining,
          activeDrawingId: cur.activeDrawingId === drawingId
            ? (remaining[0]?.id ?? null)
            : cur.activeDrawingId,
        },
      },
    }
    set(next)
    persist(next, true)
  },

  updateScene: (sessionId, drawingId, scene) => {
    const cur = get().bySessionId[sessionId] ?? defaultState()
    if (!cur.drawings.some((d) => d.id === drawingId)) return
    const next: State = {
      bySessionId: {
        ...get().bySessionId,
        [sessionId]: {
          ...cur,
          drawings: cur.drawings.map((d) =>
            d.id === drawingId ? { ...d, scene, updatedAt: Date.now() } : d,
          ),
        },
      },
    }
    set(next)
    persist(next) // debounced
  },

  reset: (sessionId) => {
    const next = { ...get().bySessionId }
    delete next[sessionId]
    const ns: State = { bySessionId: next }
    set(ns)
    persist(ns, true)
  },

  reconcile: (liveSessionIds) => {
    const live = new Set(liveSessionIds)
    const current = get().bySessionId
    const orphanIds = Object.keys(current).filter((sid) => !live.has(sid))
    if (orphanIds.length === 0) return
    const next: Record<string, ExcalidrawSessionState> = {}
    for (const [sid, s] of Object.entries(current)) {
      if (live.has(sid)) next[sid] = s
    }
    const ns: State = { bySessionId: next }
    set(ns)
    persist(ns, true)
  },
}))
