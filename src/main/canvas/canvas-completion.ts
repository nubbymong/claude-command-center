import {
  forceClosuresOf,
  forceCloseCanvasReviews,
  getReviewCountsForCanvas,
  reviewStoreFileExists,
} from './canvas-review-store'
import { getCanvasStateById, reopenCompletedCanvas, setCanvasCompleted, setVersionVerdict } from './canvas-store'
import { logInfo } from '../debug-logger'
import {
  artifactRuns,
  openVersionOf,
  type CanvasCompletion,
  type CanvasState,
  type CanvasVersion,
  type ForceClosures,
} from '../../shared/canvas'

/**
 * The guarded sign-off (#476): the ONE way a canvas becomes COMPLETE, for both
 * ingresses — the user's pane button (IPC) and the agent's `canvas_complete`
 * MCP tool. It composes the two stores because neither may import the other in
 * this direction: the review store already imports the canvas store, and the
 * completion rule needs both.
 *
 * WHAT IS OWED, under the settled machine (2026-08-29):
 *   - unsubmitted DRAFT notes — a review half-written is not a finished cycle;
 *   - LIVE ROUNDS — a submitted round that no decision has settled. Note that
 *     "the agent addressed it" is no longer an exit: addressed is the agent's
 *     claim about its own work, not a debt the user discharges, so a round of
 *     addressed notes is still owed until a decision ends it;
 *   - OPEN VERSIONS — any artefact run on this canvas whose latest ready
 *     version has no verdict. Every run, not just the awaited one: a plan left
 *     open beside an approved mockup is a decision the user still owes, and
 *     signing off over it strands the plan for good (the canvas is terminal
 *     afterwards, so `setVersionVerdict` refuses).
 * All of it is read from the same tallies the queue and the pane derive from,
 * so the button, the pill and this refusal cannot disagree.
 *
 * HOW THOSE TERMS ARE DISCHARGED, and why the guard can trust each:
 *   - the USER's own decision on a version (pane submit or zero-note verdict),
 *     which also settles every earlier round of that artefact;
 *   - the USER's FORCE (`opts.force`, `by: 'user'` only) — Mark complete, which
 *     names each closure before they commit and records every one as `stale`
 *     by the user, never as approved;
 *   - the AGENT closing a round on the user's word (`canvas_verdict`,
 *     `canvas_pick`), behind the seen barrier the review store enforces;
 *   - the store's own supersede settle, which keeps that same seen barrier.
 *
 * The one agent write with NO mechanical barrier is the chat-recorded VERSION
 * verdict (`canvas_version_verdict`, `by: 'agent-chat'`), which clears
 * `awaitingReview`. So an AGENT completion may not rest on the agent's own
 * chat-relayed sign-off — see the `agent-chat` guard below. A user pane
 * completion is unaffected: a person clicking Mark complete is themselves the
 * review.
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
  /**
   * W3 — the user force-closing what is still owed, so Mark complete is never
   * dead. Honoured ONLY for `by === 'user'`: `canvas_complete` (the agent's
   * mouth) keeps every refusal it has, because the whole point of those
   * refusals is that an agent may not clear the user's feedback for them.
   */
  opts?: { force?: true },
): CanvasState | { error: string } {
  const canvas = getCanvasStateById(canvasId)
  if (!canvas) return { error: 'no such canvas' }
  const force = opts?.force === true && by === 'user'
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
  // THE FORCE, before the owed checks — it is what makes them pass. Everything
  // it does is a USER gesture the confirm has already named: unsent drafts are
  // deleted, live notes are closed as `stale` by the user, their rounds settle
  // `by: 'force'`, and EVERY artefact's open version is stamped `dismissed`
  // (the honest word: closed without being looked at, not approved).
  //
  // The ownership re-check happens FIRST, and that ordering is the point: the
  // closures are durable, the stamp is not guaranteed, and a completion refused
  // at the stamp must not leave the user's notes closed behind it. Everything
  // `setCanvasCompleted` can refuse for that this function can know in advance
  // is asserted here, before anything is written. Failures inside the closures
  // are logged and fall through to the ordinary refusals rather than throwing —
  // a force that could not clear something must still refuse, not half-complete.
  if (force) {
    const owner = getCanvasStateById(canvasId)
    if (!owner) return { error: 'no such canvas' }
    if (requireOwnerSessionId !== undefined && owner.sessionId !== requireOwnerSessionId) {
      return { error: 'not this session’s canvas' }
    }
    try {
      forceCloseCanvasReviews(canvasId)
    } catch (err) {
      logInfo(`[canvas-completion] force close failed for ${canvasId}: ${err}`)
    }
    for (const versionId of openVersionIdsOf(canvas.versions)) {
      const ruled = setVersionVerdict(canvas.sessionId, versionId, { state: 'dismissed', note: 'closed unreviewed' }, 'user')
      if ('error' in ruled) logInfo(`[canvas-completion] force dismiss skipped for ${versionId}: ${ruled.error}`)
    }
  }
  // A ready-marked render nobody has reviewed yet IS something owed — the
  // user's first look. Without this, an agent could sign off a canvas whose
  // hand-over the user never saw, which breaks the transitive-seen argument
  // below. (The renderer's blocked-button predicate includes the same term.)
  const afterForce = getCanvasStateById(canvasId)
  if (afterForce?.awaitingReview) {
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
    // Show versions are skipped: a show-and-tell render after an agent-chat
    // sign-off must not become the "latest ready" this guard inspects — that
    // would launder the self-approve→self-complete bypass this guard exists
    // to close (independent review of the show lane, 2026-08-27). A canvas
    // whose ready versions are ALL show yields undefined here, which is the
    // show-only case: nothing was ever review-owed, and completion proceeds.
    const latestReady = [...canvas.versions].reverse().find((v) => !v.draft && !v.show)
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
    if (counts.addressedNotes > 0) owed.push(`${counts.addressedNotes} note${counts.addressedNotes === 1 ? '' : 's'} the agent has answered`)
    if (owed.length === 0 && counts.liveRounds > 0) {
      owed.push(`${counts.liveRounds} round${counts.liveRounds === 1 ? '' : 's'} still open`)
    }
    if (owed.length > 0) {
      return { error: `not everything is settled: ${owed.join(', ')}` }
    }
  }
  // AN OPEN VERSION ANYWHERE IS OWED, not just the awaited one. `awaitingReview`
  // names at most one version and is cleared by a decision on it — so a canvas
  // holding a plan left open beside an approved mockup passed every check above
  // and signed off, stranding the plan permanently (a completed canvas refuses
  // every verdict). Named individually, so the refusal says which one to go and
  // decide.
  //
  // LAST of the owed checks, deliberately: the notes are the sharper loss and
  // should be named first when both are outstanding, and an open version is the
  // one term the force can discharge on its own.
  const versionsNow = afterForce?.versions ?? canvas.versions
  const stillOpen = openVersionIdsOf(versionsNow)
  if (stillOpen.length > 0) {
    const named = stillOpen.map((id) => describeOpenVersion(versionsNow, id)).join(', ')
    return { error: `not everything is settled: ${named} still open for review` }
  }
  return setCanvasCompleted(canvasId, by, requireOwnerSessionId)
}

