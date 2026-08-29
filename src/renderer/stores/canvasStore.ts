// Agent Canvas — renderer store. Versions/active-version mirror the main
// canvas store (hydrated lazily when a pane opens, kept live by the
// `canvas:changed` push); interaction mode (draw/browse) is pure UI state.
// Pane open/close stays in excalidrawStore — the Agent Canvas button IS the
// old Draw button (spec D2), and its empty state is the classic sketchpad.

import { create } from 'zustand'
import type { CanvasAwaitingReview, CanvasCompletion, CanvasSketchScene, CanvasState, CanvasVersion } from '../../shared/canvas'
import { resetAllTrails, resetTrailsForCanvas } from '../canvas/canvas-trail'
import { useExcalidrawStore } from './excalidrawStore'
import { useCanvasReviewStore } from './canvasReviewStore'
import { useCanvasTotalsStore } from './canvasTotalsStore'

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
  /** A ready-marked round awaiting the user's first review (#366) — the live
   *  half of the queue number for the canvas on screen. */
  awaitingReview?: CanvasAwaitingReview
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
  /** Signed off (#476) — present only when the pane is showing a completed
   *  canvas the user deliberately reopened to view; the working chrome swaps
   *  for a Completed chip and note-taking is off. */
  completed?: CanvasCompletion
  /** The subject just signed off under this session (#476): the front page
   *  shows one quiet acknowledgment row with a Reopen. Cleared by dismissal,
   *  by Reopen, or by the next canvas appearing. */
  completedNotice?: { canvasId: string; title?: string } | null
  loaded: boolean
}

// The serialised glass scene is declared ONCE, in the shared contract — four
// files hand it to each other (pane, panel, IPC, main) and a structural copy in
// each is how they drift into disagreeing about a field. Re-exported so the
// stores' own importers need not know where it lives.
export type { CanvasSketchScene }

/**
 * A canvas's sketch state that lives only in renderer memory (W20).
 *
 * The scene ITSELF is persisted to disk by the notes panel (it owns the
 * composer-draft IPC). Two things do not need to be, and are kept here instead:
 *
 * - `attached` — which strokes a note has already taken. That is a fact about
 *   the notes, which are persisted; re-deriving it costs nothing and writing it
 *   would be a second, forkable copy of the same truth.
 * - `scene` — a BELT, not the record. Closing and reopening the pane unmounts
 *   the glass, and waiting for a disk round-trip to put the strokes back reads
 *   as having lost them. Keyed by canvas, because a Library "open here" swaps
 *   the canvas under a mounted pane and v1 exists on all of them.
 */
export interface CanvasSketchMemory {
  attached: string[]
  scene: CanvasSketchScene | null
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
  /** Per-CANVAS sketch memory (W20) — see CanvasSketchMemory. Not per session:
   *  the glass belongs to the canvas on screen, not to the tile showing it. */
  sketchByCanvasId: Record<string, CanvasSketchMemory>
  refresh: (sessionId: string) => Promise<void>
  setInteractionMode: (sessionId: string, mode: CanvasInteractionMode) => void
  setEmptyView: (sessionId: string, view: CanvasEmptyView) => void
  setActiveVersion: (sessionId: string, versionId: string) => Promise<void>
  /** Testing mode (M3): name (or un-name) the test pack for one uat version.
   *  `null` clears the user's name and the derived default takes over. */
  setPackName: (sessionId: string, versionId: string, name: string | null) => Promise<void>
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
  noteCompleted: (sessionId: string, notice: { canvasId: string; title?: string }) => void
  dismissCompleted: (sessionId: string) => void
  /** These strokes now ride a note, so the next note must not take them again. */
  markSketchAttached: (canvasId: string, ids: readonly string[]) => void
  /** Park (or clear) the glass scene for a canvas — the pane-toggle belt. */
  stashSketchScene: (canvasId: string, scene: CanvasSketchScene | null) => void
  reset: () => void
}

const EMPTY_SKETCH: CanvasSketchMemory = { attached: [], scene: null }

/** "The user cleared the glass", said positively — see stashSketchScene. */
const EMPTY_SKETCH_SCENE: CanvasSketchScene = { scene: '[]', versions: {} }

const EMPTY: CanvasSessionState = {
  canvasId: null,
  versions: [],
  activeVersionId: null,
  interactionMode: 'browse',
  emptyView: 'intro',
  unseenRender: false,
  filedNotice: null,
  completedNotice: null,
  loaded: false,
}

function fromMain(prev: CanvasSessionState | undefined, state: CanvasState | null): CanvasSessionState {
  const base = prev ?? EMPTY
  if (!state) return { ...base, canvasId: null, title: undefined, versions: [], activeVersionId: null, awaitingReview: undefined, completed: undefined, loaded: true }
  return {
    ...base,
    canvasId: state.canvasId,
    title: state.title,
    versions: state.versions,
    activeVersionId: state.activeVersionId,
    awaitingReview: state.awaitingReview,
    completed: state.completed,
    // A live canvas on screen replaces the sign-off acknowledgment.
    completedNotice: null,
    loaded: true,
  }
}

