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
import { useCanvasTotalsStore } from './canvasTotalsStore'
import { artifactPhaseOf, artifactRunContaining, isLiveNote, isSettledNote } from '../../shared/canvas'
import type {
  Annotation,
  ArtifactPhase,
  CanvasAnchorResolution,
  CanvasAnnotationDraft,
  CanvasInspectEntry,
  CanvasReviewState,
  CanvasSketchExport,
  CanvasVersion,
  ComposerDraft,
  ComposerDraftInput,
  FocusObject,
  Rect,
  Review,
  TrailEntry,
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
  /**
   * The half-written note as MAIN holds it (W14).
   *
   * Mirrored rather than kept in React state, which is the whole point: the
   * composer's text, decision, target, pasted images and drawing used to live
   * only in the panel, so a pane switch threw them away. Every field the
   * composer owns now round-trips through main, and this is the copy the panel
   * restores from on mount.
   */
  composer: ComposerDraft | null
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
}

const EMPTY: CanvasReviewSessionState = {
  loaded: false,
  canvasId: null,
  reviews: [],
  annotations: [],
  composer: null,
  focus: null,
  focusChain: [],
  focusChainIndex: 0,
  marqueeArmed: false,
  editingAnnotationId: null,
  resolution: null,
  panelHighlight: null,
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
  /**
   * Put back a focus that was PERSISTED with a composer draft (W14).
   *
   * Distinct from `lockFocus` and `setRegionFocus`, which mint a focus from a
   * fresh page interaction — this one restores an object main already holds, so
   * a half-written note that was aimed at a button is still aimed at it after a
   * pane switch. There is no expand ladder to restore: the chain is a live
   * artefact of the click, and the parent button simply stays hidden until the
   * user targets something again.
   */
  restoreFocus: (sessionId: string, focus: FocusObject) => void
  setRegionFocus: (sessionId: string, bboxPage: Rect, versionId: string) => void
  /** Re-point the LIVE locked focus after a layout change (#368): applied only
   *  while `forFocus` is still the focus, by reference — see the action. */
  updateFocusBox: (sessionId: string, forFocus: FocusObject, bboxPage: Rect) => void
  setMarqueeArmed: (sessionId: string, armed: boolean) => void
  setEditingAnnotation: (sessionId: string, annotationId: string | null) => void
  setResolution: (sessionId: string, pass: ResolutionPass | null) => void
  setPanelHighlight: (sessionId: string, highlight: CanvasReviewSessionState['panelHighlight']) => void
  upsertNote: (sessionId: string, draft: CanvasAnnotationDraft) => Promise<string | null>
  deleteNote: (sessionId: string, annotationId: string) => Promise<void>
  /**
   * The decision is REQUIRED: notes have no verdicts of their own any more, so
   * the submit IS the user's word on the version.
   *
   * `trail` is the WHOLE run's action trail (M3, Testing mode) — the per-note
   * slices are already locked to their notes, and this is the continuous record
   * the agent reads once at the top of the round. Optional because only Testing
   * mode records one; main re-applies the cap.
   */
  submitReview: (
    sessionId: string,
    reviewId: string,
    sketches: CanvasSketchExport[],
    decision: 'approve' | 'reject',
    trail?: TrailEntry[],
  ) => Promise<Review | null>
  /** Put a closed note back in play. Returns nothing to decide — the mirror
   *  main returns is the answer, as with every other mutation here. */
  reopenNote: (sessionId: string, annotationId: string) => Promise<void>
  /** Put a whole settled ROUND back in play. `canvasId` is the canvas the caller
   *  composed against; main refuses the write if the session has moved on, since
   *  review ids restart at R1 on every canvas. */
  reopenRound: (sessionId: string, canvasId: string, reviewId: string) => Promise<void>
  /**
   * Tell main the user has these addressed notes ON SCREEN.
   *
   * The release side of the agent's close-out barrier: until the user has seen
   * a note in its addressed state, `canvas_verdict` may not close it. Only the
   * panel calls this, and only after the rows have been visible long enough to
   * read — it is a report of what the user saw, so anything that would let it
   * fire without them looking makes it a lie.
   */
  markAddressedSeen: (sessionId: string, canvasId: string, annotationIds: string[]) => Promise<void>
  /**
   * Persist the half-written note (W14). Returns the composer main committed, so
   * the caller can flip its freshly-pasted images to "persisted" and stop
   * re-sending their bytes on the next keystroke.
   */
  saveComposerDraft: (sessionId: string, canvasId: string, draft: ComposerDraftInput) => Promise<ComposerDraft | null>
  /** Drop it — the round was submitted, or the draft belongs to an artefact the
   *  pane has left. */
  clearComposerDraft: (sessionId: string, canvasId: string) => Promise<void>
  reset: () => void
}

