// The host's ear on the canvas content frame.
//
// The injected bridge and the page's own scripts SHARE ONE WINDOW. So
// `event.source` and `event.origin` prove exactly one thing — this message came
// from this canvas's document — and nothing about WHO in that document sent it.
// Any claim that "everything arriving here is a report about the content, never
// an instruction" is therefore only true of the events the host merely PAINTS.
//
// Three of the six inbound types are paint-only (`ready`, `viewport`,
// `pointer`): the worst a forgery does is move a highlight box, and the geometry
// guards bound it. `contentZoom` (#368) sits between the classes: it steps the
// pane's clamped, chrome-visible zoom ladder — it cannot write a note, a
// review, or the locked selection's IDENTITY — and is honoured only with
// host-side evidence the frame plausibly owns the gesture (pointer hover or
// keyboard focus; see reportedZoomIsPlausible for why not user activation).
// What a hostile page CAN do with it: fight the user for the camera
// (re-zooming after a Ctrl+0 — briefly; sustained fighting trips
// CONTENT_ZOOM_BUDGET and drops the channel whole) and provoke the re-anchor
// pass a real zoom would provoke — which writes page-authored, page-labelled
// BOXES into the resolution map and the live lock, exactly as any reflow does,
// under the pane's single-flight and per-intent attempt budget. Two MUTATE
// HOST STATE and are handled differently here:
//
//   `contentKey`  clears the user's locked focus / disarms an armed marquee. It
//                 is honoured only when the host can see for itself that the
//                 frame owns keyboard focus and no host editable is being typed
//                 into — the bridge has that check in-page, and the host used to
//                 take its word for it, so a forged Escape landed while the user
//                 was typing a note (adversarial review, 2026-08-14).
//
//   `contentClick` locks a focus that persists into the review store and is
//                 replayed to the agent. It is honoured only with a same-tick
//                 user-activation signal the HOST can verify, plus the same
//                 focus proof. Even then the identity in that focus is the
//                 page's report of itself, so the UI labels it as such.
//
// The second job here is rate: the frame chooses how often it speaks. Inbound
// events are coalesced to one delivery per animation frame per type (the bridge
// already throttles itself that way, so anything faster is a page spending the
// host's main thread — the renderer that wedges is the one drawing every
// terminal in the app), and past a flood budget the channel is dropped whole.
//
// The third is size, because the frame also chooses how BIG each message is.
// All five events are tiny by construction — a viewport, a hit, two coordinates,
// one of two key names — so anything that is not is refused before it is looked
// at, and charged heavily against the same budget: by the time its size is
// knowable it has already been deserialised onto the host thread, which is the
// cost, and the cost is the thing a budget is for. Size is asked as a TYPE
// question first: the protocol's whole vocabulary is objects, arrays, strings,
// numbers and booleans, and a bound that MEASURES rather than allowlists lets
// through everything it does not know how to measure — a BigInt, an
// ImageBitmap, a packed row of ArrayBuffers.

import {
  CANVAS_BRIDGE_NS,
  type CanvasBridgeEvent,
  type CanvasHitInfo,
  type CanvasViewportInfo,
  type CanvasZoomAction,
  canvasOrigin,
} from '../../shared/canvas'
import { finite, safeHit, safeViewport } from '../utils/canvas-geometry-guard'

/**
 * Budget units per window before the channel is dropped whole.
 *
 * The bridge coalesces its own reports to one per animation frame per type, so
 * a real page sits near 180/s at 60fps with the pointer moving. Six hundred a
 * second is three times that and unreachable by anything doing real work; a
 * page that clears it is spending the host's main thread on purpose, and the
 * answer is to stop listening to it rather than to keep paying.
 *
 * EVERY message the frame posts at this window is charged, and charged BEFORE
 * `event.data` is read. Both halves of that were wrong. The budget used to be
 * spent only after the `type` filter, so 50,000 messages carrying the namespace
 * and no `type` cost nothing at all and left the channel armed, while 700
 * ordinary ones tripped the drop — the stated guarantee was defeated by
 * DELETING a field. And reading `event.data` is what pays for the structured
 * clone, so a budget spent after it bounds the wrong thing (adversarial review,
 * 2026-08-15). What is charged now is "the frame spoke to us at our origin",
 * which is the event that costs the host something.
 *
 * That includes the request/response traffic canvas-frame-rpc owns, which is
 * namespaced and carries a correlation `id` instead of a `type`: one unit per
 * reply, against a path that is itself capped at four requests in flight. It
 * also includes the guessed-id replies a hostile page sprays at that path,
 * which is the point.
 *
 * A namespaced message that is NEITHER typed NOR rpc-shaped gets no such
 * exemption — it is charged the oversize cost, because "no type" was otherwise
 * a way to buy the reply path's size exemption by deleting a field rather than
 * by being a reply (adversarial re-attack, 2026-08-15).
 */
