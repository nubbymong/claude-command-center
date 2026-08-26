import { useCanvasStore } from '../stores/canvasStore'
import { useCanvasReviewStore } from '../stores/canvasReviewStore'
import { useCanvasTotalsStore, type CanvasQueueRow } from '../stores/canvasTotalsStore'
import type { CanvasSessionState } from '../stores/canvasStore'
import type { CanvasReviewSessionState } from '../stores/canvasReviewStore'
import type { CanvasTotals } from '../stores/canvasTotalsStore'

/**
 * THE queue number (#364), assembled the way the Canvas button always mixed
 * its counts: the cross-canvas sweep for everything the session owns, with the
 * on-screen canvas read from the live mirrors instead when they are loaded —
 * they are fresher in both directions (a submit drops the round here before
 * the sweep catches up; a ready-mark lands here first too).
 *
 * Pure and exported for tests; the hook below is the component-facing shape.
 */
export function canvasQueueOf(
  canvasLive: Pick<CanvasSessionState, 'loaded' | 'canvasId' | 'awaitingReview'> | undefined,
  reviewLive: CanvasReviewSessionState | undefined,
  totals: CanvasTotals | undefined,
): number {
  const liveLoaded = !!canvasLive?.loaded && !!reviewLive?.loaded
  // ONE canvas is at most ONE owed item (#470) — here as well as in the sweep.
  // The live mirrors are where the owner's pill actually read 3: the on-screen
  // canvas's rounds were counted one per submitted review.
  let liveOwed = 0
  if (liveLoaded) {
    // C1: the ONLY thing the queue counts is an open version awaiting the
    // user's review (the awaitingReview slot). Rounds "awaiting verdicts" no
    // longer exist as user debt — a submit carries the verdict, and legacy
    // piles settle on load — so the phantom Review-needed pill is impossible
    // by construction rather than capped.
    liveOwed = canvasLive?.awaitingReview ? 1 : 0
  }
  if (!totals?.loaded) return liveOwed
  const elsewhere = Math.max(0, totals.queue - totals.queueOnActive)
  return liveLoaded ? elsewhere + liveOwed : totals.queue
}

/** The queue number for one session. Every selector returns a primitive, so
 *  zustand's Object.is keeps re-renders honest. */
export function useCanvasQueue(sessionId: string): number {
  const awaiting = useCanvasStore((s) => {
    const st = s.bySessionId[sessionId]
    return st?.loaded ? (st.awaitingReview ? 1 : 0) : undefined
  })
  const reviewsLoaded = useCanvasReviewStore((s) => (s.bySessionId[sessionId]?.loaded ? 1 : undefined))
  const sweepQueue = useCanvasTotalsStore((s) => {
    const t = s.bySessionId[sessionId]
    return t?.loaded ? t.queue : undefined
  })
  const sweepOnActive = useCanvasTotalsStore((s) => {
    const t = s.bySessionId[sessionId]
    return t?.loaded ? t.queueOnActive : undefined
  })
  const liveLoaded = awaiting !== undefined && reviewsLoaded !== undefined
  // C1: one open version per artifact is the whole count (see canvasQueueOf).
  const liveOwed = liveLoaded ? (awaiting > 0 ? 1 : 0) : 0
  if (sweepQueue === undefined || sweepOnActive === undefined) return liveOwed
  return liveLoaded ? Math.max(0, sweepQueue - sweepOnActive) + liveOwed : sweepQueue
}

/** The owed rounds for the queue list, newest first, from the sweep. */
export function useCanvasQueueRows(sessionId: string): CanvasQueueRow[] {
  return useCanvasTotalsStore((s) => s.bySessionId[sessionId]?.queueRows ?? EMPTY_ROWS)
}

const EMPTY_ROWS: CanvasQueueRow[] = []

/** "2m" / "4h" / "1d" — the queue row's age, compact. */
export function queueAge(at: string, now = Date.now()): string {
  const t = Date.parse(at)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.floor((now - t) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}
