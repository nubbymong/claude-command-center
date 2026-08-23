import { useCanvasStore } from '../stores/canvasStore'
import { reviewGroupsOf, useCanvasReviewStore } from '../stores/canvasReviewStore'
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
  const liveQueue = liveLoaded
    ? (canvasLive?.awaitingReview ? 1 : 0) +
      (reviewLive ? reviewGroupsOf(reviewLive).filter((g) => g.waitingOn === 'you').length : 0)
    : 0
  if (!totals?.loaded) return liveQueue
  const elsewhere = Math.max(0, totals.queue - totals.queueOnActive)
  return liveLoaded ? elsewhere + liveQueue : totals.queue
}

/** The queue number for one session. Every selector returns a primitive, so
 *  zustand's Object.is keeps re-renders honest. */
export function useCanvasQueue(sessionId: string): number {
  const awaiting = useCanvasStore((s) => {
    const st = s.bySessionId[sessionId]
    return st?.loaded ? (st.awaitingReview ? 1 : 0) : undefined
  })
  const verdict = useCanvasReviewStore((s) => {
    const st = s.bySessionId[sessionId]
    return st?.loaded ? reviewGroupsOf(st).filter((g) => g.waitingOn === 'you').length : undefined
  })
  const sweepQueue = useCanvasTotalsStore((s) => {
    const t = s.bySessionId[sessionId]
    return t?.loaded ? t.queue : undefined
  })
  const sweepOnActive = useCanvasTotalsStore((s) => {
    const t = s.bySessionId[sessionId]
    return t?.loaded ? t.queueOnActive : undefined
  })
  const liveLoaded = awaiting !== undefined && verdict !== undefined
  const liveQueue = liveLoaded ? awaiting + verdict : 0
  if (sweepQueue === undefined || sweepOnActive === undefined) return liveQueue
  return liveLoaded ? Math.max(0, sweepQueue - sweepOnActive) + liveQueue : sweepQueue
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
