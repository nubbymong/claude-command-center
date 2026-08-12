// One request/response call into the canvas content frame.
//
// Extracted from canvas-snapshot-host so the P3 surfaces (inspect on click,
// resolveAnchors for the checklist) ride the SAME hardened path the snapshot
// does rather than a hand-copied variant that drifts: random correlation ids
// (a counter let a hostile page answer before the real bridge), source AND
// origin checked on every reply (a frame's window identity survives
// navigation), targeted postMessage (a request can never be delivered to a
// document that is not this canvas's), and full listener/timer cleanup on
// every exit path.

import { CANVAS_BRIDGE_NS, canvasOrigin } from '../../shared/canvas'

/** Correlation ids are random, not a counter. A counter starting at 1 let a
 *  hostile page spray guessed ids at its parent and answer a request before the
 *  real bridge did — the reply channel has no other proof of who is speaking. */
function bridgeRequestId(): number {
  const bytes = new Uint32Array(1)
  globalThis.crypto.getRandomValues(bytes)
  return bytes[0]
}

/**
 * Post one bridge request into `target` and resolve with the (untrusted, still
 * unsanitised) result. `payload` carries `type` and the request's own fields;
 * ns and id are stamped here.
 */
export function askCanvasFrame(
  target: Window,
  canvasId: string,
  payload: Record<string, unknown> & { type: string },
  timeoutMs: number,
): Promise<unknown> {
  const id = bridgeRequestId()
  const origin = canvasOrigin(canvasId)
  return new Promise((resolve, reject) => {
    const settle = (fn: () => void) => {
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      fn()
    }

    const timer = setTimeout(() => {
      settle(() => reject(new Error(`The canvas frame did not answer the ${payload.type} request in time.`)))
    }, timeoutMs)

    const onMessage = (event: MessageEvent) => {
      // Both halves matter. `source` proves it came from the frame we asked;
      // `origin` proves the document ANSWERING is still this canvas's — a
      // frame's window identity survives navigation, so without the origin
      // check a document that replaced the one we asked could answer for it.
      if (event.source !== target || event.origin !== origin) return
      const msg = event.data as { ns?: string; id?: number; ok?: boolean; result?: unknown; error?: unknown } | null
      if (!msg || msg.ns !== CANVAS_BRIDGE_NS || msg.id !== id) return
      if (msg.ok === true) settle(() => resolve(msg.result))
      else settle(() => reject(new Error(typeof msg.error === 'string' ? msg.error.slice(0, 300) : 'The canvas frame reported an error.')))
    }

    window.addEventListener('message', onMessage)
    try {
      // Targeted at the canvas's own origin: a request can never be delivered
      // to a document that is not this canvas's.
      target.postMessage({ ns: CANVAS_BRIDGE_NS, id, ...payload }, origin)
    } catch (err) {
      // Without this the listener and timer outlive the rejected promise —
      // the leak would accumulate at call rate rather than being throttled.
      settle(() => reject(err instanceof Error ? err : new Error(String(err))))
    }
  })
}
