// One request/response call into the canvas content frame.
//
// Extracted from canvas-snapshot-host so the P3 surfaces (inspect on click,
// resolveAnchors for the checklist) ride the SAME hardened path the snapshot
// does rather than a hand-copied variant that drifts: random correlation ids
// (a counter let a hostile page answer before the real bridge), source AND
// origin checked on every reply (a frame's window identity survives
// navigation), targeted postMessage (a request can never be delivered to a
// document that is not this canvas's), full listener/timer cleanup on every
// exit path, and a hard cap on how many requests may be outstanding to one
// frame — cleanup alone is not a bound when the CALL RATE is the page's to
// choose (see MAX_FRAME_REQUESTS_IN_FLIGHT).

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
 * How many requests may be OUTSTANDING to one frame at a time.
 *
 * Cleanup on reply/timeout is not a bound: a caller driven by the frame's own
 * messages issues the next request before the last one settles, so the listeners
 * accumulate at the page's chosen rate rather than being throttled by anything.
 * The adversarial pass drove 500 forged clicks into the pane and got 500 live
 * `message` listeners, each holding a timer and a pending promise — after which
 * EVERY message on the host window is dispatched to all of them, so the cost of
 * the next forgery grows with the number already sent (adversarial review,
 * 2026-08-14).
 *
 * Four is above anything the product does (snapshot, inspect, resolveAnchors —
 * never more than one of each at once) and turns an unbounded leak into a
 * constant. Over the cap the request is refused BEFORE a listener exists.
 */
export const MAX_FRAME_REQUESTS_IN_FLIGHT = 4

/** Per-frame outstanding-request count. Weak so a closed pane's window is not
 *  kept alive by its bookkeeping. */
const inFlightByFrame = new WeakMap<Window, number>()

/** Outstanding requests to `target`. Exported so the regression suite counts
 *  what the module actually holds rather than a mirror of it. */
export function framesInFlight(target: Window): number {
  return inFlightByFrame.get(target) ?? 0
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
  // Refused BEFORE anything is allocated: over the cap there is no listener, no
  // timer and no pending promise to leak. `in flight` is the word the tool
  // layer's failure vocabulary already matches on.
  if (framesInFlight(target) >= MAX_FRAME_REQUESTS_IN_FLIGHT) {
    return Promise.reject(
      new Error(`Too many canvas frame requests are already in flight; the ${payload.type} request was dropped.`),
    )
  }
  inFlightByFrame.set(target, framesInFlight(target) + 1)

  const id = bridgeRequestId()
  const origin = canvasOrigin(canvasId)
  return new Promise((resolve, reject) => {
    // One settle per request. Not reachable today — the first settle removes
    // the listener and clears the timer, so nothing can call it again — and
    // said plainly here rather than dressed up as a live defence: the counter
    // below is what the cap rests on, a double decrement would widen the cap
    // for every later call, and that invariant should not depend on a reader
    // re-deriving the unreachability every time this function is edited.
    let settled = false
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      inFlightByFrame.set(target, Math.max(0, framesInFlight(target) - 1))
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
