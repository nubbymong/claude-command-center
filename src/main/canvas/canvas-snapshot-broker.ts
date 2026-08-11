// Snapshot capture, brokered from main to the live content frame.
//
// The snapshot only exists where the page is rendered — inside the canvas
// iframe, in the renderer. The `canvas_snapshot` MCP tool runs in main, so a
// capture is two id-correlated hops: main → renderer (CANVAS_SNAPSHOT_REQUEST)
// → content frame (postMessage) and back.
//
// This module owns the main-side half: one pending map, a hard timeout so a
// wedged or closed frame can never hold an MCP call open, a cap on concurrent
// captures, and — because everything coming back was assembled by the PAGE —
// sanitisation before the result is handed to anyone (canvas-snapshot-sanitize.ts).

import type {
  CanvasSnapshotOptions,
  CanvasSnapshotReply,
  CanvasSnapshotRequestEvent,
  CanvasSnapshotResult,
} from '../../shared/canvas'
import { randomId } from '../../shared/id'
import { sanitizeSnapshotResult } from '../../shared/canvas-snapshot-sanitize'

/** Generous: an unscoped axe pass on a dense page is seconds, not milliseconds.
 *  The point is that it is BOUNDED, not that it is tight. */
export const SNAPSHOT_TIMEOUT_MS = 30_000

/** A capture is user-visible work in the renderer; there is no reason for an
 *  agent to have more than a couple in flight, and a cap keeps a loop from
 *  pinning the frame.
 *
 *  PER SESSION, not global: a global cap let one looping session starve every
 *  other session's captures for the full timeout window. */
const MAX_IN_FLIGHT_PER_SESSION = 4

type Sender = (event: CanvasSnapshotRequestEvent) => boolean

interface Pending {
  sessionId: string
  /** What WE asked for, not what came back: styles are only legitimate on a
   *  scoped capture, and the reply is written by the page. */
  scoped: boolean
  resolve: (result: CanvasSnapshotResult) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

let sender: Sender | null = null
const pending = new Map<string, Pending>()

/** Installed by the IPC layer, which owns the window handle. */
export function setSnapshotSender(fn: Sender | null): void {
  sender = fn
}

export interface SnapshotRequest {
  sessionId: string
  canvasId: string
  versionId: string
  options: CanvasSnapshotOptions
}

export function requestCanvasSnapshot(request: SnapshotRequest): Promise<CanvasSnapshotResult> {
  if (!sender) return Promise.reject(new Error('The app window is not available to capture a snapshot.'))
  let mine = 0
  for (const waiting of pending.values()) if (waiting.sessionId === request.sessionId) mine++
  if (mine >= MAX_IN_FLIGHT_PER_SESSION) {
    return Promise.reject(new Error('Too many snapshot captures are already in flight for this session; try again in a moment.'))
  }

  const requestId = randomId()
  const event: CanvasSnapshotRequestEvent = { requestId, ...request }
  if (!sender(event)) {
    return Promise.reject(new Error('The app window is not available to capture a snapshot.'))
  }

  return new Promise<CanvasSnapshotResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      reject(new Error('The canvas frame did not answer in time. Is the Agent Canvas open on this session?'))
    }, SNAPSHOT_TIMEOUT_MS)
    pending.set(requestId, {
      sessionId: request.sessionId,
      scoped: (request.options?.scope?.length ?? 0) > 0,
      resolve,
      reject,
      timer,
    })
  })
}

/** Called with whatever arrived on CANVAS_SNAPSHOT_RESULT. Unknown or malformed
 *  replies are dropped: a late reply after a timeout is normal, not an error. */
export function resolveCanvasSnapshot(raw: unknown): void {
  if (typeof raw !== 'object' || raw === null) return
  const reply = raw as Partial<CanvasSnapshotReply>
  if (typeof reply.requestId !== 'string') return
  const waiting = pending.get(reply.requestId)
  if (!waiting) return
  pending.delete(reply.requestId)
  clearTimeout(waiting.timer)

  if (reply.ok === true) {
    waiting.resolve(sanitizeSnapshotResult((reply as { result?: unknown }).result, undefined, { scoped: waiting.scoped }))
    return
  }
  const error = (reply as { error?: unknown }).error
  waiting.reject(new Error(typeof error === 'string' && error.length > 0 ? error.slice(0, 300) : 'The canvas frame could not produce a snapshot.'))
}

export function _resetSnapshotBrokerForTest(): void {
  for (const waiting of pending.values()) clearTimeout(waiting.timer)
  pending.clear()
  sender = null
}
