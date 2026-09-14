import { useCanvasStore } from '../stores/canvasStore'
import { useCanvasReviewStore } from '../stores/canvasReviewStore'
import { useCanvasTotalsStore, type CanvasQueueRow } from '../stores/canvasTotalsStore'
import type { CanvasSessionState } from '../stores/canvasStore'
import type { CanvasReviewSessionState } from '../stores/canvasReviewStore'
import type { CanvasTotals } from '../stores/canvasTotalsStore'
import type { CanvasDismissRefusal, CanvasResumeRefusal, ResumableRow } from '../../shared/canvas'

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

/**
 * Ownerless canvas work on this project, waiting to be picked up (M4).
 *
 * Deliberately NOT folded into the queue number. The queue is what this
 * session owes an answer on; a resumable is work nobody currently holds, which
 * this session MAY adopt. Merging them would make "Review needed 3" mean two
 * different things at once, and the count that drives the loud state has to
 * mean exactly one.
 */
export function useCanvasResumables(sessionId: string): number {
  return useCanvasTotalsStore((s) => s.bySessionId[sessionId]?.resumables ?? 0)
}

/** Those rows, as main ordered them. */
export function useCanvasResumableRows(sessionId: string): ResumableRow[] {
  return useCanvasTotalsStore((s) => s.bySessionId[sessionId]?.resumableRows ?? EMPTY_RESUMABLES)
}

const EMPTY_RESUMABLES: ResumableRow[] = []

/** Why a resume or a dismiss did not happen, in the words the surfaces show.
 *  One plain line each: the row is gone either way, and the user needs to know
 *  whether someone else took it or it simply no longer exists. Keyed on the
 *  CLOSED vocabularies main answers with — nothing free-text crosses. */
export const RESUME_REFUSALS: Record<CanvasResumeRefusal | CanvasDismissRefusal, string> = {
  'owner-live': 'Another session picked that up first.',
  changed: 'Another session picked that up first.',
  completed: 'That canvas was signed off.',
  gone: 'That canvas is no longer there.',
  'not-eligible': 'That canvas is not available here any more.',
}

/** The plain line for a refusal, including one we have no wording for — never a
 *  raw reason code, and never silence. */
export function resumeRefusalText(reason?: string): string {
  return (reason && RESUME_REFUSALS[reason as CanvasResumeRefusal]) || 'That canvas could not be resumed.'
}

/**
 * What the armed Dismiss confirm says will go.
 *
 * A pack can hold evidence — screenshots, state stamps, action trails — with no
 * NOTES written against it yet, and "Delete 0 notes and their evidence" both
 * reads as a bug and understates what is about to be destroyed. With nothing to
 * count, name the thing itself. Shared by the front page and the queue popover
 * so two confirms for one irreversible action cannot drift apart.
 */
export function dismissConfirmLabel(noteCount: number): string {
  if (noteCount <= 0) return 'Delete this canvas and its saved evidence'
  if (noteCount === 1) return 'Delete 1 note and its evidence'
  return `Delete ${noteCount} notes and their evidence`
}

/** The same sentence as an accessible name, with the subject in it — a confirm
 *  read out of context has to say WHAT it is discarding. */
export function dismissConfirmAriaLabel(title: string, noteCount: number): string {
  return noteCount <= 0
    ? `Discard ${title}: deletes the canvas and its saved evidence`
    : `Discard ${title}: deletes ${dismissConfirmLabel(noteCount).replace(/^Delete /, '')}`
}

/**
 * Adopt an ownerless canvas. Compare-and-set: `expectedOwnerSessionId` is the
 * token main checks against the record before it rebinds, so two sessions
 * racing on one row cannot both win — the loser is told, not silently ignored.
 *
 * The open tiles are re-read at CLICK time rather than reused from the list:
 * main applies the same liveness rule on both calls, and the truth may have
 * changed in between.
 */
export async function resumeCanvas(
  sessionId: string,
  row: Pick<ResumableRow, 'canvasId' | 'expectedOwnerSessionId'>,
  openTileSessionIds: string[],
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await window.electronAPI.canvas.resume({
      sessionId,
      canvasId: row.canvasId,
      expectedOwnerSessionId: row.expectedOwnerSessionId,
      openTileSessionIds,
    })
    return res?.ok ? { ok: true } : { ok: false, ...(res?.reason ? { reason: res.reason } : {}) }
  } catch {
    return { ok: false }
  }
}

/** Discard an ownerless canvas — versions, notes and evidence go with it.
 *  Only ever reached through an armed confirm that says so. */
export async function dismissCanvas(
  sessionId: string,
  canvasId: string,
  openTileSessionIds: string[],
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await window.electronAPI.canvas.dismiss({ sessionId, canvasId, openTileSessionIds })
    return res?.ok ? { ok: true } : { ok: false, ...(res?.reason ? { reason: res.reason } : {}) }
  } catch {
    return { ok: false }
  }
}

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
