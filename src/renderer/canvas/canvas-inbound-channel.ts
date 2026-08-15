// The host's ear on the canvas content frame.
//
// The injected bridge and the page's own scripts SHARE ONE WINDOW. So
// `event.source` and `event.origin` prove exactly one thing — this message came
// from this canvas's document — and nothing about WHO in that document sent it.
// Any claim that "everything arriving here is a report about the content, never
// an instruction" is therefore only true of the events the host merely PAINTS.
//
// Three of the five inbound types are paint-only (`ready`, `viewport`,
// `pointer`): the worst a forgery does is move a highlight box, and the geometry
// guards bound it. Two MUTATE HOST STATE and are handled differently here:
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

import {
  CANVAS_BRIDGE_NS,
  type CanvasBridgeEvent,
  type CanvasHitInfo,
  type CanvasViewportInfo,
  canvasOrigin,
} from '../../shared/canvas'
import { finite, safeHit, safeViewport } from '../utils/canvas-geometry-guard'

/**
 * Namespace-matching messages per window before the channel is dropped whole.
 *
 * The bridge coalesces its own reports to one per animation frame per type, so
 * a real page sits near 180/s at 60fps with the pointer moving. Six hundred a
 * second is three times that and unreachable by anything doing real work; a
 * page that clears it is spending the host's main thread on purpose, and the
 * answer is to stop listening to it rather than to keep paying.
 */
export const INBOUND_FLOOD_BUDGET = 600
export const INBOUND_FLOOD_WINDOW_MS = 1000

export interface CanvasInboundHandlers {
  onReady: () => void
  onViewport: (viewport: CanvasViewportInfo) => void
  onPointer: (hit: CanvasHitInfo | null) => void
  /** A click the host could verify was a real user click inside the frame. */
  onContentClick: (pageX: number, pageY: number) => void
  onContentKey: (key: 'Escape' | 'ArrowUp') => void
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
 */
export function reportedKeyIsPlausible(facts: HostInputFacts): boolean {
  if (isEditableHostTarget(facts.activeElement)) return false
  if (!facts.frameElement || facts.activeElement !== facts.frameElement) return false
  return true
}

/**
 * Could this reported click have been a real one in the frame?
 *
 * Everything the key test wants, plus live user activation on the host. Fails
 * CLOSED where the platform reports no activation: a lock that the user did not
 * make is written into the review store and replayed to the agent as their
 * selection, so "cannot tell" must mean "do not lock".
 */
export function reportedClickIsPlausible(facts: HostInputFacts): boolean {
  if (!reportedKeyIsPlausible(facts)) return false
  return facts.userActivation === true
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

  let pendingViewport: CanvasViewportInfo | null = null
  let pendingPointer: { hit: CanvasHitInfo | null } | null = null
  let pendingClick: { pageX: number; pageY: number } | null = null
  let flushQueued = false

  const dispose = () => {
    if (disposed) return
    disposed = true
    window.removeEventListener('message', onMessage)
    pendingViewport = null
    pendingPointer = null
    pendingClick = null
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
      pendingViewport = null
      pendingPointer = null
      pendingClick = null
      if (viewport) handlers.onViewport(viewport)
      if (pointer) handlers.onPointer(pointer.hit)
      if (click) handlers.onContentClick(click.pageX, click.pageY)
    })
  }

  function withinBudget(): boolean {
    const now = Date.now()
    if (now - windowStartedAt >= INBOUND_FLOOD_WINDOW_MS) {
      windowStartedAt = now
      windowCount = 0
    }
    windowCount++
    return windowCount <= INBOUND_FLOOD_BUDGET
  }

  function onMessage(event: MessageEvent): void {
    if (disposed) return
    const frameWindow = options.getFrameWindow()
    if (!frameWindow || event.source !== frameWindow) return
    // Fail closed: a non-string origin (shouldn't happen) is rejected too.
    // Exact, not a prefix: another canvas's document would satisfy a prefix
    // test. Matches the snapshot path's check.
    if (event.origin !== origin) return
    const msg = event.data as CanvasBridgeEvent | null
    if (!msg || msg.ns !== CANVAS_BRIDGE_NS || !('type' in msg)) return

    if (!withinBudget()) {
      dispose()
      handlers.onFlood()
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
    }
  }

  window.addEventListener('message', onMessage)
  return dispose
}
