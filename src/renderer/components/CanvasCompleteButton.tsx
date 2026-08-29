import React, { useCallback, useEffect, useState } from 'react'
import { useArmedConfirm } from '../hooks/useArmedConfirm'
import { useCanvasStore } from '../stores/canvasStore'
import {
  draftAnnotationsOf,
  reviewGroupsOf,
  useCanvasReviewStore,
} from '../stores/canvasReviewStore'
import { artifactRunContaining, openVersionOf, type ForceClosures } from '../../shared/canvas'

interface Props {
  sessionId: string
  canvasId: string
  /** Named on the confirm, so the second click says WHAT it signs off. */
  title?: string
  /**
   * The version the pane is SHOWING. A canvas holds several artefacts and the
   * pane shows one at a time, so "is there an open version" has to be asked of
   * the run on screen — asking it of the canvas's latest version hides the
   * button while the user is looking at a settled mockup because some other
   * artefact is mid-flight, and shows it while they are looking at the very
   * version they are supposed to decide on.
   */
  displayedVersionId?: string | null
}

/**
 * The subject-level sign-off (#476), in the pane header's leave cluster.
 *
 * MARK COMPLETE IS NEVER DEAD (W3). The old button went dark the moment
 * anything was owed, which left the canvas with no exit at all: the agent's
 * `canvas_complete` refuses while notes are outstanding (correctly, and still
 * does), and the user's only control was disabled. A note the agent shipped in
 * code and never resolved stranded a whole subject that way.
 *
 * So it is HIDDEN or ENABLED, never disabled:
 *  - HIDDEN while the displayed artefact's latest ready version is still OPEN
 *    (no verdict), because the thing to do then is DECIDE — approve or reject in
 *    the panel — and an approval auto-completes anyway. Hidden too once the
 *    canvas is completed (the Completed chip takes the slot).
 *  - ENABLED otherwise. The armed confirm NAMES what it will force-close, read
 *    from main (`describeForceClosures`) so the label and the effect are drawn
 *    from one read; the confirm then calls `canvas:completeForce` when something
 *    is owed and the plain `canvas:complete` when nothing is.
 *
 * Force is USER-only end to end: main honours it only for `by: 'user'`, and no
 * MCP path reaches the channel.
 */
