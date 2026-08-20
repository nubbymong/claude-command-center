// Agent Canvas P3 — renderer store for the review loop.
//
// Two kinds of state per session:
//   - the MIRROR of main's review store (reviews + annotations), hydrated
//     lazily and kept live by the `canvas:reviewChanged` push (armed globally,
//     never from a pane — the cloud-agent listener lesson);
//   - the pane's own INTERACTION state (locked focus + its expand ladder,
//     marquee arming, which note is open in the editor, the checklist's
//     re-anchor results). Main never sees any of that until a note is saved.
//
// Every mutation round-trips through main (the single mutation point) and
// commits the state main returns — the renderer never guesses at what
// persisted.

import { create } from 'zustand'
import type {
  Annotation,
  CanvasAnchorResolution,
  CanvasAnnotationDraft,
  CanvasInspectEntry,
  CanvasReviewState,
  CanvasSketchExport,
  FocusObject,
  Rect,
  Review,
} from '../../shared/canvas'

/** The checklist's one re-anchor pass (D12): keyed by annotation id, valid for
 *  exactly one versionId. `null` entry = needs re-pointing. */
export interface ResolutionPass {
  versionId: string
  byAnnotation: Record<string, CanvasAnchorResolution | null>
}

export interface CanvasReviewSessionState {
  loaded: boolean
  canvasId: string | null
  reviews: Review[]
  annotations: Annotation[]
  /** Locked focus, ready to become a note (element via click, region via
   *  marquee). Hover alone never locks. */
  focus: FocusObject | null
  /** The expand-to-parent ladder from the lock click; empty for regions. */
  focusChain: CanvasInspectEntry[]
  focusChainIndex: number
  marqueeArmed: boolean
  /** Note open in the panel editor (a draft the user is writing/rewording). */
  editingAnnotationId: string | null
  resolution: ResolutionPass | null
  /** Transient highlight driven from the panel (hovered checklist entry):
   *  where the stage should point right now. `reported` is the third kind and
   *  the reason there are three: a box the PAGE claims an old note re-anchors
   *  to is not a box the app measured, and painting it the same as one we did
   *  measure is how a page marked its reviewer's open issues as tracked
   *  (adversarial review, 2026-08-14). */
  panelHighlight: { rect: Rect; kind: 'anchored' | 'ghost' | 'reported' } | null
  /** The "how to review" primer in the notes panel — shown until the user
   *  dismisses it or has written a first note. Renderer-session state only. */
  helpDismissed: boolean
}

const EMPTY: CanvasReviewSessionState = {
  loaded: false,
  canvasId: null,
  reviews: [],
  annotations: [],
  focus: null,
  focusChain: [],
  focusChainIndex: 0,
  marqueeArmed: false,
  editingAnnotationId: null,
  resolution: null,
  panelHighlight: null,
  helpDismissed: false,
}

/** The label the focus chip and the notes panel show for one chain entry —
 *  the same wording the hover chip uses, bounded for the store. */
export function labelForEntry(entry: CanvasInspectEntry): string {
  const base = entry.role || entry.tag
  const withName = entry.name ? `${base} "${entry.name}"` : base
  return withName.slice(0, 120)
}

/** A locked element's FocusObject: ux-id anchor first (primary), fingerprint
 *  always (the fallback the checklist leans on when the id is gone). */
export function focusFromEntry(entry: CanvasInspectEntry, versionId: string): FocusObject {
  return {
    targets: [
      ...(entry.uxId ? [{ kind: 'ux-id' as const, id: entry.uxId }] : []),
      { kind: 'fingerprint' as const, ...entry.fingerprint },
    ],
    bboxPage: entry.box,
    label: labelForEntry(entry),
    versionId,
  }
}

interface CanvasReviewStoreState {
  bySessionId: Record<string, CanvasReviewSessionState>
  refresh: (sessionId: string) => Promise<void>
  lockFocus: (sessionId: string, chain: CanvasInspectEntry[], versionId: string) => void
  expandFocus: (sessionId: string) => void
  clearFocus: (sessionId: string) => void
  setRegionFocus: (sessionId: string, bboxPage: Rect, versionId: string) => void
  setMarqueeArmed: (sessionId: string, armed: boolean) => void
  setEditingAnnotation: (sessionId: string, annotationId: string | null) => void
  setResolution: (sessionId: string, pass: ResolutionPass | null) => void
  setPanelHighlight: (sessionId: string, highlight: CanvasReviewSessionState['panelHighlight']) => void
  dismissHelp: (sessionId: string) => void
  upsertNote: (sessionId: string, draft: CanvasAnnotationDraft) => Promise<string | null>
  deleteNote: (sessionId: string, annotationId: string) => Promise<void>
  submitReview: (sessionId: string, reviewId: string, sketches: CanvasSketchExport[]) => Promise<Review | null>
  resolveNote: (
    sessionId: string,
    annotationId: string,
    action: 'approve' | 'dismiss' | 'reannotate',
  ) => Promise<void>
  reset: () => void
}