export const INBOUND_FLOOD_BUDGET = 600
export const INBOUND_FLOOD_WINDOW_MS = 1000

/**
 * What a message that fails the size bound costs, in the same units.
 *
 * Refusing one is cheap, but it has already been deserialised onto the host
 * thread by the time its size is knowable — so charging it the same unit as a
 * well-formed report would let a page send 599 megabyte payloads a second and
 * keep the channel. Sixty units means ten of them empty the budget and the
 * channel goes; nothing the protocol does ever sends one.
 */
export const INBOUND_OVERSIZE_COST = 60

/**
 * How big an inbound bridge EVENT may be, structurally.
 *
 * Nothing capped the SIZE of one before. A single `pointer` carrying a
 * 20,971,520-byte `hit.name` was accepted and dispatched: the clamp to 120
 * characters happens on the way into the STORE, long after the payload has been
 * materialised on the host thread, hung off React state and re-rendered
 * (adversarial review, 2026-08-15). Every other page-facing ingress in this
 * codebase caps bytes — MAX_DESIGN_HTML_BYTES, MAX_SKETCH_PNG_BYTES,
 * MAX_REQUEST_BODY_BYTES, the paste cap — and this one was the exception.
 *
 * The bound is STRUCTURAL rather than `JSON.stringify(msg).length`, because
 * stringifying to learn the size spends exactly the bytes the cap exists to
 * refuse. The longest string any real event carries is an element's accessible
 * name, which is clamped to 120 characters the moment it is stored, so these
 * caps sit orders of magnitude above anything legitimate and still refuse a
 * megabyte.
 */
/**
 * How many contentZoom intents the frame may have HONOURED per rolling window
 * (#368). The flood budget bounds message COUNT and is too generous to bound
 * this event's EFFECT: sixty intents a second is 10 % of the flood budget and
 * enough to re-pin the zoom after every Ctrl+0, indefinitely.
 *
 * The ceiling is set the way INBOUND_FLOOD_BUDGET's is — several times the
 * heaviest REAL rate, not just above the average one. One intent is one wheel
 * notch (the bridge accumulates deltas to notches before relaying), a hard
 * continuous spin is a handful of notches a second, and a free-spin wheel's
 * flick lands a dozen-plus at once — so a frustrated user riding the clamp can
 * genuinely produce ~100 notches in ten seconds. Three hundred is ~3× that;
 * nothing human clears it (independent review, N2). A page that does is
 * holding the camera against the user — a sustained ≥30/s stream — and gets
 * the flood budget's answer: the channel drops whole. What this deliberately
 * does NOT bound is a brief fight (a page CAN re-zoom a few times before
 * tripping it); the chrome chip, Ctrl+0 and the drop are the answer there,
 * and the resolve path it can provoke holds one RPC slot inside its own
 * attempt budget regardless. Charged only for intents that PASS the
 * plausibility gate — refused forgeries never count against a page the user
 * is not even hovering.
 */
export const CONTENT_ZOOM_BUDGET = 300
export const CONTENT_ZOOM_WINDOW_MS = 10_000

export const MAX_INBOUND_STRING_CHARS = 4096
export const MAX_INBOUND_TOTAL_CHARS = 16_384
/** Values (and keys) looked at before a message is refused for being a graph
 *  rather than a report. The largest real event, a `pointer` with a hit, is 15. */
export const MAX_INBOUND_VALUES = 64
/** Nesting the protocol uses: message → hit → box is three levels. */
export const MAX_INBOUND_DEPTH = 6

