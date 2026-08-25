import React, { useState } from 'react'
import { useArmedConfirm } from '../hooks/useArmedConfirm'
import { useCanvasStore } from '../stores/canvasStore'
import {
  draftAnnotationsOf,
  reviewGroupsOf,
  useCanvasReviewStore,
} from '../stores/canvasReviewStore'

interface Props {
  sessionId: string
  canvasId: string
  /** Named on the confirm, so the second click says WHAT it signs off. */
  title?: string
}

/**
 * The subject-level sign-off (#476), in the pane header's leave cluster.
 *
 * "Mark complete" is offered only when nothing is owed either way — no
 * unsubmitted notes, no notes with the agent, no verdicts owed, no
 * ready-render awaiting a first review. While anything is, the button stays
 * visible but disabled and says why: completion means the review cycle
 * FINISHED, not that the user wants to stop looking at it (that is dismiss).
 *
 * Two-step via useArmedConfirm like every other terminal action; the confirm
 * names the subject. Main re-checks the same "nothing owed" rule and
 * ownership — this predicate is the label, not the boundary.
 *
 * On a canvas already completed (the user reopened it from the library to
 * look), the slot shows the Completed chip with the one-click Reopen instead.
 */
export default function CanvasCompleteButton({ sessionId, canvasId, title }: Props) {
  const [armed, setArmed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const confirm = useArmedConfirm(armed ? 'complete' : null)

  const completed = useCanvasStore((s) => s.bySessionId[sessionId]?.completed)
  const awaitingReview = useCanvasStore((s) => !!s.bySessionId[sessionId]?.awaitingReview)
  const review = useCanvasReviewStore((s) => s.bySessionId[sessionId])

  // "Nothing left owed either way" — the renderer's mirror of the main-side
  // guard, over the same review state the panel renders. `waitingOn: 'closed'`
  // means every note on the round reached a terminal state.
  const groups = review && review.canvasId === canvasId ? reviewGroupsOf(review) : []
  const draftCount = review && review.canvasId === canvasId ? draftAnnotationsOf(review).length : 0
  const openRounds = groups.filter((g) => g.waitingOn !== 'closed').length
  const blocked = openRounds > 0 || draftCount > 0 || awaitingReview

  if (completed) {
    return (
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
          onClick={() => void window.electronAPI.canvas.completeReopen({ sessionId, canvasId })}
          className="underline underline-offset-2 font-normal focus-ring rounded"
          style={{ color: 'var(--brand)' }}
          data-testid="canvas-completed-reopen"
          title="Put this canvas back in play"
        >
          Reopen
        </button>
      </span>
    )
  }

  const doComplete = async () => {
    if (busy) return
    setBusy(true)
    try {
      const res = await window.electronAPI.canvas.complete({ sessionId, canvasId })
      if (!res.ok) {
        // Main refused (the counts moved under us, or ownership) — say why in
        // place and disarm; the state push will re-derive `blocked`.
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

  const blockedTip =
    draftCount > 0
      ? `You have ${draftCount} unsubmitted note${draftCount === 1 ? '' : 's'} — submit or delete them before signing off.`
      : openRounds > 0
        ? `${openRounds} review${openRounds === 1 ? ' is' : 's are'} still open — give your verdicts, or dismiss, before signing off.`
        : 'A render is still awaiting your first review — review or dismiss it before signing off.'

  return (
    <>
      {refused && (
        <span className="shrink-0 text-[10px]" style={{ color: 'var(--status-danger)' }} data-testid="canvas-complete-refused">
          {refused}
        </span>
      )}
      {armed ? (
        <>
          <button
            onClick={() => setArmed(false)}
            className="shrink-0 text-[11px] rounded px-1.5 py-0.5 border border-[var(--border-subtle)] text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-ring"
          >
            Cancel
          </button>
          <button
            ref={confirm.confirmRef}
            onClick={confirm.guarded(() => void doComplete())}
            disabled={busy}
            className="shrink-0 flex items-center gap-1.5 text-[11.5px] font-semibold rounded px-2 py-0.5 focus-ring disabled:opacity-40"
            style={{
              color: 'var(--color-crust)',
              background: 'var(--status-success)',
              border: '1px solid color-mix(in srgb, var(--status-success) 55%, transparent)',
            }}
            data-testid="canvas-complete-confirm"
            title="Signs the subject off. The pane returns to the front page; the canvas stays in the Library, reopenable in one click."
          >
            ✓ Complete{title ? ` “${title}”` : ' this canvas'}
          </button>
        </>
      ) : (
        <button
          onClick={() => {
            setRefused(null)
            setArmed(true)
          }}
          disabled={blocked || busy}
          className="shrink-0 flex items-center gap-1.5 text-[11.5px] rounded px-2 py-0.5 focus-ring disabled:opacity-40 disabled:cursor-not-allowed"
          style={{
            color: 'var(--status-success)',
            background: 'color-mix(in srgb, var(--status-success) 8%, transparent)',
            border: '1px solid color-mix(in srgb, var(--status-success) 45%, transparent)',
          }}
          data-testid="canvas-complete-arm"
          title={
            blocked
              ? blockedTip
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