/**
 * EVERY artefact run's open version — the decisions the user still owes on this
 * canvas, and what a force stamps `dismissed`.
 *
 * Archived runs are skipped: the user has already tucked those away, and
 * `artifactRuns` breaks a run on the archive flip, so an archived run is a
 * separate one that nothing is waiting on.
 */
function openVersionIdsOf(versions: readonly CanvasVersion[]): string[] {
  const out: string[] = []
  for (const run of artifactRuns(versions)) {
    if (run[0]?.archived) continue
    const open = openVersionOf(run)
    if (open) out.push(open.id)
  }
  return out
}

/** "v1 (plan)" — the version, and what kind of thing it is, so a refusal over a
 *  canvas holding several artefacts says WHICH one to go and decide. */
function describeOpenVersion(versions: readonly CanvasVersion[], versionId: string): string {
  const mode = versions.find((v) => v.id === versionId)?.mode
  return mode ? `${versionId} (${mode})` : versionId
}

/**
 * Exactly what a force complete would close on this canvas, so the renderer's
 * armed confirm can NAME it ("Mark complete — closes 1 note still with the
 * agent, as not done") rather than asking the user to confirm an unknown.
 *
 * Composes the two stores for the same reason the guard does: the notes live in
 * one and the open versions in the other. Null for an unreadable review store —
 * a confirm that cannot say what it will do must not be offered — and null for
 * a FOREIGN session: these tallies are the canvas's private review state, and a
 * read that answers them to anybody is an oracle for exactly what
 * `completeCanvasGuarded` refuses to act on. Ownership is checked FIRST, before
 * any tally is read, for the same reason it is there.
 */
export function describeForceClosures(canvasId: string, requireOwnerSessionId?: string): ForceClosures | null {
  const canvas = getCanvasStateById(canvasId)
  if (!canvas) return null
  if (requireOwnerSessionId !== undefined && canvas.sessionId !== requireOwnerSessionId) return null
  const notes = forceClosuresOf(canvasId)
  // No reviews.json at all is a healthy, never-annotated canvas: nothing owed
  // on the note side. A store that EXISTS and will not read is the null case.
  if (!notes && reviewStoreFileExists(canvasId)) return null
  return {
    unsentNotes: notes?.unsentNotes ?? 0,
    openNotes: notes?.openNotes ?? 0,
    addressedNotes: notes?.addressedNotes ?? 0,
    unreviewedVersionIds: openVersionIdsOf(canvas.versions),
  }
}

/** Reopen is unguarded by design — it only ever RESTORES obligations. */
export function reopenCanvasGuarded(canvasId: string, requireOwnerSessionId?: string): CanvasState | { error: string } {
  return reopenCompletedCanvas(canvasId, requireOwnerSessionId)
}
