import {
  getReviewCountsForCanvas,
  reviewStoreFileExists,
} from './canvas-review-store'
import { getCanvasStateById, reopenCompletedCanvas, setCanvasCompleted } from './canvas-store'
import type { CanvasCompletion, CanvasState } from '../../shared/canvas'

/**
 * The guarded sign-off (#476): the ONE way a canvas becomes COMPLETE, for both
 * ingresses — the user's pane button (IPC) and the agent's `canvas_complete`
 * MCP tool. It composes the two stores because neither may import the other in
 * this direction: the review store already imports the canvas store, and the
 * completion rule needs both.
 *
 * The rule is "nothing left owed either way":
 *   - no unsubmitted draft notes (a review half-written is not a finished
 *     cycle),
 *   - no submitted round still holding an open note (work owed by the agent),
 *   - no addressed note awaiting a verdict (work owed by the user),
 * over the SAME tallies the queue and the close-out use, so the button, the
 * pill and this refusal can never disagree.
 *
 * Seen-ness is carried transitively rather than re-checked. A round leaves
 * those tallies through four exits: the user's own verdict (their click), the
 * #470 supersede sweep (gated on `isAgentCloseable`, i.e. the seen barrier),
 * an agent close-out the store refuses until the user has SEEN the round —
 * or a chat pick (`canvas_pick`), which deliberately has no seen barrier and
 * rests instead on its own contract: it records the user's explicit words in
 * chat, stamps `pickSource: 'chat'` provenance, and reopens in one click.
 * That last exit is the same honor-system tier as this tool itself (both are
 * "the user said so in chat"), so completion inherits it rather than
 * pretending a mechanical barrier covers it; the mechanical barriers cover
 * the other three.
 *
 * Fail-closed on an unreadable review store: a reviews.json that exists but
 * will not read refuses completion — "could not tell" must never sign off as
 * "nothing owed". A canvas with NO reviews.json at all is a healthy, never-
 * annotated one and may complete.
 */
export function completeCanvasGuarded(
  canvasId: string,
  by: CanvasCompletion['by'],
  requireOwnerSessionId?: string,
): CanvasState | { error: string } {
  // A ready-marked render nobody has reviewed yet IS something owed — the
  // user's first look. Without this, an agent could sign off a canvas whose
  // hand-over the user never saw, which breaks the transitive-seen argument
  // below. (The renderer's blocked-button predicate includes the same term.)
  const canvas = getCanvasStateById(canvasId)
  if (canvas?.awaitingReview) {
    return { error: 'not everything is settled: a render is still awaiting the user’s first review' }
  }
  const counts = getReviewCountsForCanvas(canvasId)
  if (!counts) {
    if (reviewStoreFileExists(canvasId)) {
      return { error: 'the review store for this canvas could not be read — refusing to sign off what cannot be checked' }
    }
    // No reviews.json: nothing was ever owed. Fall through to the stamp.
  } else {
    const owed: string[] = []
    if (counts.draftNotes > 0) owed.push(`${counts.draftNotes} unsubmitted note${counts.draftNotes === 1 ? '' : 's'}`)
    if (counts.openNotes > 0) owed.push(`${counts.openNotes} note${counts.openNotes === 1 ? '' : 's'} still with the agent`)
    if (counts.addressedNotes > 0) owed.push(`${counts.addressedNotes} note${counts.addressedNotes === 1 ? '' : 's'} awaiting your verdict`)
    if (owed.length > 0) {
      return { error: `not everything is settled: ${owed.join(', ')}` }
    }
  }
  return setCanvasCompleted(canvasId, by, requireOwnerSessionId)
}

/** Reopen is unguarded by design — it only ever RESTORES obligations. */
export function reopenCanvasGuarded(canvasId: string, requireOwnerSessionId?: string): CanvasState | { error: string } {
  return reopenCompletedCanvas(canvasId, requireOwnerSessionId)
}
