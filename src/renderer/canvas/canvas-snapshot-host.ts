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

import {
  CANVAS_BRIDGE_NS,
  canvasOrigin,
  type CanvasSnapshotOptions,
  type CanvasSnapshotReply,
  type CanvasSnapshotRequestEvent,
} from '../../shared/canvas'
import { sanitizeSnapshotResult } from '../../shared/canvas-snapshot-sanitize'

export interface LiveCanvasFrame {
  sessionId: string
  canvasId: string
  versionId: string
  /** The iframe's contentWindow, read at call time — it changes on reload. */
  getWindow: () => Window | null
}

/** Inside main's own timeout, so a slow frame surfaces THIS message rather than
 *  the generic one from the broker. */
export const FRAME_TIMEOUT_MS = 25_000

const frames = new Map<string, LiveCanvasFrame>()
let nextBridgeId = 1

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

function askFrame(target: Window, canvasId: string, options: CanvasSnapshotOptions, timeoutMs: number): Promise<unknown> {
  const id = nextBridgeId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage)
      reject(new Error('The canvas frame did not answer the snapshot request in time.'))
    }, timeoutMs)

    const onMessage = (event: MessageEvent) => {
      // Only our own frame, only this request.
      if (event.source !== target) return
      const msg = event.data as { ns?: string; id?: number; ok?: boolean; result?: unknown; error?: unknown } | null
      if (!msg || msg.ns !== CANVAS_BRIDGE_NS || msg.id !== id) return
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      if (msg.ok === true) resolve(msg.result)
      else reject(new Error(typeof msg.error === 'string' ? msg.error.slice(0, 300) : 'The canvas frame reported an error.'))
    }

    window.addEventListener('message', onMessage)
    // Targeted at the canvas's own origin: a request can never be delivered to
    // a document that is not this canvas's.
    target.postMessage(
      { ns: CANVAS_BRIDGE_NS, id, type: 'snapshot', scope: options.scope, analysis: options.analysis },
      canvasOrigin(canvasId),
    )
  })
}

export async function handleSnapshotRequest(
  event: CanvasSnapshotRequestEvent,
  timeoutMs = FRAME_TIMEOUT_MS,
): Promise<CanvasSnapshotReply> {
  const fail = (error: string): CanvasSnapshotReply => ({ requestId: event.requestId, ok: false, error })

  const frame = frames.get(event.sessionId)
  if (!frame) return fail('No Agent Canvas is open for this session. Open the Canvas pane and try again.')
  if (frame.canvasId !== event.canvasId) return fail('The open canvas does not match the one requested.')
  if (frame.versionId !== event.versionId) {
    return fail(`The canvas is showing ${frame.versionId}, not ${event.versionId}. Switch versions, or snapshot the active one.`)
  }
  const target = frame.getWindow()
  if (!target) return fail('The canvas frame is not loaded yet.')

  try {
    const raw = await askFrame(target, event.canvasId, event.options ?? {}, timeoutMs)
    return { requestId: event.requestId, ok: true, result: sanitizeSnapshotResult(raw) }
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