/**
 * Is this one of the five bridge events, structurally, and small enough to be?
 *
 * An ALLOWLIST of value KINDS first, then the bounded walk. That order is the
 * whole point. The first version of this bound measured size and let anything
 * it could not measure through as a zero-cost leaf, which is a denylist wearing
 * a walk's clothes, and every value the protocol does not use walked straight
 * past it (adversarial re-attack, 2026-08-15):
 *
 *   · a BigInt is a primitive, so it had no `byteLength` to read and no keys to
 *     enumerate. `2n ** (8n * 20000000n)` — twenty megabytes of magnitude —
 *     passed as ONE budget unit, and 600 of those a second were allowed;
 *   · `byteLength` and `size` were read as numbers, so `{byteLength: 'huge'}`
 *     and `{size: {}}` sailed through the check meant to catch binary;
 *   · an `ImageBitmap` reports neither: only `width`/`height`, with no
 *     enumerable own properties at all. 8192x8192 is 268 MB of backing store
 *     the walk could not see. `ImageData` and `Object.create(null)` have the
 *     same shape;
 *   · raw `ArrayBuffer`s were capped one at a time and simply PACKED — 63 of
 *     them, one under the value cap, is 1,032,192 accepted bytes per message.
 *
 * So: plain objects, arrays, strings, numbers, booleans, null and undefined —
 * which is the complete vocabulary of `CanvasBridgeEvent` — and nothing else.
 * A bigint, a symbol, a function, a typed array, a Blob, an ImageBitmap, a Map,
 * a Date, an object with a null prototype: all refused, none of them measured.
 * Numbers are admitted whatever their value: eight bytes is eight bytes, and
 * NaN/Infinity are what `finite()` exists to clean on the way to the store —
 * refusing them here would silently drop a message the geometry guard is built
 * to handle.
 *
 * Then the bounds, unchanged: values visited, nesting depth, the length of any
 * single string, the total across all of them. It answers false the moment any
 * is exceeded — so a hostile graph costs 64 steps rather than a traversal, and
 * a cycle, which postMessage carries happily, terminates for the same reason.
 *
 * Exported so the regression suite bounds the SAME function the channel runs.
 */
export function withinInboundSizeBounds(value: unknown): boolean {
  let visited = 0
  let chars = 0
  const stack: Array<[unknown, number]> = [[value, 0]]
  while (stack.length > 0) {
    const [v, depth] = stack.pop() as [unknown, number]
    if (++visited > MAX_INBOUND_VALUES) return false

    // ── The outer gate: is this a KIND of value the protocol carries at all? ──
    if (v === null || v === undefined) continue
    const kind = typeof v
    if (kind === 'boolean' || kind === 'number') continue
    if (kind === 'string') {
      const text = v as string
      if (text.length > MAX_INBOUND_STRING_CHARS) return false
      chars += text.length
      if (chars > MAX_INBOUND_TOTAL_CHARS) return false
      continue
    }
    // bigint, symbol, function — none of them appear in any bridge event, and
    // the first of them is the twenty-megabyte primitive this gate exists for.
    if (kind !== 'object') return false
    if (depth >= MAX_INBOUND_DEPTH) return false

    if (Array.isArray(v)) {
      if (v.length > MAX_INBOUND_VALUES) return false
      for (const item of v) {
        if (stack.length >= MAX_INBOUND_VALUES) return false
        stack.push([item, depth + 1])
      }
      continue
    }

    // An ordinary `{...}` and nothing else. Structured clone rebuilds plain
    // objects in the RECEIVING realm, so a genuine event's prototype is this
    // realm's `Object.prototype`; everything a page could hand us that is not
    // one — a Blob, a typed array, an ImageBitmap, a MessagePort, a
    // null-prototype object — lands here and is refused rather than treated as
    // an empty leaf.
    if (Object.getPrototypeOf(v) !== Object.prototype) return false
    for (const key in v as Record<string, unknown>) {
      if (key.length > MAX_INBOUND_STRING_CHARS) return false
      chars += key.length
      if (chars > MAX_INBOUND_TOTAL_CHARS) return false
      // Checked before the push, so a million-key object is abandoned in 64
      // steps instead of having its keys materialised.
      if (stack.length >= MAX_INBOUND_VALUES) return false
      stack.push([(v as Record<string, unknown>)[key], depth + 1])
    }
  }
  return true
}

export interface CanvasInboundHandlers {
  onReady: () => void
  onViewport: (viewport: CanvasViewportInfo) => void
  onPointer: (hit: CanvasHitInfo | null) => void
  /** A click the host could verify was a real user click inside the frame. */
  onContentClick: (pageX: number, pageY: number) => void
  onContentKey: (key: 'Escape' | 'ArrowUp') => void
  /** Zoom intent relayed from the frame (#368), coalesced per animation frame:
   *  `steps` is the net ladder movement (+in / −out), `reset` wins over steps. */
  onContentZoom: (intent: { steps: number; reset: boolean }) => void
  /** The page exceeded the flood budget: the channel is gone for this frame. */
  onFlood: () => void
}

