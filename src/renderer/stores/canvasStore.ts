// Agent Canvas — renderer store. Versions/active-version mirror the main
// canvas store (hydrated lazily when a pane opens, kept live by the
// `canvas:changed` push); interaction mode (draw/browse) is pure UI state.
// Pane open/close stays in excalidrawStore — the Agent Canvas button IS the
// old Draw button (spec D2), and its empty state is the classic sketchpad.

import { create } from 'zustand'
import type { CanvasState, CanvasVersion } from '../../shared/canvas'
import { useExcalidrawStore } from './excalidrawStore'
import { useCanvasReviewStore } from './canvasReviewStore'

export type CanvasInteractionMode = 'draw' | 'browse'

/** What the pane shows while NOTHING has been rendered: the Agent Canvas
 *  landing (what this is + how to start), or the classic sketchpad. The
 *  landing is the default — the old Draw behaviour is one click away, not
 *  the first thing a user meets (owner feedback 2026-08-13: the empty pane
 *  was indistinguishable from old Draw and taught nothing). */
export type CanvasEmptyView = 'intro' | 'sketchpad'

export interface CanvasSessionState {
  canvasId: string | null
  /** What this canvas is OF, in the agent's own words. A LABEL: sanitized in
   *  main, and never a key for serving or authorizing anything. It crossed the
   *  IPC boundary from the start and was then dropped here, which is why the
   *  pane could show which VERSION you were on but never which canvas. */
  title?: string
  versions: CanvasVersion[]
  activeVersionId: string | null
  /** Browse first: land on the content, explore, then flip to draw. */
  interactionMode: CanvasInteractionMode
  emptyView: CanvasEmptyView
  /** A render landed while the pane was closed — the hand-back moment the
   *  user has not seen yet. Drives the Canvas button's attention pulse;
   *  cleared the moment the pane shows the canvas. */
  unseenRender: boolean
  /** The canvas that was moved aside under the user, if one was.
   *
   *  A render naming a different subject FILES the current canvas and repoints
   *  the session at a new one — taking any unresolved notes on it out of view —
   *  and nothing said a word. The pane could always see the change (the id
   *  underneath it changed); it just had nowhere to say so. Cleared when the
   *  user dismisses it or goes back. */
  filedNotice?: FiledNotice | null
  loaded: boolean
}

/** What was filed, and what went with it. The note counts come from the review
 *  mirror as it stood BEFORE the switch — the only moment the renderer knows
 *  them, since every session-scoped read follows the session to its new canvas. */
export interface FiledNotice {
  canvasId: string
  title?: string
  /** Notes still in play on submitted reviews when it was filed. */
  openNotes: number
  /** Notes the user had written and not yet sent. The sharper loss. */
  draftNotes: number
}

interface CanvasStoreState {
  bySessionId: Record<string, CanvasSessionState>
  refresh: (sessionId: string) => Promise<void>
  setInteractionMode: (sessionId: string, mode: CanvasInteractionMode) => void
  setEmptyView: (sessionId: string, view: CanvasEmptyView) => void
  setActiveVersion: (sessionId: string, versionId: string) => Promise<void>
  markUnseenRender: (sessionId: string) => void
  clearUnseenRender: (sessionId: string) => void
  /** The user is deliberately switching canvas — the next change under this
   *  session is theirs, not a filing, and must not be announced as one. */
  expectSwitch: (sessionId: string) => void
  /** ...and the switch did not happen. The flag is consumed by the change push,
   *  so a switch that fails never consumes it, and it would go on to swallow the
   *  next REAL filing notice for that session — the one case the notice exists
   *  for. Every caller of expectSwitch owns cancelling it on failure. */
  cancelExpectedSwitch: (sessionId: string) => void
  noteFiled: (sessionId: string, notice: FiledNotice) => void
  dismissFiled: (sessionId: string) => void
  reset: () => void
}

const EMPTY: CanvasSessionState = {
  canvasId: null,
  versions: [],
  activeVersionId: null,
  interactionMode: 'browse',
  emptyView: 'intro',
  unseenRender: false,
  filedNotice: null,
  loaded: false,
}

function fromMain(prev: CanvasSessionState | undefined, state: CanvasState | null): CanvasSessionState {
  const base = prev ?? EMPTY
  if (!state) return { ...base, canvasId: null, title: undefined, versions: [], activeVersionId: null, loaded: true }
  return {
    ...base,
    canvasId: state.canvasId,
    title: state.title,
    versions: state.versions,
    activeVersionId: state.activeVersionId,
    loaded: true,
  }
}

/** Sessions whose next canvas change the USER asked for. Module-level, not
 *  store state: it is a one-shot handshake between the picker and the push
 *  listener, never something a component renders. */
const expectedSwitches = new Set<string>()

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

  expectSwitch: (sessionId: string) => {
    expectedSwitches.add(sessionId)
  },

  cancelExpectedSwitch: (sessionId: string) => {
    expectedSwitches.delete(sessionId)
  },

  noteFiled: (sessionId: string, notice: FiledNotice) => {
    set((s) => ({
      bySessionId: {
        ...s.bySessionId,
        [sessionId]: { ...(s.bySessionId[sessionId] ?? EMPTY), filedNotice: notice },
      },
    }))
  },

  dismissFiled: (sessionId: string) => {
    set((s) => {
      if (!s.bySessionId[sessionId]?.filedNotice) return {}
      return {
        bySessionId: { ...s.bySessionId, [sessionId]: { ...s.bySessionId[sessionId], filedNotice: null } },
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
    // FILING: the canvas under this session changed identity. That happens when
    // the agent names a different subject — the canvas the user was reviewing is
    // moved aside, unresolved notes and all — and it used to happen in silence.
    // A switch the USER asked for changes the same id and is not news, so the
    // picker announces itself first.
    const prev = store.bySessionId[event.sessionId]
    const userAsked = expectedSwitches.delete(event.sessionId)
    if (!userAsked && prev?.canvasId && event.canvasId && event.canvasId !== prev.canvasId) {
      // Counted from the review mirror as it stands NOW, before the refresh
      // below follows the session to its new canvas. This is the only moment
      // the renderer knows what was left behind.
      const review = useCanvasReviewStore.getState().bySessionId[event.sessionId]
      let openNotes = 0
      let draftNotes = 0
      if (review && review.canvasId === prev.canvasId) {
        const submitted = new Set(review.reviews.filter((r) => r.status === 'submitted').map((r) => r.id))
        const drafts = new Set(review.reviews.filter((r) => r.status === 'draft').flatMap((r) => r.annotationIds))
        for (const a of review.annotations) {
          if (drafts.has(a.id)) draftNotes++
          else if (submitted.has(a.reviewId) && (a.state === 'open' || a.state === 'addressed')) openNotes++
        }
      }
      store.noteFiled(event.sessionId, {
        canvasId: prev.canvasId,
        title: prev.title,
        openNotes,
        draftNotes,
      })
    }
    void store.refresh(event.sessionId)
  })
}
