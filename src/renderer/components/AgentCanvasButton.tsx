import React from 'react'
import { useExcalidrawStore } from '../stores/excalidrawStore'
import { useCanvasStore } from '../stores/canvasStore'
import { ReservedLabel } from './command-bar/chips'
import { useCanvasReviewStore } from '../stores/canvasReviewStore'
import { useCanvasTotalsStore } from '../stores/canvasTotalsStore'
import { useCanvasQueue, useCanvasResumables } from '../lib/canvasQueue'
import { trackUsage } from '../stores/tipsStore'
import CanvasQueuePopover from './CanvasQueuePopover'

interface Props {
  sessionId: string
}

/**
 * Tool button next to Snap/Browser — the Agent Canvas entry (spec D2: the old
 * per-session Draw button became the canvas; the classic Excalidraw
 * scratchpad lives on as the canvas's empty state, so pane visibility still
 * lives in excalidrawStore and nothing the Draw button did is lost).
 *
 * The waiting-on-you signal is the owner's pick B (#364/#366): while ANYTHING
 * is in the review queue the button stops being furniture — warning colour,
 * the label itself says "Review needed", and the count rides beside it. The
 * old purple pulse is retired: one signal, one meaning, and "the agent drew
 * something" only matters once the agent says it is ready, which is exactly
 * when the queue counts it. Clicking the count opens the owed list; clicking
 * the button still toggles the pane.
 */