export interface CanvasInboundChannelOptions {
  canvasId: string
  /** Read at event time — the frame's window changes on reload. */
  getFrameWindow: () => Window | null
  /** The iframe ELEMENT. This is the host's own evidence about focus: when the
   *  user is typing inside the frame, the HOST document's active element is
   *  this iframe, and when they are typing in the notes panel it is not. */
  getFrameElement: () => Element | null
  handlers: CanvasInboundHandlers
}

/** The host's half of the bridge's own "not from an editable" rule. The host
 *  cannot see inside the frame, but it can see its OWN focused element — which
 *  is where the note the user is typing lives. */
function isEditableHostTarget(el: Element | null): boolean {
  if (!el) return false
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return true
  return (el as HTMLElement).isContentEditable === true
}

/**
 * Transient user activation on the HOST window, or `null` where the platform
 * does not report it.
 *
 * A genuine click inside the frame propagates activation to its ancestors, so
 * the host sees it; a `postMessage` from a page script does not. This is the
 * one signal that separates the two, and it is read from the host's own
 * navigator — nothing the frame sends can set it.
 */
function hostUserActivation(): boolean | null {
  const ua = (navigator as Navigator & { userActivation?: { isActive?: unknown } }).userActivation
  if (!ua || typeof ua.isActive !== 'boolean') return null
  return ua.isActive
}

export interface HostInputFacts {
  /** The HOST document's active element. */
  activeElement: Element | null
  /** The canvas iframe element, or null when the pane has none. */
  frameElement: Element | null
  /** Host transient user activation; `null` = the platform does not report it. */
  userActivation: boolean | null
}

/**
 * Could this reported keystroke have been a real one in the frame?
 *
 * A keystroke inside the frame requires the frame to hold keyboard focus, which
 * in the HOST document means its iframe is the active element. If the host is
 * focused on its own chrome — the notes composer, a button — the frame did not
 * receive that key, so a report of one is a forgery and is dropped. The editable
 * test is stated separately from the identity test even though the second
 * implies the first: it is the host-side half of the bridge's own rule, and the
 * failure it exists to stop (a forged Escape wiping a locked selection while the
 * user types a note) is worth being unable to delete by accident.
 *
 * And a keystroke is a GESTURE, so the host requires the same live user
 * activation the click gate does. Focus alone was never a gesture: once the user
 * had clicked into the frame even once, the page could post `Escape` or
 * `ArrowUp` at any later moment with no input at all — clearing the locked
 * focus, disarming an armed marquee, or silently walking the pending selection
 * up to a parent in the instant before the user wrote a note against it. Forged
 * keys were honoured with activation forced false AND with the property deleted
 * entirely (adversarial review, 2026-08-15). Fails CLOSED where the platform
 * reports no activation, for the same reason the click gate does.
 */
export function reportedKeyIsPlausible(facts: HostInputFacts): boolean {
  if (isEditableHostTarget(facts.activeElement)) return false
  if (!facts.frameElement || facts.activeElement !== facts.frameElement) return false
  return facts.userActivation === true
}

/**
 * Could this reported click have been a real one in the frame?
 *
 * Everything the key test wants — which since 2026-08-15 includes the live user
 * activation the two gates now share. Said again here rather than inherited: a
 * lock the user did not make is written into the review store and replayed to
 * the agent as their selection, so if the key gate is ever loosened this one
 * must not quietly follow it.
 */
export function reportedClickIsPlausible(facts: HostInputFacts): boolean {
  if (!reportedKeyIsPlausible(facts)) return false
  return facts.userActivation === true
}

/**
 * Could this reported zoom intent have been a real gesture in the frame (#368)?
 *
 * A wheel needs the POINTER over the frame, not keyboard focus, and the host's
 * own evidence for that is `:hover` on its iframe element; the zoom chords need
 * the frame to own keyboard focus, exactly as `contentKey` does. Either
 * suffices. Deliberately weaker than the key/click gates — no user-activation
 * requirement (a wheel is not an activation-triggering input, so that gate
 * would drop every genuine first gesture) and no editable-target refusal (the
 * pointer resting on the frame while the user types a note is a REAL zoom
 * posture — wheel over the page, draft open — and refusing it breaks the
 * feature where it is most used).
 *
 * What that buys an attacker is stated where it is bounded: the header above
 * and CONTENT_ZOOM_BUDGET. A forged intent moves a clamped, chrome-visible
 * camera and provokes bounded host work; it cannot touch the review store, the
 * locked selection's identity, or anything persisted.
 */