function fromMain(prev: CanvasReviewSessionState | undefined, state: CanvasReviewState | null): CanvasReviewSessionState {
  const base = prev ?? EMPTY
  if (!state) return { ...base, canvasId: null, reviews: [], annotations: [], loaded: true }
  return { ...base, canvasId: state.canvasId, reviews: state.reviews, annotations: state.annotations, loaded: true }
}

function patch(
  s: CanvasReviewStoreState,
  sessionId: string,
  updates: Partial<CanvasReviewSessionState>,
): Pick<CanvasReviewStoreState, 'bySessionId'> {
  return {
    bySessionId: {
      ...s.bySessionId,
      [sessionId]: { ...(s.bySessionId[sessionId] ?? EMPTY), ...updates },
    },
  }
}

export const useCanvasReviewStore = create<CanvasReviewStoreState>((set, get) => ({
  bySessionId: {},

  refresh: async (sessionId: string) => {
    try {
      const state = await window.electronAPI.canvas.reviewGetState({ sessionId })
      set((s) => ({
        bySessionId: { ...s.bySessionId, [sessionId]: fromMain(s.bySessionId[sessionId], state) },
      }))
    } catch (err) {
      console.error('[canvasReviewStore] refresh failed:', err)
    }
  },

  lockFocus: (sessionId, chain, versionId) => {
    if (chain.length === 0) return
    set((s) =>
      patch(s, sessionId, {
        focus: focusFromEntry(chain[0], versionId),
        focusChain: chain,
        focusChainIndex: 0,
        marqueeArmed: false,
      }),
    )
  },

  expandFocus: (sessionId) => {
    set((s) => {
      const cur = s.bySessionId[sessionId]
      if (!cur || !cur.focus || cur.focusChain.length === 0) return {}
      const nextIndex = Math.min(cur.focusChainIndex + 1, cur.focusChain.length - 1)
      if (nextIndex === cur.focusChainIndex) return {}
      return patch(s, sessionId, {
        focus: focusFromEntry(cur.focusChain[nextIndex], cur.focus.versionId),
        focusChainIndex: nextIndex,
      })
    })
  },

  clearFocus: (sessionId) => {
    set((s) => patch(s, sessionId, { focus: null, focusChain: [], focusChainIndex: 0 }))
  },

  setRegionFocus: (sessionId, bboxPage, versionId) => {
    const label = `region ${Math.round(bboxPage.width)}×${Math.round(bboxPage.height)}`
    set((s) =>
      patch(s, sessionId, {
        focus: { targets: [], bboxPage, label, versionId },
        focusChain: [],
        focusChainIndex: 0,
        marqueeArmed: false,
      }),
    )
  },

  setMarqueeArmed: (sessionId, armed) => {
    set((s) => patch(s, sessionId, { marqueeArmed: armed }))
  },

  setEditingAnnotation: (sessionId, annotationId) => {
    set((s) => patch(s, sessionId, { editingAnnotationId: annotationId }))
  },

  setResolution: (sessionId, pass) => {
    set((s) => patch(s, sessionId, { resolution: pass }))
  },

  setPanelHighlight: (sessionId, highlight) => {
    set((s) => patch(s, sessionId, { panelHighlight: highlight }))
  },

  dismissHelp: (sessionId) => {
    set((s) => patch(s, sessionId, { helpDismissed: true }))
  },

  upsertNote: async (sessionId, draft) => {
    try {
      const { state, annotationId } = await window.electronAPI.canvas.annotationUpsert({ sessionId, draft })
      set((s) => ({
        bySessionId: { ...s.bySessionId, [sessionId]: fromMain(s.bySessionId[sessionId], state) },
      }))
      return annotationId
    } catch (err) {
      console.error('[canvasReviewStore] upsertNote failed:', err)
      return null
    }
  },

  deleteNote: async (sessionId, annotationId) => {
    try {
      const state = await window.electronAPI.canvas.annotationDelete({ sessionId, annotationId })
      set((s) => {
        const cur = s.bySessionId[sessionId]
        return {
          bySessionId: {
            ...s.bySessionId,
            [sessionId]: {
              ...fromMain(cur, state),
              editingAnnotationId: cur?.editingAnnotationId === annotationId ? null : (cur?.editingAnnotationId ?? null),
            },
          },
        }
      })
    } catch (err) {
      console.error('[canvasReviewStore] deleteNote failed:', err)
    }
  },

  submitReview: async (sessionId, reviewId, sketches) => {
    try {
      const state = await window.electronAPI.canvas.reviewSubmit({ sessionId, reviewId, sketches })
      set((s) => ({
        bySessionId: {
          ...s.bySessionId,
          [sessionId]: { ...fromMain(s.bySessionId[sessionId], state), editingAnnotationId: null, focus: null, focusChain: [], focusChainIndex: 0 },
        },
      }))
      return state.reviews.find((r) => r.id === reviewId) ?? null
    } catch (err) {
      console.error('[canvasReviewStore] submitReview failed:', err)
      return null
    }
  },

  resolveNote: async (sessionId, annotationId, action) => {
    try {
      const { state, reannotationId } = await window.electronAPI.canvas.annotationResolve({ sessionId, annotationId, action })
      set((s) => ({
        bySessionId: {
          ...s.bySessionId,
          [sessionId]: {
            ...fromMain(s.bySessionId[sessionId], state),
            // A re-annotation opens straight in the editor, pre-filled.
            ...(reannotationId ? { editingAnnotationId: reannotationId } : {}),
          },
        },
      }))
    } catch (err) {
      console.error('[canvasReviewStore] resolveNote failed:', err)
    }
  },

  reset: () => set({ bySessionId: {} }),
}))

