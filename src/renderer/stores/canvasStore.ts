// Agent Canvas — renderer store. Versions/active-version mirror the main
// canvas store (hydrated lazily when a pane opens, kept live by the
// `canvas:changed` push); interaction mode (draw/browse) is pure UI state.
// Pane open/close stays in excalidrawStore — the Agent Canvas button IS the
// old Draw button (spec D2), and its empty state is the classic sketchpad.

import { create } from 'zustand'
import type { CanvasState, CanvasVersion } from '../../shared/canvas'

export type CanvasInteractionMode = 'draw' | 'browse'

export interface CanvasSessionState {
  canvasId: string | null
  versions: CanvasVersion[]
  activeVersionId: string | null
  /** Browse first: land on the content, explore, then flip to draw. */
  interactionMode: CanvasInteractionMode
  loaded: boolean
}

interface CanvasStoreState {
  bySessionId: Record<string, CanvasSessionState>
  refresh: (sessionId: string) => Promise<void>
  setInteractionMode: (sessionId: string, mode: CanvasInteractionMode) => void
  setActiveVersion: (sessionId: string, versionId: string) => Promise<void>
  reset: () => void
}

const EMPTY: CanvasSessionState = {
  canvasId: null,
  versions: [],
  activeVersionId: null,
  interactionMode: 'browse',
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
    void useCanvasStore.getState().refresh(event.sessionId)
  })
}