export default function AgentCanvasButton({ sessionId }: Props) {
  const isOpen = useExcalidrawStore((s) => !!s.bySessionId[sessionId]?.isOpen)
  const togglePane = useExcalidrawStore((s) => s.togglePane)
  // #478: while the submit-triggered hand-back is in flight it is the only
  // driver of pane state — this toggle disables for the beat, then reads
  // "Canvas" again once the landing closes the pane.
  const returning = useExcalidrawStore((s) => !!s.submitReturnBySession[sessionId])
  const queue = useCanvasQueue(sessionId)
  const [queueOpen, setQueueOpen] = React.useState(false)

  // The command bar's right-click menu offers "Show what's waiting"; the
  // popover state lives here, so the menu reaches it by event (the
  // app:openSettings pattern — no ref surgery across the bar).
  React.useEffect(() => {
    const onShowQueue = (e: Event) => {
      if ((e as CustomEvent<{ sessionId?: string }>).detail?.sessionId === sessionId) setQueueOpen(true)
    }
    window.addEventListener('ccc:canvasShowQueue', onShowQueue)
    return () => window.removeEventListener('ccc:canvasShowQueue', onShowQueue)
  }, [sessionId])

  const canvasLoaded = useCanvasStore((s) => !!s.bySessionId[sessionId]?.loaded)
  const refreshCanvas = useCanvasStore((s) => s.refresh)
  const reviewsLoaded = useCanvasReviewStore((s) => !!s.bySessionId[sessionId]?.loaded)
  const refreshReviews = useCanvasReviewStore((s) => s.refresh)
  const totalsLoaded = useCanvasTotalsStore((s) => !!s.bySessionId[sessionId]?.loaded)
  const refreshTotals = useCanvasTotalsStore((s) => s.refresh)

  // Hydrate all three sources the queue reads the first time this session's
  // button mounts; the push listeners keep them live after that. A count that
  // is silently wrong is worse than none (the lesson the old review pill
  // learnt), and the queue must not under-count because a pane was never
  // opened this run.
  React.useEffect(() => {
    if (!canvasLoaded) void refreshCanvas(sessionId)
  }, [sessionId, canvasLoaded, refreshCanvas])
  React.useEffect(() => {
    if (!reviewsLoaded) void refreshReviews(sessionId)
  }, [sessionId, reviewsLoaded, refreshReviews])
  React.useEffect(() => {
    if (!totalsLoaded) void refreshTotals(sessionId)
  }, [sessionId, totalsLoaded, refreshTotals])

  const waiting = queue > 0
  // Ownerless canvas work on this project (M4). A SEPARATE signal, never added
  // to the queue: the queue is what this session owes an answer on, and this is
  // work nobody currently holds that anyone here MAY pick up. Merging them
  // would make one number mean two things, and the loud state's number has to
  // mean exactly one. So the queue keeps the words and the colour; this gets a
  // quiet dot, and only in the idle state — nothing may compete with an
  // outstanding review for attention.
  const resumables = useCanvasResumables(sessionId)
  const idle = !isOpen && !waiting

  // OPEN state names the DESTINATION, not the current pane — the same rule the
  // Partner toggle already follows ("Partner" -> "Claude"). This pane REPLACES
  // the terminal. While the queue is non-empty the label is the state itself:
  // words, not a glow, is what makes it readable as "waiting on you".
  const label = isOpen ? 'Terminal' : waiting ? 'Review needed' : 'Canvas'
  const warnStyle: React.CSSProperties = {
    color: 'var(--status-warning)',
    background: 'color-mix(in srgb, var(--status-warning) 13%, transparent)',
    borderColor: 'color-mix(in srgb, var(--status-warning) 65%, transparent)',
  }

  return (
    <div className="relative shrink-0 inline-flex">
      <button
        onClick={() => {
          // Recorded on OPEN only: closing the pane is not discovering it, and a
          // toggle that recorded both would make the count meaningless. This is
          // what retires the canvas tip and unlocks the plan-mode one.
          if (!isOpen) trackUsage('canvas.opened')
          togglePane(sessionId)
        }}
        disabled={returning}
        className={`relative flex items-center gap-1.5 px-2 h-7 text-xs rounded border whitespace-nowrap shrink-0 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
          isOpen
            ? 'bg-mauve/20 border-mauve/70 text-mauve hover:bg-mauve/30'
            : waiting
              ? 'font-semibold'
              : 'bg-surface0/60 border-surface1/80 hover:bg-surface1 text-overlay1 hover:text-text'
        }`}
        style={!isOpen && waiting ? warnStyle : undefined}
        title={
          returning
            ? 'Returning to the terminal…'
            : isOpen
              ? 'Back to the terminal (closes the Agent Canvas)'
              : waiting
                ? `${queue} canvas${queue === 1 ? '' : 'es'} waiting on your review — click the count for the list`
                : resumables > 0
                  ? 'Open Agent Canvas — unfinished canvas work can be resumed'
                  : 'Open Agent Canvas'
        }
        data-testid="canvas-button"
        // The guided tour anchors on this, not on data-testid: the tour is
        // shipped behaviour and must not depend on a test hook that a cleanup
        // pass would feel free to rename.
        data-tour="canvas-button"
        data-waiting={waiting ? 'true' : undefined}
      >
        {isOpen ? (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M11 18l-6-6 6-6" />
          </svg>
        ) : (
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            {/* Framed-canvas + pen glyph */}
            <rect x="1.5" y="2.5" width="13" height="9" rx="1" />
            <path d="M10.8 5.2l1.6 1.6-3.4 3.4H7.4V8.6z" />
            <path d="M5 14h6" />
          </svg>
        )}
        {/* Reserve only the states a CLICK can reach: `waiting` flips on
            queue changes, not clicks, so idle must not carry the bold
            Review-needed width (~48px of dead space) permanently. */}
        <ReservedLabel
          current={label}
          states={waiting ? ['Terminal', { text: 'Review needed', bold: true }] : ['Canvas', 'Terminal']}
        />
        {/* The resume dot. Its SLOT is reserved for the whole idle state, not
            just when it is filled: the dot arrives from a background sweep, not
            from a click, and a button that widened by 9px under the cursor
            would shove every tool to its right. Same reasoning as
            ReservedLabel, applied to a glyph. */}
        {idle && (
          <span
            className="canvas-resume-dot"
            data-empty={resumables > 0 ? undefined : 'true'}
            data-testid="canvas-resume-dot"
            title={resumables > 0 ? 'Unfinished canvas work can be resumed' : undefined}
            aria-hidden={resumables > 0 ? undefined : true}
          >
            {resumables > 0 && (
              <svg width="7" height="7" viewBox="0 0 7 7" aria-label="Unfinished canvas work can be resumed" role="img">
                <circle cx="3.5" cy="3.5" r="3.5" fill="currentColor" />
              </svg>
            )}
          </span>
        )}
        {/* THE queue number (#364): ready-marked rounds + rounds awaiting your
            verdicts, across every canvas this session owns. Never decremented
            by merely opening anything — a round leaves when you submit on it,
            give the last verdict, or dismiss it. */}
        {waiting && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); setQueueOpen((v) => !v) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                e.stopPropagation()
                setQueueOpen((v) => !v)
              }
            }}
            className="inline-flex items-center justify-center min-w-[15px] h-[15px] px-1 rounded-full text-[9.5px] font-bold tabular-nums focus-ring"
            style={{ background: 'var(--status-warning)', color: 'var(--color-crust)' }}
            title={`${queue} waiting on you — open the list`}
            aria-label={`${queue} waiting on you — open the list`}
            aria-haspopup="menu"
            aria-expanded={queueOpen}
            data-testid="canvas-queue-count"
          >
            {queue}
          </span>
        )}
      </button>
      {queueOpen && <CanvasQueuePopover sessionId={sessionId} onClose={() => setQueueOpen(false)} />}
    </div>
  )
}