export function reportedZoomIsPlausible(facts: Pick<HostInputFacts, 'activeElement' | 'frameElement'>): boolean {
  if (!facts.frameElement) return false
  if (facts.activeElement === facts.frameElement) return true
  try {
    return facts.frameElement.matches(':hover')
  } catch {
    return false
  }
}

function nextFrame(run: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => run())
  else setTimeout(run, 16)
}

/**
 * Arm the channel for one frame. Returns the disposer; call it on unmount or
 * when the frame is replaced.
 */
export function createCanvasInboundChannel(options: CanvasInboundChannelOptions): () => void {
  const origin = canvasOrigin(options.canvasId)
  const { handlers } = options
  let disposed = false

  let windowStartedAt = Date.now()
  let windowCount = 0
  // contentZoom's own rolling window (#368) — see CONTENT_ZOOM_BUDGET.
  let zoomWindowStartedAt = Date.now()
  let zoomWindowCount = 0

  let pendingViewport: CanvasViewportInfo | null = null
  let pendingPointer: { hit: CanvasHitInfo | null } | null = null
  let pendingClick: { pageX: number; pageY: number } | null = null
  let pendingZoom: { steps: number; reset: boolean } | null = null
  let flushQueued = false

  const dispose = () => {
    if (disposed) return
    disposed = true
    window.removeEventListener('message', onMessage)
    pendingViewport = null
    pendingPointer = null
    pendingClick = null
    pendingZoom = null
  }

  // Latest wins. A page that reports twice inside one frame gets one delivery,
  // and the delivery it gets is the newer of the two — which is what the older
  // one would have been overwritten by anyway.
  const queueFlush = () => {
    if (flushQueued) return
    flushQueued = true
    nextFrame(() => {
      flushQueued = false
      if (disposed) return
      const viewport = pendingViewport
      const pointer = pendingPointer
      const click = pendingClick
      const zoom = pendingZoom
      pendingViewport = null
      pendingPointer = null
      pendingClick = null
      pendingZoom = null
      if (viewport) handlers.onViewport(viewport)
      if (pointer) handlers.onPointer(pointer.hit)
      if (click) handlers.onContentClick(click.pageX, click.pageY)
      if (zoom && (zoom.reset || zoom.steps !== 0)) handlers.onContentZoom(zoom)
    })
  }

  /** Spend `cost` units of this window's budget. False once it is gone. */
  function charge(cost: number): boolean {
    const now = Date.now()
    if (now - windowStartedAt >= INBOUND_FLOOD_WINDOW_MS) {
      windowStartedAt = now
      windowCount = 0
    }
    windowCount += cost
    return windowCount <= INBOUND_FLOOD_BUDGET
  }

  const dropFlooded = () => {
    dispose()
    handlers.onFlood()
  }

  function onMessage(event: MessageEvent): void {
    if (disposed) return
    const frameWindow = options.getFrameWindow()
    if (!frameWindow || event.source !== frameWindow) return
    // Fail closed: a non-string origin (shouldn't happen) is rejected too.
    // Exact, not a prefix: another canvas's document would satisfy a prefix
    // test. Matches the snapshot path's check.
    if (event.origin !== origin) return

    // Charged HERE — before `event.data` is touched, and before anything about
    // the message's shape has been believed. Reading `data` is what pays for the
    // structured clone, and a namespaced message with no `type` is still the
    // frame spending the host's thread; charging after either test is what let
    // 50,000 of them cost nothing.
    if (!charge(1)) {
      dropFlooded()
      return
    }

    const msg = event.data as CanvasBridgeEvent | null
    if (!msg || msg.ns !== CANVAS_BRIDGE_NS) return
    // Request/response traffic (canvas-frame-rpc) is namespaced and carries a
    // correlation `id` instead of a `type`. It has its own listener, its own cap
    // on requests in flight and its own sanitisers, and a snapshot reply is
    // legitimately large — so it leaves here having paid its unit and is not
    // size-checked against an EVENT's bounds.
    //
    // But only if it is SHAPED like one. Anything namespaced that is neither
    // typed nor rpc-shaped is garbage no version of this protocol emits, and
    // returning at one unit handed it the same "legitimately large" exemption
    // the reply path has: dropping a single field bought a page 600 unbounded
    // messages a second, which is the exemption and not the budget
    // (adversarial re-attack, 2026-08-15). Charged as oversize instead — the
    // deserialise has happened either way, and that cost is what the budget is
    // for. The residual is honest and deliberate: a page that adds `id: 1` is
    // back to a unit apiece, and what bounds THAT is canvas-frame-rpc's cap of
    // four requests in flight plus its random correlation ids.
    if (!('type' in msg)) {
      const id = (msg as { id?: unknown }).id
      if (typeof id === 'number' && Number.isFinite(id)) return
      if (!charge(INBOUND_OVERSIZE_COST - 1)) dropFlooded()
      return
    }

    // Refused before any of it is read into host state. The clamp in
    // safeHit/safeViewport happens on the way to the STORE, which is far too
    // late to be the only bound on what the page may hand us.
    if (!withinInboundSizeBounds(msg)) {
      // One unit is already spent; the rest is what having to deserialise it
      // cost. Ten of these and the channel is gone.
      if (!charge(INBOUND_OVERSIZE_COST - 1)) dropFlooded()
      return
    }

    if (msg.type === 'ready') {
      handlers.onReady()
      return
    }
    if (msg.type === 'viewport') {
      pendingViewport = safeViewport(msg.viewport)
      queueFlush()
      return
    }
    if (msg.type === 'pointer') {
      pendingPointer = { hit: msg.hit ? safeHit(msg.hit) : null }
      queueFlush()
      return
    }
    if (msg.type === 'contentClick') {
      // Checked HERE, on arrival, not at flush: user activation is what makes
      // this a report of something that just happened, and a later tick is a
      // different claim.
      if (
        !reportedClickIsPlausible({
          activeElement: document.activeElement,
          frameElement: options.getFrameElement(),
          userActivation: hostUserActivation(),
        })
      ) {
        return
      }
      pendingClick = {
        pageX: finite((msg as { pageX?: unknown }).pageX, 0),
        pageY: finite((msg as { pageY?: unknown }).pageY, 0),
      }
      queueFlush()
      return
    }
    if (msg.type === 'contentKey') {
      const key = (msg as { key?: unknown }).key
      if (key !== 'Escape' && key !== 'ArrowUp') return
      if (
        !reportedKeyIsPlausible({
          activeElement: document.activeElement,
          frameElement: options.getFrameElement(),
          userActivation: hostUserActivation(),
        })
      ) {
        return
      }
      handlers.onContentKey(key)
      return
    }
    if (msg.type === 'contentZoom') {
      // A closed vocabulary, checked on arrival like every other field the
      // page authors; anything else in `action` is not a report this protocol
      // emits and is dropped unread.
      const action = (msg as { action?: unknown }).action as CanvasZoomAction | unknown
      if (action !== 'in' && action !== 'out' && action !== 'reset') return
      // Gated on arrival (like the click gate): hover/focus is evidence about
      // NOW, and a later tick is a different claim.
      if (
        !reportedZoomIsPlausible({
          activeElement: document.activeElement,
          frameElement: options.getFrameElement(),
        })
      ) {
        return
      }
      // This event's own budget (#368): past it the page is not zooming, it is
      // fighting the user for the camera — a pinned zoom outlives every Ctrl+0
      // — or farming the host work a zoom change triggers. Same answer as the
      // flood budget, because it is the same offence at a rate that budget
      // cannot see.
      const now = Date.now()
      if (now - zoomWindowStartedAt >= CONTENT_ZOOM_WINDOW_MS) {
        zoomWindowStartedAt = now
        zoomWindowCount = 0
      }
      if (++zoomWindowCount > CONTENT_ZOOM_BUDGET) {
        dropFlooded()
        return
      }
      const current = pendingZoom ?? { steps: 0, reset: false }
      if (action === 'reset') {
        // Reset wins over whatever steps were queued beside it this frame.
        pendingZoom = { steps: 0, reset: true }
      } else if (!current.reset) {
        // Net movement, bounded well past the ladder's full sweep — the frame
        // chooses how often it speaks, not how far the host walks.
        const steps = Math.max(-16, Math.min(16, current.steps + (action === 'in' ? 1 : -1)))
        pendingZoom = { steps, reset: false }
      }
      queueFlush()
      return
    }
  }

  window.addEventListener('message', onMessage)
  return dispose
}