/**
 * How many canvas switches the USER has asked for and not yet seen land, per
 * session. Module-level, not store state: it is a handshake between the picker
 * and the push listener, never something a component renders.
 *
 * A COUNT, not a flag. Two switch attempts can be in flight at once — the filed
 * strip and the subject picker are both mounted, with independent busy state —
 * and with a flag the failing one's cancel took the succeeding one's
 * announcement with it, so a switch the user asked for was reported to them as
 * a filing. The opposite of what any of this is for.
 */
const expectedSwitches = new Map<string, number>()

/** Take one expectation if this session has any. */
function consumeExpectedSwitch(sessionId: string): boolean {
  const pending = expectedSwitches.get(sessionId) ?? 0
  if (pending <= 0) return false
  if (pending === 1) expectedSwitches.delete(sessionId)
  else expectedSwitches.set(sessionId, pending - 1)
  return true
}

export const useCanvasStore = create<CanvasStoreState>((set, get) => ({
  bySessionId: {},
  sketchByCanvasId: {},

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
    expectedSwitches.set(sessionId, (expectedSwitches.get(sessionId) ?? 0) + 1)
  },

  cancelExpectedSwitch: (sessionId: string) => {
    consumeExpectedSwitch(sessionId)
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

  noteCompleted: (sessionId: string, notice: { canvasId: string; title?: string }) => {
    set((s) => ({
      bySessionId: {
        ...s.bySessionId,
        [sessionId]: { ...(s.bySessionId[sessionId] ?? EMPTY), completedNotice: notice },
      },
    }))
  },

  dismissCompleted: (sessionId: string) => {
    set((s) => {
      if (!s.bySessionId[sessionId]?.completedNotice) return {}
      return {
        bySessionId: { ...s.bySessionId, [sessionId]: { ...s.bySessionId[sessionId], completedNotice: null } },
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

  setPackName: async (sessionId: string, versionId: string, name: string | null) => {
    const canvasId = get().bySessionId[sessionId]?.canvasId
    if (!canvasId) return
    try {
      const state = await window.electronAPI.canvas.setPackName({ sessionId, canvasId, versionId, name })
      set((s) => ({
        bySessionId: { ...s.bySessionId, [sessionId]: fromMain(s.bySessionId[sessionId], state) },
      }))
    } catch (err) {
      // A refused rename is cosmetic: the derived default still names the pack,
      // and the header simply shows what main kept.
      console.error('[canvasStore] setPackName failed:', err)
    }
  },

  markSketchAttached: (canvasId: string, ids: readonly string[]) => {
    if (ids.length === 0) return
    set((s) => {
      const prev = s.sketchByCanvasId[canvasId] ?? EMPTY_SKETCH
      // Deduped: a note can be added twice from the same strokes only if the
      // pane asked twice, and a doubled id would make the unattached set look
      // right while the count of what rides the note did not.
      const attached = Array.from(new Set([...prev.attached, ...ids]))
      return { sketchByCanvasId: { ...s.sketchByCanvasId, [canvasId]: { ...prev, attached } } }
    })
  },

  stashSketchScene: (canvasId: string, scene: CanvasSketchScene | null) => {
    set((s) => {
      const prev = s.sketchByCanvasId[canvasId] ?? EMPTY_SKETCH
      // Null never DOWNGRADES a belt that has held a scene. Null means "nothing
      // parked here, fall through to disk", and once this canvas has parked a
      // scene that answer is wrong in the one case it matters: a user who
      // cleared the glass and closed the pane would have the disk copy put
      // their deleted strokes back. An emptied glass parks an empty scene
      // instead — the pane sends one — and this refuses to lose it.
      const next = scene ?? (prev.scene ? EMPTY_SKETCH_SCENE : null)
      return { sketchByCanvasId: { ...s.sketchByCanvasId, [canvasId]: { ...prev, scene: next } } }
    })
  },

  // Resets the pending-switch counts too, and the action trails (M3). Both live
  // outside the store object but they ARE store state, and a reset that left
  // them behind meant an expectation — or a run's recorded actions — could
  // outlive everything it referred to.
  reset: () => {
    expectedSwitches.clear()
    resetAllTrails()
    set({ bySessionId: {}, sketchByCanvasId: {} })
  },
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
    // A DRAFT render surfaces NOTHING (#366) — and that means the whole
    // listener, not just the pulse. Refreshing the mirror would move the pane
    // onto the draft's canvas (a draft that names a new subject files the old
    // one and repoints the session), and announcing the filing would tell the
    // user about work they asked not to be told about. The mirror simply
    // stays where it is: the pane keeps showing the last ready canvas and
    // version, and the deferred filing notice fires with the ready-mark's own
    // event, whose `prev` is still the canvas the user was on.
    if (event.draft) return
    // The hand-back moment (spec §6 step 1): a render that lands while the
    // pane is CLOSED is news the user has not seen — pulse the Canvas button
    // until they open it. With the pane open, the surface itself shows the
    // change (and version switches the user makes in-pane are not news).
    //
    // A null active version is never news: that is the shape emitted when a
    // canvas goes AWAY (deleted from the library, possibly from another
    // session's window). Pulsing there promises the owning session something
    // new to look at and then shows it an empty pane.
    if (event.activeVersionId && !event.completed && !event.reopened && !useExcalidrawStore.getState().bySessionId[event.sessionId]?.isOpen) {
      // (A sign-off is not news to review, and a reopen is the user's own
      // gesture — no pulse for either.)
      store.markUnseenRender(event.sessionId)
    }
    // SIGN-OFF (#476): the subject completed and the session detached from the
    // canvas. Capture the title from the mirror as it stands NOW — the refresh
    // below comes back empty — so the front page can name what completed.
    if (event.completed) {
      const cur = store.bySessionId[event.sessionId]
      store.noteCompleted(event.sessionId, {
        canvasId: event.canvasId,
        title: cur?.canvasId === event.canvasId ? cur.title : undefined,
      })
    }
    // FILING: the canvas under this session changed identity. That happens when
    // the agent names a different subject — the canvas the user was reviewing is
    // moved aside, unresolved notes and all — and it used to happen in silence.
    // A switch the USER asked for changes the same id and is not news, so the
    // picker announces itself first.
    const prev = store.bySessionId[event.sessionId]
    // Only an IDENTITY change consumes an expectation. The consume used to run
    // on every change for the session, so an ordinary new version rendered on
    // the canvas you are already on ate the announcement, and the switch you
    // had actually asked for then arrived looking like a filing.
    // Named rather than inlined so the consume can be gated on it too — and
    // typed as the id it is, so the notice below keeps its narrowing.
    // A REOPEN can name a canvas that is not the session's current one — the
    // library row's Reopen — and nothing was filed by it; the detector must
    // stand down or it announces a filing that never happened (#476). Same
    // for a render while VIEWING a completed canvas: the fresh canvas that
    // starts is not a filing of the signed-off one — it was already in the
    // library, and "I filed it when the agent started a different subject"
    // would be false twice over.
    // SWITCHED (identity changed) and FILED (that change is worth announcing)
    // are separate questions: an announced switch AWAY FROM a completed canvas
    // is a real identity change whose expectation must still be CONSUMED, or
    // the leftover expectation would swallow the next genuine filing — even
    // though nothing was filed by it (the completed canvas was already
    // library history, so the strip stands down).
    const switched = Boolean(
      !event.reopened && prev?.canvasId && event.canvasId && event.canvasId !== prev.canvasId,
    )
    const userAsked = switched && consumeExpectedSwitch(event.sessionId)
    // The session has left that canvas, so its runs are no longer being
    // recorded. The trail is renderer-memory evidence of a LIVE run; anything
    // already locked to a note is on disk, and keeping the rest would leave a
    // ring per canvas the user ever passed through.
    if (switched && prev?.canvasId) resetTrailsForCanvas(prev.canvasId)
    const filedCanvasId: string | null = switched && !prev!.completed ? prev!.canvasId : null
    if (!userAsked && filedCanvasId !== null) {
      // Counted from the review mirror as it stands NOW, before the refresh
      // below follows the session to its new canvas. This is the only moment
      // the renderer knows what was left behind.
      const review = useCanvasReviewStore.getState().bySessionId[event.sessionId]
      let openNotes = 0
      let draftNotes = 0
      if (review && review.canvasId === filedCanvasId) {
        const submitted = new Set(review.reviews.filter((r) => r.status === 'submitted').map((r) => r.id))
        const drafts = new Set(review.reviews.filter((r) => r.status === 'draft').flatMap((r) => r.annotationIds))
        for (const a of review.annotations) {
          if (drafts.has(a.id)) draftNotes++
          else if (submitted.has(a.reviewId) && (a.state === 'open' || a.state === 'addressed')) openNotes++
        }
      }
      store.noteFiled(event.sessionId, {
        canvasId: filedCanvasId,
        title: prev?.title,
        openNotes,
        draftNotes,
      })
    }
    void store.refresh(event.sessionId)
    // A render, a filing or a switch can change what the session owns and
    // what is owed across it — the cross-canvas total follows.
    useCanvasTotalsStore.getState().scheduleRefresh(event.sessionId)
  })
}