function fromMain(prev: CanvasReviewSessionState | undefined, state: CanvasReviewState | null): CanvasReviewSessionState {
  const base = prev ?? EMPTY
  if (!state) return { ...base, canvasId: null, reviews: [], annotations: [], composer: null, loaded: true }
  return {
    ...base,
    canvasId: state.canvasId,
    reviews: state.reviews,
    annotations: state.annotations,
    composer: state.composer ?? null,
    loaded: true,
  }
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

  restoreFocus: (sessionId, focus) => {
    set((s) => patch(s, sessionId, { focus, focusChain: [], focusChainIndex: 0, marqueeArmed: false }))
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

  updateFocusBox: (sessionId, forFocus, bboxPage) => {
    // Guarded by REFERENCE equality with the focus the box was resolved for:
    // a lock the user changed, expanded or cleared while the resolve was in
    // flight is a different claim and the stale answer is dropped, never
    // applied to it. Only the box moves — the identity (targets, label,
    // versionId) is the user's lock and stays theirs (#368, S3).
    set((s) => {
      const session = s.bySessionId[sessionId]
      if (!session || session.focus !== forFocus) return s
      return patch(s, sessionId, { focus: { ...forFocus, bboxPage } })
    })
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

  submitReview: async (sessionId, reviewId, sketches, decision, trail) => {
    try {
      const state = await window.electronAPI.canvas.reviewSubmit({
        sessionId,
        reviewId,
        sketches,
        decision,
        // Omitted rather than sent empty: a design or plan round has no trail,
        // and an empty array on the record would read as "we watched and they
        // did nothing".
        ...(trail && trail.length > 0 ? { trail } : {}),
      })
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

  reopenRound: async (sessionId, canvasId, reviewId) => {
    try {
      const state = await window.electronAPI.canvas.reviewReopen({ sessionId, canvasId, reviewId })
      set((s) => ({
        bySessionId: { ...s.bySessionId, [sessionId]: fromMain(s.bySessionId[sessionId], state) },
      }))
    } catch (err) {
      console.error('[canvasReviewStore] reopenRound failed:', err)
    }
  },

  reopenNote: async (sessionId, annotationId) => {
    try {
      const state = await window.electronAPI.canvas.annotationReopen({ sessionId, annotationId })
      set((s) => ({
        bySessionId: { ...s.bySessionId, [sessionId]: fromMain(s.bySessionId[sessionId], state) },
      }))
    } catch (err) {
      console.error('[canvasReviewStore] reopenNote failed:', err)
    }
  },

  markAddressedSeen: async (sessionId, canvasId, annotationIds) => {
    if (annotationIds.length === 0) return
    try {
      const { state, seen } = await window.electronAPI.canvas.reviewMarkSeen({ sessionId, canvasId, annotationIds })
      // Nothing moved (already seen, or the canvas changed under the report) —
      // don't touch the mirror, so a steady-state panel cannot loop.
      if (seen.length === 0) return
      set((s) => ({
        bySessionId: { ...s.bySessionId, [sessionId]: fromMain(s.bySessionId[sessionId], state) },
      }))
    } catch (err) {
      // A refused report is not a user-visible failure: the barrier simply
      // stays closed, and the user closes the round from the panel instead.
      console.error('[canvasReviewStore] markAddressedSeen failed:', err)
    }
  },

  saveComposerDraft: async (sessionId, canvasId, draft) => {
    try {
      const state = await window.electronAPI.canvas.composerDraftSet({ sessionId, canvasId, draft })
      set((s) => ({
        bySessionId: { ...s.bySessionId, [sessionId]: fromMain(s.bySessionId[sessionId], state) },
      }))
      return state.composer ?? null
    } catch (err) {
      // A refused save is not a user-visible failure — the words are still on
      // screen, and the next keystroke tries again. Losing them silently is what
      // this whole path exists to stop; losing the SAVE is survivable.
      console.error('[canvasReviewStore] saveComposerDraft failed:', err)
      return null
    }
  },

  clearComposerDraft: async (sessionId, canvasId) => {
    try {
      const state = await window.electronAPI.canvas.composerDraftClear({ sessionId, canvasId })
      set((s) => ({
        bySessionId: { ...s.bySessionId, [sessionId]: fromMain(s.bySessionId[sessionId], state) },
      }))
    } catch (err) {
      console.error('[canvasReviewStore] clearComposerDraft failed:', err)
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
    // The cross-canvas total (Canvas button pill) counts every canvas the
    // session owns; any review mutation can move it.
    useCanvasTotalsStore.getState().scheduleRefresh(event.sessionId)
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
   *  'addressed' (it has, and the verdict is yours). Closed and superseded
   *  notes are done and live in `closedNotes` instead. */
  notes: Annotation[]
  /**
   * Notes nobody is waiting on any more: observations you filed with an
   * approval, and notes settled by a later decision, a supersede, or the agent
   * on your word.
   *
   * Kept and shown rather than dropped, because settling CLEARS a note and never
   * deletes it: the text stays, the row says how it settled, and Reopen is one
   * click. A bulk action you cannot see the results of, and cannot undo, is not
   * one anybody should be asked to click.
   *
   * 'reannotated' is excluded — that note has a live successor carrying the
   * same issue, so listing it here would show the same feedback twice.
   */
  closedNotes: Annotation[]
  /**
   * 'agent' while the round is LIVE — the version is with them, and your next
   * decision on it is what ends the round. 'closed' when it is settled.
   *
   * There is deliberately no 'you'. Notes have no verdicts of their own any
   * more, so a round can never be waiting on the user: what waits on you is the
   * VERSION, and the pane's decision bar is where that lives.
   */
  waitingOn: 'agent' | 'closed'
  openCount: number
  addressedCount: number
  /** Of `closedNotes`, how many the AGENT closed on your instruction. Drives
   *  the one line that tells you this round was cleared on your word rather
   *  than by your own click. */
  agentClosedCount: number
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
  const closedByReview = new Map<string, Annotation[]>()
  for (const a of state.annotations) {
    const bucket = isLiveNote(a) ? byReview : isSettledNote(a) ? closedByReview : null
    if (!bucket) continue
    const list = bucket.get(a.reviewId)
    if (list) list.push(a)
    else bucket.set(a.reviewId, [a])
  }
  return state.reviews
    .filter((r) => r.status !== 'draft')
    .map((review) => {
      const notes = byReview.get(review.id) ?? []
      const closedNotes = closedByReview.get(review.id) ?? []
      const openCount = notes.filter((n) => n.state === 'open').length
      const addressedCount = notes.length - openCount
      // Read from the ROUND's status, not re-derived from its notes. The status
      // is one-way now (only the user's own Reopen walks it back), so it is the
      // authority — and deriving it here as well is how the panel and the pill
      // came to give two answers to one question.
      const waitingOn: ReviewGroup['waitingOn'] = review.status === 'submitted' ? 'agent' : 'closed'
      // The "N on your instruction — not approved" chip. A chat PICK is
      // closedBy 'agent' too, but it IS an approval the user made (in chat), so
      // it does not belong in a "not approved" count — it carries its own
      // "picked in chat" provenance on the row instead.
      const agentClosedCount = closedNotes.filter((n) => n.closedBy === 'agent' && n.pickSource !== 'chat').length
      return { review, notes, closedNotes, waitingOn, openCount, addressedCount, agentClosedCount }
    })
    .sort((a, b) => {
      const at = Date.parse(a.review.submittedAt ?? a.review.createdAt)
      const bt = Date.parse(b.review.submittedAt ?? b.review.createdAt)
      if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at
      return reviewOrdinal(b.review) - reviewOrdinal(a.review)
    })
}

/** LIVE notes on LIVE rounds — what the resolution checklist re-anchors, oldest
 *  round first so the list reads in the order it was given. 'addressed' is
 *  included: the agent says it acted, and the note stays on screen so the user
 *  can see the claim before they decide on the next version. It is NOT a
 *  to-do list for them — nothing on this panel is. */
export function openSubmittedNotesOf(state: CanvasReviewSessionState): Annotation[] {
  const submitted = new Set(state.reviews.filter((r) => r.status === 'submitted').map((r) => r.id))
  return state.annotations.filter((a) => submitted.has(a.reviewId) && (a.state === 'open' || a.state === 'addressed'))
}

/**
 * The phase of the artefact the pane is DISPLAYING — needs-you, with-agent,
 * settled, or empty.
 *
 * A pure wrapper over the shared `artifactPhaseOf`, and it exists so the
 * renderer and main compute this from ONE implementation. Main joins the same
 * helper onto every Library row (`CanvasLibraryEntry.phase`); the pane reads it
 * live from its own mirror. Two implementations of "who is this waiting on" is
 * exactly how the pill and the panel came to disagree, which is the class of
 * bug the settled machine exists to end.
 *
 * `displayedVersionId` picks the RUN, because a canvas holds several artefacts
 * and the pane shows one at a time — the newest run is not necessarily the one
 * on screen.
 */
export function artifactPhaseFor(
  state: CanvasReviewSessionState | undefined,
  canvasVersions: readonly CanvasVersion[],
  displayedVersionId: string | null,
): ArtifactPhase {
  const run = displayedVersionId ? artifactRunContaining(canvasVersions, displayedVersionId) : null
  if (!run) return { kind: 'empty' }
  return artifactPhaseOf(run, state?.reviews ?? [], state?.annotations ?? [])
}

/**
 * How a settled round settled, in the user's own terms.
 *
 * The row has to say WHY, or a round the user never closed themselves reads as
 * one they did — the whole reason `Review.settled` is stored beside the status.
 * Every value here is derived from store-minted provenance; nothing is guessed.
 */
export function settledLabel(group: ReviewGroup, versions: readonly CanvasVersion[] = []): string | null {
  const settled = group.review.settled
  if (!settled) return null
  switch (settled.by) {
    case 'observation':
      // The user's own two words for the same gesture. Testing mode calls the
      // decision Pass, everything else calls it Approve, and a History row that
      // said "passed" about a mockup the user APPROVED reads as a different
      // event. The word comes from the version the round froze against.
      return versions.find((v) => v.id === group.review.versionId)?.mode === 'uat'
        ? 'passed with observations'
        : 'approved with observations'
    case 'decision': {
      // A decision that carried a ROUND of its own is named by that round —
      // "superseded by your Review #8" is what the user can go and re-read.
      if (settled.reviewId) return `superseded by your ${settled.reviewId.replace('R', 'Review #')}`
      // A bare version verdict (the zero-note approve/reject) has no round to
      // name, so it names the version AND WHAT THE USER SAID: "settled by your
      // v8 approval" is a sentence they recognise; "settled by your v8
      // decision" makes them go and look up which way it went. The word comes
      // from the version record — falling back to the neutral one only when the
      // version is not in the list we were handed.
      const verdict = versions.find((v) => v.id === settled.versionId)?.verdict?.state
      const word = verdict === 'approved' ? 'approval' : verdict === 'rejected' ? 'rejection' : 'decision'
      return `settled by your ${settled.versionId ?? 'later'} ${word}`
    }
    case 'agent':
      return 'closed by the agent on your instruction'
    case 'supersede':
      return 'settled when its version was superseded'
    case 'force':
      return 'closed by you, as not done'
    case 'legacy':
      return 'settled when this canvas was brought up to date'
  }
}
