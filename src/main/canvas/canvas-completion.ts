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
 * Seen-ness is carried transitively rather than re-checked. Every exit from
 * those tallies is either a USER GESTURE — their own verdicts, the library
 * close-out, the dismiss-all sweep (which also clears the awaiting-review
 * term checked above) — or an agent write behind a mechanical barrier: the
 * #470 supersede sweep (gated on `isAgentCloseable`, i.e. the seen barrier)
 * and the close-out the store refuses until the user has SEEN the round.
 *
 * TWO agent writes have NO mechanical seen barrier and rest on the honor-
 * system contract (explicit user words in chat, chat provenance, one-click
 * reopen): the chat pick (`canvas_pick`) and — added with C1 — the chat-
 * recorded VERSION verdict (`canvas_version_verdict`), which clears
 * `awaitingReview`. For the pick that tier is fine because a pick cannot make
 * a canvas *look reviewed when it was not*. A version approval can: it clears
 * the awaiting-review barrier below. So an AGENT-driven completion may not
 * rest on the agent's OWN chat-recorded sign-off — see the `agent-chat` guard
 * below. The user's pane button (`by: 'user'`) is unaffected: a person
 * clicking Mark complete is themselves the review.
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
  const canvas = getCanvasStateById(canvasId)
  if (!canvas) return { error: 'no such canvas' }
  // OWNERSHIP FIRST (adversarial review): the tally reads below expose a
  // canvas's private review counts, so a foreign session must be turned away
  // before it can use this as an oracle — and the refusal should say the true
  // reason. setCanvasCompleted re-checks against the record as the boundary.
  if (requireOwnerSessionId !== undefined && canvas.sessionId !== requireOwnerSessionId) {
    return { error: 'not this session’s canvas' }
  }
  if (canvas.completed) return { error: 'already completed' }
  // NOTHING TO SIGN OFF unless the user has actually been shown something.
  // A canvas whose only versions are DRAFTS (ready:false) has surfaced
  // nothing — no pulse, no queue, no review store — so "nothing is owed" is
  // true only because nothing was ever offered. A draft as the LATEST version
  // is agent work-in-flight the user has not seen. Either way there is no
  // signed-off state to record. This is the barrier the draft path slips past
  // (awaitingReview is set only for a NON-draft render), so it is checked
  // directly on the versions rather than on the review-needed stamp.
  const hasReadyVersion = canvas.versions.some((v) => !v.draft)
  const latest = canvas.versions[canvas.versions.length - 1]
  if (!hasReadyVersion || latest?.draft) {
    return { error: 'not everything is settled: nothing has been offered for review yet — render a version the user can see first' }
  }
  // A ready-marked render nobody has reviewed yet IS something owed — the
  // user's first look. Without this, an agent could sign off a canvas whose
  // hand-over the user never saw, which breaks the transitive-seen argument
  // below. (The renderer's blocked-button predicate includes the same term.)
  if (canvas.awaitingReview) {
    return { error: 'not everything is settled: a render is still awaiting the user’s first review' }
  }
  // The C1 completion guard (adversarial round 2, MEDIUM): a chat-recorded
  // version verdict (`canvas_version_verdict`, stamped by:'agent-chat') clears
  // awaitingReview above — so without this an agent could render, self-record
  // "approved", and sign off, all with zero user gestures. An AGENT completion
  // may not rest on the agent's own chat-relayed approval: if the latest ready
  // version's sign-off is agent-chat, the canvas is treated as still awaiting
  // the user for the purpose of AGENT completion. A user pane completion
  // (by:'user') is the user reviewing it themselves and is never blocked here.
  if (by === 'agent') {
    const latestReady = [...canvas.versions].reverse().find((v) => !v.draft)
    if (latestReady?.verdict?.by === 'agent-chat') {
      return { error: 'not everything is settled: this version’s sign-off was recorded from chat — the user completes it from the Canvas pane' }
    }
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