// Main → renderer push: any review mutation (IPC or future surfaces) refreshes
// that session's mirror. Module-level and idempotent, armed once from App's
// boot effect — review events must never depend on a pane being mounted.
let listenerArmed = false
export function setupCanvasReviewListener(): void {
  if (listenerArmed) return
  listenerArmed = true
  window.electronAPI.canvas.onReviewChanged((event) => {
    void useCanvasReviewStore.getState().refresh(event.sessionId)
  })
}

// ── Derivations the panel and pane share ────────────────────────────────────

export function draftReviewOf(state: CanvasReviewSessionState): Review | null {
  return state.reviews.find((r) => r.status === 'draft') ?? null
}

export function draftAnnotationsOf(state: CanvasReviewSessionState): Annotation[] {
  const draft = draftReviewOf(state)
  if (!draft) return []
  const members = new Set(draft.annotationIds)
  return state.annotations.filter((a) => members.has(a.id))
}

/**
 * Reviews that are OPEN: sent, and not closed out.
 *
 * 'submitted' is not an approximation of that — it IS the store's definition. A
 * review only becomes 'resolved' when no member note is still 'open' or
 * 'addressed', and the agent's own write never recomputes status. So a count
 * derived from this cannot disagree with the data behind it.
 *
 * Deliberately NOT a note count. An 'open' note is waiting on the AGENT and an
 * 'addressed' one is waiting on the USER; they live in the same list, so a
 * number over them means two things at once and cannot be cleared by either
 * party alone.
 */
export function openReviewsOf(state: CanvasReviewSessionState): Review[] {
  return state.reviews.filter((r) => r.status === 'submitted')
}

/** A round of feedback, as the user sent it, with who it is waiting on. */
export interface ReviewGroup {
  review: Review
  /** The notes still in play: 'open' (the agent has not said it acted) and
   *  'addressed' (it has, and the verdict is yours). Dismissed, approved and
   *  superseded notes are done and are not listed. */
  notes: Annotation[]
  /** 'agent' while ANY note is still open — the round cannot be closed by you
   *  alone. 'you' once every remaining note is addressed. 'closed' when nothing
   *  is left. */
  waitingOn: 'you' | 'agent' | 'closed'
  openCount: number
  addressedCount: number
}

/** Sort key for a review: when it was sent, falling back to when it was
 *  started, then to its ordinal. Ids are R1, R2, … per canvas. */
function reviewOrdinal(r: Review): number {
  const n = Number(r.id.slice(1))
  return Number.isFinite(n) ? n : 0
}

/**
 * The submitted reviews as ROUNDS, newest first.
 *
 * The panel used to flatten every open note from every review into one list
 * under a single heading, so a round you sent as a unit came back as loose
 * items: no way to see that a whole round was finished, no way to close one,
 * and this morning's note sitting between two from ten minutes ago.
 *
 * The DRAFT review is deliberately excluded — that one is the composer's own
 * list, below, and showing it twice is how the two get out of step.
 */
export function reviewGroupsOf(state: CanvasReviewSessionState): ReviewGroup[] {
  const byReview = new Map<string, Annotation[]>()
  for (const a of state.annotations) {
    if (a.state !== 'open' && a.state !== 'addressed') continue
    const list = byReview.get(a.reviewId)
    if (list) list.push(a)
    else byReview.set(a.reviewId, [a])
  }
  return state.reviews
    .filter((r) => r.status !== 'draft')
    .map((review) => {
      const notes = byReview.get(review.id) ?? []
      const openCount = notes.filter((n) => n.state === 'open').length
      const addressedCount = notes.length - openCount
      const waitingOn: ReviewGroup['waitingOn'] =
        notes.length === 0 ? 'closed' : openCount > 0 ? 'agent' : 'you'
      return { review, notes, waitingOn, openCount, addressedCount }
    })
    .sort((a, b) => {
      const at = Date.parse(a.review.submittedAt ?? a.review.createdAt)
      const bt = Date.parse(b.review.submittedAt ?? b.review.createdAt)
      if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at
      return reviewOrdinal(b.review) - reviewOrdinal(a.review)
    })
}

/** Notes from SUBMITTED reviews still awaiting the USER's verdict — what the
 *  resolution checklist works through (oldest review first, so the list reads
 *  in the order given). 'addressed' is included: the agent has said it acted,
 *  and that is exactly when the user needs to look and approve or dismiss. */
export function openSubmittedNotesOf(state: CanvasReviewSessionState): Annotation[] {
  const submitted = new Set(state.reviews.filter((r) => r.status === 'submitted').map((r) => r.id))
  return state.annotations.filter((a) => submitted.has(a.reviewId) && (a.state === 'open' || a.state === 'addressed'))
}