export default function CanvasCompleteButton({ sessionId, canvasId, title, displayedVersionId }: Props) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  /**
   * Main's answer, and whether it has answered at all — two different facts,
   * kept apart.
   *
   * `null` after a describe is main saying "I cannot tell you" (an unreadable
   * store, a canvas it will not describe), which is a reason to FORCE. `null`
   * before one is simply "not asked yet", and a confirm that cannot say what it
   * is about to do is not something the user can meaningfully agree to — so it
   * stays disabled until the answer lands. Collapsing the two makes the button
   * either dead or reckless, depending which way you collapse them.
   */
  const [closures, setClosures] = useState<ForceClosures | null>(null)
  const [described, setDescribed] = useState(false)
  // Key the guard on the CANVAS, not a bare literal (adversarial review): the
  // pane switches subject under a mounted button (picker / library / a filing),
  // and a stale `armed` from canvas A must not sign off canvas B.
  const confirm = useArmedConfirm(armed ? `complete:${canvasId}` : null)

  const completed = useCanvasStore((s) => s.bySessionId[sessionId]?.completed)
  const awaitingReview = useCanvasStore((s) => !!s.bySessionId[sessionId]?.awaitingReview)
  const review = useCanvasReviewStore((s) => s.bySessionId[sessionId])

  // Disarm the moment the subject changes under us — so does the refusal.
  // Also when the canvas flips to completed under a mounted button (a sign-off
  // landing, or a reopen→complete round trip): a stale `armed` must not carry
  // into the chip and back out ready to fire (adversarial review round 2).
  useEffect(() => {
    setArmed(false)
    setRefused(null)
    // The described closures belong to the canvas they were read for. Carrying
    // them across a subject switch would put the PREVIOUS canvas's phrases on
    // this one's confirm — the exact class of lie the describe exists to stop.
    setClosures(null)
    setDescribed(false)
  }, [canvasId, completed])

  // What is outstanding, for the CONFIRM's wording only — never for whether the
  // button exists. Fail CLOSED when the review mirror is missing or points at a
  // DIFFERENT canvas (the window right after a subject switch): "unknown" is not
  // "nothing owed", so the confirm says it is forcing rather than promising a
  // clean sign-off it cannot vouch for. Main re-checks regardless.
  const mirrorReady = !!review && review.canvasId === canvasId
  const groups = mirrorReady ? reviewGroupsOf(review) : []
  const draftCount = mirrorReady ? draftAnnotationsOf(review).length : 0
  const openRounds = groups.filter((g) => g.waitingOn !== 'closed').length
  const owed = !mirrorReady || openRounds > 0 || draftCount > 0 || awaitingReview

  // HIDDEN while the DISPLAYED artefact's latest ready version is still OPEN.
  // The gesture that belongs to that state is the DECISION — approve or reject
  // — and an approval completes the canvas by itself when nothing else is owed.
  // Offering Mark complete beside it is offering two ways to end the same thing,
  // one of which skips the user's own verdict.
  //
  // Scoped to the run ON SCREEN, not the canvas: those are different questions
  // whenever a canvas holds more than one artefact.
  const versions = useCanvasStore((s) => s.bySessionId[sessionId]?.versions)
  const readyVersions = (versions ?? []).filter((v) => !v.draft)
  const displayedRun = displayedVersionId ? artifactRunContaining(versions ?? [], displayedVersionId) : null
  const hasOpenVersion = openVersionOf(displayedRun ?? versions ?? []) !== null

  // SHOW-AND-TELL (owner call, 2026-08-27): a canvas whose ready versions are
  // all show versions and which has never grown a review is a look, not a
  // review cycle — closing it deserves one click, not the armed sign-off
  // ceremony. Main runs the same completion guard either way; this only picks
  // the lighter presentation.
  const showOnly =
    !owed &&
    groups.length === 0 &&
    readyVersions.length > 0 &&
    readyVersions.every((v) => v.show === true)

  /**
   * What the force WOULD close, read from main when the button arms.
   *
   * Read rather than derived: the unsent drafts and the unreviewed version live
   * in two stores, and only main holds both — a renderer-side guess is how a
   * confirm comes to promise something the mutation does not do.
   */
  const describe = useCallback(async () => {
    try {
      const res = await window.electronAPI.canvas.describeForceClosures({ sessionId, canvasId })
      setClosures(res ?? null)
    } catch {
      setClosures(null)
    } finally {
      setDescribed(true)
    }
  }, [sessionId, canvasId])

  const [reopening, setReopening] = useState(false)
  const doReopen = async () => {
    if (reopening) return
    setReopening(true)
    try {
      const res = await window.electronAPI.canvas.completeReopen({ sessionId, canvasId })
      // A refusal (ownership) or a rejection (bad payload) must not be a silent
      // dead click — surface it where the other two Reopen call sites do. But
      // "not completed" means the canvas is ALREADY reopened (a double-fire, or
      // the push already cleared the stamp), which is success, not an error
      // (adversarial review round 2) — so don't show it.
      if (!res?.ok && res?.reason !== 'not completed') setRefused(res?.reason ?? 'could not reopen')
    } catch {
      setRefused('could not reopen')
    } finally {
      setReopening(false)
    }
  }

  if (completed) {
    return (
      <>
        {refused && (
          <span
            className="shrink-0 text-[10px] max-w-[220px] truncate"
            style={{ color: 'var(--status-danger)' }}
            data-testid="canvas-complete-refused"
            title={refused}
          >
            {refused}
          </span>
        )}
        <span
          className="shrink-0 flex items-center gap-1.5 text-[11px] font-semibold rounded-full px-2 py-0.5"
          style={{
            color: 'var(--status-success)',
            background: 'color-mix(in srgb, var(--status-success) 12%, transparent)',
            border: '1px solid color-mix(in srgb, var(--status-success) 40%, transparent)',
          }}
          data-testid="canvas-completed-chip"
          title={`Signed off ${completed.by === 'agent' ? 'by the agent on your instruction' : 'by you'}. Reopen puts it back in play.`}
        >
          ✓ Completed
          <button
            onClick={() => void doReopen()}
            disabled={reopening}
            className="underline underline-offset-2 font-normal focus-ring rounded disabled:opacity-40"
            style={{ color: 'var(--brand)' }}
            data-testid="canvas-completed-reopen"
            title="Put this canvas back in play"
          >
            Reopen
          </button>
        </span>
      </>
    )
  }

  const doComplete = async (force: boolean) => {
    if (busy) return
    setBusy(true)
    try {
      // FORCE only when something is owed. The plain path keeps its full guard,
      // so a canvas with nothing outstanding is signed off by the same code it
      // always was, and the force is reserved for the case it exists for.
      const res = force
        ? await window.electronAPI.canvas.completeForce({ sessionId, canvasId })
        : await window.electronAPI.canvas.complete({ sessionId, canvasId })
      if (!res.ok) {
        // Main refused (ownership, or nothing was ever offered for review) —
        // say why in place and disarm.
        setRefused(res.reason ?? 'could not complete')
        setArmed(false)
      }
      // On success the change push detaches the canvas and the pane falls
      // back to its front page — nothing to do here.
    } catch {
      setRefused('could not complete')
      setArmed(false)
    } finally {
      setBusy(false)
    }
  }

  /**
   * The armed label, naming every closure — "Mark complete — closes 1 note still
   * with the agent, as not done".
   *
   * "as not done" is the load-bearing half: force closes things, it does not
   * approve them, and a confirm that said "closes 1 note" would let the user
   * believe the opposite of what the record will say.
   */
  const forcePhrases: string[] = []
  if (closures) {
    if (closures.unsentNotes > 0) forcePhrases.push(`deletes ${closures.unsentNotes} unsent note${closures.unsentNotes === 1 ? '' : 's'}`)
    if (closures.openNotes > 0) forcePhrases.push(`closes ${closures.openNotes} note${closures.openNotes === 1 ? '' : 's'} still with the agent, as not done`)
    if (closures.addressedNotes > 0) forcePhrases.push(`closes ${closures.addressedNotes} note${closures.addressedNotes === 1 ? '' : 's'} the agent answered, as not done`)
    const unreviewed = closures.unreviewedVersionIds ?? []
    if (unreviewed.length > 0) forcePhrases.push(`closes ${unreviewed.join(', ')} unreviewed`)
  }
  /**
   * FORCE when EITHER side says something is outstanding.
   *
   * `closures` is main's answer and the phrases come from it; `owed` is the
   * renderer's own mirror. They can disagree in exactly one direction that
   * matters: main returns null (unreadable store, or a canvas it will not
   * describe) and the phrase list is empty while work plainly remains. Taking
   * the plain path there sends the sign-off through a guard that will refuse
   * it, which reads to the user as a dead button — the thing this whole control
   * exists not to be. So an empty describe over an owed mirror still forces,
   * and main re-checks either way.
   */
  const forcing = owed || closures === null || forcePhrases.length > 0
  // "Mark complete" either way — the arm and the confirm say the same words, so
  // the second click is plainly the same action as the first rather than a new
  // one the user has to re-read. What the confirm ADDS is the consequence; the
  // subject's name rides the tooltip, where it is available without competing
  // with the closures for the label's width.
  const confirmLabel = forcePhrases.length > 0
    ? `Mark complete — ${forcePhrases.join('; ')}`
    : forcing
      ? 'Mark complete — closes whatever is still outstanding, as not done'
      : 'Mark complete'
  // Until main has answered, the confirm cannot say what it will do — so it is
  // not offered as something to agree to.
  const describePending = !described

  // Completed canvases and open versions both take the slot away entirely.
  if (hasOpenVersion) return null

  return (
    <>
      {refused && (
        <span
          className="shrink-0 text-[10px] max-w-[220px] truncate"
          style={{ color: 'var(--status-danger)' }}
          data-testid="canvas-complete-refused"
          title={refused}
        >
          {refused}
        </span>
      )}
      {showOnly ? (
        <button
          onClick={() => {
            setRefused(null)
            void doComplete(false)
          }}
          disabled={busy}
          className="shrink-0 flex items-center gap-1.5 text-[11.5px] rounded px-2 py-0.5 focus-ring disabled:opacity-40"
          style={{
            color: 'var(--text-muted)',
            background: 'color-mix(in srgb, var(--text-muted) 8%, transparent)',
            border: '1px solid var(--border-subtle)',
          }}
          data-testid="canvas-dismiss-button"
          title="This was a show-and-tell — nothing is owed. Dismiss files it; find it again in the Library."
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden>
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
          Dismiss
        </button>
      ) : armed ? (
        <>
          <button
            onClick={() => setArmed(false)}
            className="shrink-0 text-[11px] rounded px-1.5 py-0.5 border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-ring"
          >
            Cancel
          </button>
          <button
            ref={confirm.confirmRef}
            onClick={confirm.guarded(() => void doComplete(forcing))}
            disabled={busy || describePending}
            className="shrink-0 flex items-center gap-1.5 text-[11.5px] font-semibold rounded px-2 py-0.5 focus-ring disabled:opacity-40 max-w-[420px] truncate"
            style={{
              // Text-on-bright-fill uses --surface-chrome, the header's own
              // convention — --color-crust fails 4.5:1 on the light theme's
              // success green. A FORCE wears the warning colour instead: it is
              // closing work nobody finished, and it must not look like a
              // clean sign-off.
              color: 'var(--surface-chrome)',
              background: forcing ? 'var(--status-warning)' : 'var(--status-success)',
              border: `1px solid color-mix(in srgb, ${forcing ? 'var(--status-warning)' : 'var(--status-success)'} 55%, transparent)`,
            }}
            data-testid="canvas-complete-confirm"
            title={
              forcing
                ? `Closes what is still outstanding on${title ? ` “${title}”` : ' this canvas'} as NOT DONE, then signs the subject off. Nothing is deleted except your own unsent notes, and every closure can be reopened from the Library.`
                : `Signs${title ? ` “${title}”` : ' this canvas'} off. The pane returns to the front page; the canvas stays in the Library, reopenable in one click.`
            }
          >
            {confirmLabel}
          </button>
        </>
      ) : (
        <button
          onClick={() => {
            setRefused(null)
            void describe()
            setArmed(true)
          }}
          disabled={busy}
          className="shrink-0 flex items-center gap-1.5 text-[11.5px] rounded px-2 py-0.5 focus-ring disabled:opacity-40"
          style={{
            color: 'var(--status-success)',
            background: 'color-mix(in srgb, var(--status-success) 8%, transparent)',
            border: '1px solid color-mix(in srgb, var(--status-success) 45%, transparent)',
          }}
          data-testid="canvas-complete-arm"
          title={
            owed
              ? 'Sign this canvas off, closing what is still outstanding as not done. The next click names exactly what it will close.'
              : 'Sign this canvas off — the pane returns to the front page; find it again in the Library'
          }
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M20 6L9 17l-5-5" />
          </svg>
          Mark complete
        </button>
      )}
    </>
  )
}
