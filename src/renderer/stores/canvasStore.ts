// Agent Canvas — renderer store. Versions/active-version mirror the main
// canvas store (hydrated lazily when a pane opens, kept live by the
// `canvas:changed` push); interaction mode (draw/browse) is pure UI state.
// Pane open/close stays in excalidrawStore — the Agent Canvas button IS the
// old Draw button (spec D2), and its empty state is the classic sketchpad.

import { create } from 'zustand'
import type { CanvasState, CanvasVersion } from '../../shared/canvas'
import { useExcalidrawStore } from './excalidrawStore'

export type CanvasInteractionMode = 'draw' | 'browse'

/** What the pane shows while NOTHING has been rendered: the Agent Canvas
 *  landing (what this is + how to start), or the classic sketchpad. The
 *  landing is the default — the old Draw behaviour is one click away, not
 *  the first thing a user meets (owner feedback 2026-08-13: the empty pane
 *  was indistinguishable from old Draw and taught nothing). */
export type CanvasEmptyView = 'intro' | 'sketchpad'

export interface CanvasSessionState {
  canvasId: string | null
  versions: CanvasVersion[]
  activeVersionId: string | null
  /** Browse first: land on the content, explore, then flip to draw. */
  interactionMode: CanvasInteractionMode
  emptyView: CanvasEmptyView
  /** A render landed while the pane was closed — the hand-back moment the
   *  user has not seen yet. Drives the Canvas button's attention pulse;
   *  cleared the moment the pane shows the canvas. */
  unseenRender: boolean
  loaded: boolean
}

interface CanvasStoreState {
  bySessionId: Record<string, CanvasSessionState>
  refresh: (sessionId: string) => Promise<void>
  setInteractionMode: (sessionId: string, mode: CanvasInteractionMode) => void
  setEmptyView: (sessionId: string, view: CanvasEmptyView) => void
  setActiveVersion: (sessionId: string, versionId: string) => Promise<void>
  markUnseenRender: (sessionId: string) => void
  clearUnseenRender: (sessionId: string) => void
  reset: () => void
}

const EMPTY: CanvasSessionState = {
  canvasId: null,
  versions: [],
  activeVersionId: null,
  interactionMode: 'browse',
  emptyView: 'intro',
  unseenRender: false,
  loaded: false,
}

function fromMain(prev: CanvasSessionState | undefined, state: CanvasState | null): CanvasSessionState {
  const base = prev ?? EMPTY
  if (!state) return { ...base, canvasId: null, versions: [], activeVersionId: null, loaded: true }
  return {
    ...base,
    canvasId: state.canvasId,
    versions: state.versions,
    activeVersionId: state.activeVersionId,
    loaded: true,
  }
}

export const useCanvasStore = create<CanvasStoreState>((set, get) => ({
  bySessionId: {},

  refresh: async (sessionId: string) => {
    try {
      const state = await window.electronAPI.canvas.getState({ sessionId })
      set((s) => ({
        bySessionId: { ...s.bySessionId, [sessionId]: fromMain(s.bySessionId[sessionId], state) },
      }))
    } catch (err) {
      console.error('[canvasStore] refresh failed:', err)
    }
  },

  setInteractionMode: (sessionId: string, mode: CanvasInteractionMode) => {
    set((s) => ({
      bySessionId: {
        ...s.bySessionId,
        [sessionId]: { ...(s.bySessionId[sessionId] ?? EMPTY), interactionMode: mode },
      },
    }))
  },

  setEmptyView: (sessionId: string, view: CanvasEmptyView) => {
    set((s) => ({
      bySessionId: {
        ...s.bySessionId,
        [sessionId]: { ...(s.bySessionId[sessionId] ?? EMPTY), emptyView: view },
      },
    }))
  },

  markUnseenRender: (sessionId: string) => {
    set((s) => ({
      bySessionId: {
        ...s.bySessionId,
        [sessionId]: { ...(s.bySessionId[sessionId] ?? EMPTY), unseenRender: true },
      },
    }))
  },

  clearUnseenRender: (sessionId: string) => {
    set((s) => {
      if (!s.bySessionId[sessionId]?.unseenRender) return {}
      return {
        bySessionId: {
          ...s.bySessionId,
          [sessionId]: { ...s.bySessionId[sessionId], unseenRender: false },
        },
      }
    })
  },

  setActiveVersion: async (sessionId: string, versionId: string) => {
    try {
      const state = await window.electronAPI.canvas.setActiveVersion({ sessionId, versionId })
      set((s) => ({
        bySessionId: { ...s.bySessionId, [sessionId]: fromMain(s.bySessionId[sessionId], state) },
      }))
    } catch (err) {
      console.error('[canvasStore] setActiveVersion failed:', err)
    }
  },

  reset: () => set({ bySessionId: {} }),
}))

// Main → renderer push: any render/switch (IPC today, canvas_render MCP in P3)
// refreshes that session's mirror. Module-level and idempotent, armed once
// from App's boot effect — canvas events must never depend on a pane being
// mounted (same lesson as the cloud-agent listeners).
let listenerArmed = false
export function setupCanvasListener(): void {
  if (listenerArmed) return
  listenerArmed = true
  window.electronAPI.canvas.onChanged((event) => {
    const store = useCanvasStore.getState()
    // The hand-back moment (spec §6 step 1): a render that lands while the
    // pane is CLOSED is news the user has not seen — pulse the Canvas button
    // until they open it. With the pane open, the surface itself shows the
    // change (and version switches the user makes in-pane are not news).
    //
    // A null active version is never news: that is the shape emitted when a
    // canvas goes AWAY (deleted from the library, possibly from another
    // session's window). Pulsing there promises the owning session something
    // new to look at and then shows it an empty pane.
    if (event.activeVersionId && !useExcalidrawStore.getState().bySessionId[event.sessionId]?.isOpen) {
      store.markUnseenRender(event.sessionId)
    }
    void store.refresh(event.sessionId)
  })
}
