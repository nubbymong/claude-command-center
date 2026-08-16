// The renderer's half of a snapshot capture.
//
// Main can't see the page: it lives in the canvas iframe. So `canvas_snapshot`
// (main) asks the renderer, and the renderer asks the frame. This module is the
// middle hop — armed once at boot, never from a pane, so a request that arrives
// while nothing is mounted gets a real answer ("open the canvas") instead of
// silence (the cloud-agent listener lesson).
//
// The frame's answer is assembled BY THE PAGE. It is bounded here before it
// crosses IPC — a forged reply must not be able to push an unbounded structure
// into the main process — and bounded again on arrival there.

import type { CanvasSnapshotReply, CanvasSnapshotRequestEvent } from '../../shared/canvas'
import { sanitizeSnapshotResult } from '../../shared/canvas-snapshot-sanitize'
import { askCanvasFrame } from './canvas-frame-rpc'
import { captureHeadless } from './canvas-headless-capture'

export interface LiveCanvasFrame {
  sessionId: string
  canvasId: string
  versionId: string
  /** The iframe's contentWindow, read at call time — it changes on reload. */
  getWindow: () => Window | null
  /** Whether the bridge in THIS document has announced itself. A freshly mounted
   *  iframe has a non-null contentWindow holding about:blank, and a targeted
   *  postMessage to it is silently dropped on the origin mismatch — so without
   *  this the natural render-then-snapshot flow stalls for the full timeout. */
  isReady: () => boolean
}

/** Inside main's own timeout, so a slow frame surfaces THIS message rather than
 *  the generic one from the broker. */
export const FRAME_TIMEOUT_MS = 25_000

const frames = new Map<string, LiveCanvasFrame>()

/** Called by the canvas pane while it is mounted. Returns the unregister. */
export function registerCanvasFrame(frame: LiveCanvasFrame): () => void {
  frames.set(frame.sessionId, frame)
  return () => {
    if (frames.get(frame.sessionId) === frame) frames.delete(frame.sessionId)
  }
}

export function _framesForTest(): Map<string, LiveCanvasFrame> {
  return frames
}

export async function handleSnapshotRequest(
  event: CanvasSnapshotRequestEvent,
  timeoutMs = FRAME_TIMEOUT_MS,
): Promise<CanvasSnapshotReply> {
  const fail = (error: string): CanvasSnapshotReply => ({ requestId: event.requestId, ok: false, error })

  const frame = frames.get(event.sessionId)
  const liveMatches = !!frame && frame.canvasId === event.canvasId && frame.versionId === event.versionId
  if (!liveMatches) {
    // Pane closed, on another canvas, or on another version: lay the requested
    // version out in a hidden off-screen frame instead of failing. The old
    // hard refusals here broke the product's DEFAULT flow — the agent reads
    // its render while the user is at the terminal, where the pane is closed
    // by design (canvas replaces chat, spec D2/D3). A matching live pane stays
    // preferred below: it measures the viewport the user actually sees.
    return captureHeadless(event)
  }
  const target = frame.getWindow()
  if (!target) return fail('The canvas frame is not loaded yet.')
  if (!frame.isReady()) return fail('The canvas page is still loading. Try again in a moment.')

  try {
    const options = event.options ?? {}
    const raw = await askCanvasFrame(
      target,
      event.canvasId,
      { type: 'snapshot', scope: options.scope, analysis: options.analysis },
      timeoutMs,
    )
    // Sanitised HERE as well as in main, and the scope is known here, so an
    // unscoped capture sheds its styles before it ever crosses IPC rather than
    // after.
    return {
      requestId: event.requestId,
      ok: true,
      result: sanitizeSnapshotResult(raw, undefined, { scoped: (options.scope?.length ?? 0) > 0 }),
    }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}

let armed = false

/** Module-level and idempotent, armed once from App's boot effect. */
export function setupCanvasSnapshotHost(): void {
  if (armed) return
  armed = true
  window.electronAPI.canvas.onSnapshotRequest((event) => {
    void handleSnapshotRequest(event).then((reply) => {
      window.electronAPI.canvas.sendSnapshotResult(reply)
    })
  })
}
