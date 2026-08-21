import React from 'react'
import { useExcalidrawStore } from '../stores/excalidrawStore'
import { useCanvasStore } from '../stores/canvasStore'
import { useCanvasReviewStore, openReviewsOf } from '../stores/canvasReviewStore'
import { useCanvasTotalsStore } from '../stores/canvasTotalsStore'
import { trackUsage } from '../stores/tipsStore'

interface Props {
  sessionId: string
}

/**
 * Tool button next to Snap/Web — the Agent Canvas entry (spec D2: the old
 * per-session Draw button became the canvas; the classic Excalidraw
 * scratchpad lives on as the canvas's empty state, so pane visibility still
 * lives in excalidrawStore and nothing the Draw button did is lost).
 *
 * When the agent renders while the pane is closed — the hand-back moment —
 * the button pulses until the user opens it (canvasStore.unseenRender).
 */
export default function AgentCanvasButton({ sessionId }: Props) {
  const isOpen = useExcalidrawStore((s) => !!s.bySessionId[sessionId]?.isOpen)
  const togglePane = useExcalidrawStore((s) => s.togglePane)
  const unseen = useCanvasStore((s) => !!s.bySessionId[sessionId]?.unseenRender)
  // Reviews sent and not closed out, on this session's current canvas. Shown
  // only from TWO, on the owner's framing and for a reason worth keeping: a
  // review can only close when every note in it has a verdict, so a single
  // outstanding one would sit on the button indefinitely and stop meaning
  // anything. Two is news.
  const openReviews = useCanvasReviewStore((s) => {
    const st = s.bySessionId[sessionId]
    return st ? openReviewsOf(st).length : 0
  })
  const reviewsLoaded = useCanvasReviewStore((s) => !!s.bySessionId[sessionId]?.loaded)
  const refreshReviews = useCanvasReviewStore((s) => s.refresh)
  // The number that spans canvases (item 29, the deferred half of the
  // 2026-08-20 dimensions pass): open reviews across EVERY canvas this
  // session owns. The pane's own count is honest about the canvas on screen
  // and blind to the others; from the terminal, "the others" is exactly what
  // you cannot see. The pill shows the total; the tooltip splits it.
  const totals = useCanvasTotalsStore((s) => s.bySessionId[sessionId])
  const refreshTotals = useCanvasTotalsStore((s) => s.refresh)
  // Open on OTHER canvases: the sweep's total minus the sweep's view of the
  // on-screen canvas. The on-screen canvas itself comes from the live mirror,
  // which is fresher in both directions -- a review sent here shows before the
  // sweep catches up, and one closed here drops before it does. So the total
  // is "the sweep's others + the mirror's here", never a max of the two (a max
  // kept a stale high after a close, which a review pointed out).
  const elsewhere = totals?.loaded ? Math.max(0, totals.openReviews - totals.onActive) : 0
  const totalOpen = elsewhere + openReviews
  const unknown = totals?.loaded ? totals.unknown : 0
  // From TWO on this canvas (the rule above) — OR from ONE when any of it is
  // on a canvas you are not looking at, because that one is invisible from
  // here and a pill is the only way to learn it exists.
  const showCount = totalOpen >= 2 || elsewhere >= 1

  // Hydrate the sweep the first time this session's button mounts; the push
  // listeners keep it live after that.
  React.useEffect(() => {
    if (!totals?.loaded) void refreshTotals(sessionId)
  }, [sessionId, totals?.loaded, refreshTotals])

  // The review mirror was only ever filled when the notes panel mounted, so
  // this button would have read zero for any session whose pane had not been
  // opened yet this run -- a count that is silently wrong is worse than none.
  // Hydrating HERE rather than at boot costs one call per session you actually
  // visit, instead of one per session you have open. Idempotent: `loaded` is set
  // by refresh, including for a session with no canvas at all.
  React.useEffect(() => {
    if (!reviewsLoaded) void refreshReviews(sessionId)
  }, [sessionId, reviewsLoaded, refreshReviews])

  const attention = unseen && !isOpen

  // OPEN state names the DESTINATION, not the current pane — the same rule the
  // Partner toggle already follows ("Partner" -> "Claude"). This pane REPLACES
  // the terminal, and a button still reading "Canvas" gave a new user nothing to
  // aim at: the only cue that it was a toggle was a faint tint on one button in
  // a row of five identical ones, and "Hide Agent Canvas" lived in a tooltip
  // they had to already suspect to hover. Accent-tinted while open so leaving
  // the terminal is visible without hovering anything.
  return (
    <button
      onClick={() => {
        // Recorded on OPEN only: closing the pane is not discovering it, and a
        // toggle that recorded both would make the count meaningless. This is
        // what retires the canvas tip and unlocks the plan-mode one.
        if (!isOpen) trackUsage('canvas.opened')
        togglePane(sessionId)
      }}
      className={`relative flex items-center gap-1.5 px-2 py-0.5 text-xs rounded border whitespace-nowrap shrink-0 transition-colors ${
        isOpen
          ? 'bg-mauve/20 border-mauve/70 text-mauve hover:bg-mauve/30'
          : attention
            ? 'bg-mauve/10 border-mauve/60 text-mauve hover:bg-mauve/20'
            : 'bg-surface0/60 border-surface1/80 hover:bg-surface1 text-overlay1 hover:text-text'
      }`}
      title={attention ? 'The agent rendered something new — open the Agent Canvas' : isOpen ? 'Back to the terminal (closes the Agent Canvas)' : 'Open Agent Canvas'}
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
      {isOpen ? 'Terminal' : 'Canvas'}
      {/* The count is a pill BESIDE the label, never a corner badge: the corner
          already means "the agent just drew something new" (the pulse below),
          and one badge holding two meanings is worse than no badge. */}
      {showCount && (
        <span
          className="inline-flex items-center justify-center min-w-[15px] h-[15px] px-1 rounded-full text-[9.5px] font-bold tabular-nums"
          style={{ background: 'var(--color-peach)', color: 'var(--color-crust)' }}
          title={[
            `${totalOpen} review${totalOpen === 1 ? '' : 's'} still open across ${totals?.loaded ? `${totals.canvases} canvas${totals.canvases === 1 ? '' : 'es'}` : 'your canvases'}`,
            totals?.loaded && totals.canvases > 1 ? ` — ${openReviews} on this one, ${elsewhere} elsewhere (open the subject picker to see which)` : '',
            unknown > 0 ? `; ${unknown} canvas${unknown === 1 ? '' : 'es'} could not be read` : '',
            '. A review closes when every note in it has your verdict.',
          ].join('')}
          data-testid="canvas-open-reviews-count"
          data-elsewhere={elsewhere}
        >
          {totalOpen}
        </span>
      )}
      {attention && (
        <span className="absolute -top-1 -right-1 flex h-2.5 w-2.5" data-testid="canvas-attention-dot">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-mauve opacity-75" />
          <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-mauve" />
        </span>
      )}
    </button>
  )
}
