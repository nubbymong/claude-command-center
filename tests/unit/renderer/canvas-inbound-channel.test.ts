// @vitest-environment jsdom
//
// The host's ear on the canvas content frame (adversarial review, 2026-08-14).
//
// Two findings live here. The page script and the injected bridge share one
// window, so `event.source`/`event.origin` cannot tell them apart: a page could
// forge the two inbound events that MUTATE host state — a `contentKey` that
// wiped the user's locked selection while they typed a note, and a
// `contentClick` that (with a page-authored `inspect` reply) locked a focus of
// the page's choosing, which then persisted into the review store and was
// replayed to the agent as the user's selection. And the channel was unbounded:
// 500 forged clicks meant 500 accumulated listeners and one full re-render per
// message.
//
// Everything below drives the PRODUCTION channel with real jsdom focus and real
// `navigator.userActivation` — no mirror of the gate to drift green.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  createCanvasInboundChannel,
  reportedKeyIsPlausible,
  withinInboundSizeBounds,
  INBOUND_FLOOD_BUDGET,
  INBOUND_OVERSIZE_COST,
  MAX_INBOUND_STRING_CHARS,
  MAX_INBOUND_VALUES,
  type CanvasInboundHandlers,
} from '../../../src/renderer/canvas/canvas-inbound-channel'
import { CANVAS_BRIDGE_NS } from '../../../src/shared/canvas'

const CANVAS_ID = 'canvas-1'
const ORIGIN = `ccc-ux://${CANVAS_ID}`

let iframe: HTMLIFrameElement
let composer: HTMLTextAreaElement
let handlers: CanvasInboundHandlers
let dispose: (() => void) | null = null
/** Live 'message' listeners on the host window — counted, not modelled. */
let messageListeners: number

function makeHandlers(): CanvasInboundHandlers {
  return {
    onReady: vi.fn(),
    onViewport: vi.fn(),
    onPointer: vi.fn(),
    onContentClick: vi.fn(),
    onContentKey: vi.fn(),
    onFlood: vi.fn(),
  }
}

function arm(): void {
  dispose = createCanvasInboundChannel({
    canvasId: CANVAS_ID,
    getFrameWindow: () => iframe.contentWindow,
    getFrameElement: () => iframe,
    handlers,
  })
}

function fromFrame(body: Record<string, unknown>, origin = ORIGIN): void {
  window.dispatchEvent(
    new MessageEvent('message', { data: { ns: CANVAS_BRIDGE_NS, ...body }, source: iframe.contentWindow, origin }),
  )
}

/** Whatever the page likes, with no namespace stamped on it — the traffic that
 *  used to reach the host for free. */
function rawFromFrame(data: unknown, origin = ORIGIN): void {
  window.dispatchEvent(new MessageEvent('message', { data, source: iframe.contentWindow, origin }))
}

/** Let the channel's per-frame flush run. */
function flushFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0))
    else setTimeout(resolve, 25)
  })
}

function setUserActivation(active: boolean | undefined): void {
  if (active === undefined) {
    Reflect.deleteProperty(navigator as object, 'userActivation')
    return
  }
  Object.defineProperty(navigator, 'userActivation', {
    value: { isActive: active, hasBeenActive: active },
    configurable: true,
    writable: true,
  })
}

const realAdd = window.addEventListener.bind(window)
const realRemove = window.removeEventListener.bind(window)

beforeEach(() => {
  document.body.innerHTML = ''
  iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  composer = document.createElement('textarea')
  document.body.appendChild(composer)
  handlers = makeHandlers()
  messageListeners = 0
  window.addEventListener = ((type: string, fn: never, opts: never) => {
    if (type === 'message') messageListeners++
    return realAdd(type, fn, opts)
  }) as typeof window.addEventListener
  window.removeEventListener = ((type: string, fn: never, opts: never) => {
    if (type === 'message') messageListeners--
    return realRemove(type, fn, opts)
  }) as typeof window.removeEventListener
  setUserActivation(true)
})

afterEach(() => {
  dispose?.()
  dispose = null
  window.addEventListener = realAdd
  window.removeEventListener = realRemove
  setUserActivation(undefined)
})

describe('jsdom really moves host focus (the gate rests on this)', () => {
  it('focusing the iframe makes it the host document active element; focusing the composer takes it back', () => {
    iframe.focus()
    expect(document.activeElement).toBe(iframe)
    composer.focus()
    expect(document.activeElement).toBe(composer)
  })
})

describe('a forged contentKey cannot mutate host state', () => {
  it('is dropped while the user is typing in the host (the composer holds focus)', () => {
    arm()
    composer.focus()
    fromFrame({ type: 'contentKey', key: 'Escape' })
    expect(handlers.onContentKey).not.toHaveBeenCalled()
  })

  it('is dropped when the frame does not hold host keyboard focus at all', () => {
    arm()
    composer.focus()
    composer.blur()
    expect(document.activeElement).not.toBe(iframe)
    fromFrame({ type: 'contentKey', key: 'Escape' })
    fromFrame({ type: 'contentKey', key: 'ArrowUp' })
    expect(handlers.onContentKey).not.toHaveBeenCalled()
  })

  // Focus is not a gesture. The frame having been clicked into ONCE left the
  // page free to post either key at any later moment — the measured forgery
  // landed both with activation forced false and with the property deleted
  // outright, clearing a locked focus / disarming an armed marquee / walking the
  // pending selection to a parent right before a note was written against it
  // (adversarial review, 2026-08-15).
  it('is dropped without live user activation, even with the frame focused', () => {
    arm()
    iframe.focus()
    setUserActivation(false)
    fromFrame({ type: 'contentKey', key: 'Escape' })
    fromFrame({ type: 'contentKey', key: 'ArrowUp' })
    expect(handlers.onContentKey).not.toHaveBeenCalled()
  })

  it('fails CLOSED where the platform reports no user activation at all', () => {
    arm()
    iframe.focus()
    setUserActivation(undefined)
    fromFrame({ type: 'contentKey', key: 'Escape' })
    fromFrame({ type: 'contentKey', key: 'ArrowUp' })
    expect(handlers.onContentKey).not.toHaveBeenCalled()
  })

  it('is honoured when the frame genuinely holds host keyboard focus', () => {
    arm()
    iframe.focus()
    fromFrame({ type: 'contentKey', key: 'Escape' })
    expect(handlers.onContentKey).toHaveBeenCalledWith('Escape')
  })

  it('relays only the two navigation keys, never arbitrary ones', () => {
    arm()
    iframe.focus()
    fromFrame({ type: 'contentKey', key: 'a' })
    fromFrame({ type: 'contentKey', key: 'Enter' })
    expect(handlers.onContentKey).not.toHaveBeenCalled()
  })

  // The identity rule ("the frame is the active element") happens to cover the
  // composer case too, so the host-side editable rule needs its own proof or it
  // is a clause nothing can fail — the mirror of the bridge's in-page check, and
  // the one whose absence let a forged Escape land mid-note.
  it('refuses a reported key whenever a host editable holds focus, whatever else is true', () => {
    const editable = document.createElement('textarea')
    expect(reportedKeyIsPlausible({ activeElement: editable, frameElement: editable, userActivation: true })).toBe(false)
    for (const tag of ['input', 'select']) {
      const el = document.createElement(tag)
      expect(reportedKeyIsPlausible({ activeElement: el, frameElement: el, userActivation: true })).toBe(false)
    }
    // …and a non-editable element that IS the frame is fine.
    expect(reportedKeyIsPlausible({ activeElement: iframe, frameElement: iframe, userActivation: true })).toBe(true)
  })

  it('refuses a reported key with no live activation, whatever the focus says', () => {
    expect(reportedKeyIsPlausible({ activeElement: iframe, frameElement: iframe, userActivation: false })).toBe(false)
    expect(reportedKeyIsPlausible({ activeElement: iframe, frameElement: iframe, userActivation: null })).toBe(false)
  })
})

describe('a forged contentClick cannot lock a focus', () => {
  it('is dropped without live user activation, even with the frame focused', async () => {
    arm()
    iframe.focus()
    setUserActivation(false)
    fromFrame({ type: 'contentClick', pageX: 10, pageY: 20 })
    await flushFrame()
    expect(handlers.onContentClick).not.toHaveBeenCalled()
  })

  it('is dropped when the host is focused elsewhere, even with activation live', async () => {
    arm()
    composer.focus()
    setUserActivation(true)
    fromFrame({ type: 'contentClick', pageX: 10, pageY: 20 })
    await flushFrame()
    expect(handlers.onContentClick).not.toHaveBeenCalled()
  })

  it('fails CLOSED where the platform reports no user activation at all', async () => {
    arm()
    iframe.focus()
    setUserActivation(undefined)
    fromFrame({ type: 'contentClick', pageX: 10, pageY: 20 })
    await flushFrame()
    expect(handlers.onContentClick).not.toHaveBeenCalled()
  })

  it('takes a click the host can vouch for: frame focused and activation live', async () => {
    arm()
    iframe.focus()
    setUserActivation(true)
    fromFrame({ type: 'contentClick', pageX: 10, pageY: 20 })
    await flushFrame()
    expect(handlers.onContentClick).toHaveBeenCalledWith(10, 20)
  })

  it('finite-guards the reported point', async () => {
    arm()
    iframe.focus()
    fromFrame({ type: 'contentClick', pageX: Number.NaN, pageY: 'boom' })
    await flushFrame()
    expect(handlers.onContentClick).toHaveBeenCalledWith(0, 0)
  })
})

describe('paint-only reports still arrive', () => {
  it('ready is immediate; viewport and pointer arrive guarded', async () => {
    arm()
    fromFrame({ type: 'ready' })
    expect(handlers.onReady).toHaveBeenCalledTimes(1)

    fromFrame({ type: 'viewport', viewport: { scrollX: Number.NaN, scrollY: 5, width: 10, height: 10, dpr: 0, scale: 0 } })
    fromFrame({ type: 'pointer', hit: { role: 'button', name: 'Save', tag: 'button', box: { x: 1, y: 2, width: 3, height: 4 } } })
    await flushFrame()
    expect(handlers.onViewport).toHaveBeenCalledWith({ scrollX: 0, scrollY: 5, width: 10, height: 10, dpr: 1, scale: 1 })
    expect(handlers.onPointer).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'button', name: 'Save', box: { x: 1, y: 2, width: 3, height: 4 } }),
    )
  })

  it('ignores a foreign source and a foreign origin', () => {
    arm()
    iframe.focus()
    window.dispatchEvent(new MessageEvent('message', { data: { ns: CANVAS_BRIDGE_NS, type: 'ready' }, source: window }))
    fromFrame({ type: 'ready' }, 'ccc-ux://canvas-someone-else')
    fromFrame({ type: 'ready' }, 'null')
    expect(handlers.onReady).not.toHaveBeenCalled()
  })
})

describe('the frame cannot spend the host main thread', () => {
  it('coalesces a burst of clicks to ONE delivery per animation frame', async () => {
    arm()
    iframe.focus()
    for (let i = 0; i < 500; i++) fromFrame({ type: 'contentClick', pageX: i, pageY: i })
    // Nothing is delivered synchronously: the burst cannot drive 500 inspects.
    expect(handlers.onContentClick).not.toHaveBeenCalled()
    await flushFrame()
    expect(handlers.onContentClick).toHaveBeenCalledTimes(1)
    expect(handlers.onContentClick).toHaveBeenCalledWith(499, 499)
  })

  it('schedules ONE flush per frame, not one per message', async () => {
    // Delivery is already coalesced by latest-wins, so the count of frames the
    // channel ASKS FOR is the thing that says whether a burst costs the host
    // anything. 500 messages must buy the page exactly one callback.
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    arm()
    iframe.focus()
    for (let i = 0; i < 500; i++) fromFrame({ type: 'contentClick', pageX: i, pageY: i })
    expect(raf).toHaveBeenCalledTimes(1)
    await flushFrame()
    raf.mockRestore()
  })

  it('never replays a delivered click on a later flush', async () => {
    arm()
    iframe.focus()
    fromFrame({ type: 'contentClick', pageX: 7, pageY: 7 })
    await flushFrame()
    expect(handlers.onContentClick).toHaveBeenCalledTimes(1)
    // A later, unrelated report must not carry the old click along with it — a
    // phantom re-lock is a selection the user did not make.
    fromFrame({ type: 'pointer', hit: null })
    await flushFrame()
    expect(handlers.onContentClick).toHaveBeenCalledTimes(1)
  })

  it('coalesces viewport and pointer the same way — one re-render, not five hundred', async () => {
    arm()
    for (let i = 0; i < 300; i++) {
      fromFrame({ type: 'viewport', viewport: { scrollX: i, scrollY: 0, width: 1, height: 1, dpr: 1, scale: 1 } })
      fromFrame({ type: 'pointer', hit: null })
    }
    await flushFrame()
    expect(handlers.onViewport).toHaveBeenCalledTimes(1)
    expect(handlers.onPointer).toHaveBeenCalledTimes(1)
  })

  it('holds exactly ONE host listener however many messages arrive', async () => {
    arm()
    iframe.focus()
    const armed = messageListeners
    for (let i = 0; i < 500; i++) fromFrame({ type: 'contentClick', pageX: i, pageY: i })
    await flushFrame()
    expect(armed).toBe(1)
    expect(messageListeners).toBe(1)
  })

  it('drops the channel whole past the flood budget and stops listening', async () => {
    arm()
    iframe.focus()
    for (let i = 0; i < INBOUND_FLOOD_BUDGET + 5; i++) fromFrame({ type: 'pointer', hit: null })
    expect(handlers.onFlood).toHaveBeenCalledTimes(1)
    expect(messageListeners).toBe(0)

    // Nothing gets through afterwards — not even a well-formed report.
    fromFrame({ type: 'ready' })
    fromFrame({ type: 'contentKey', key: 'Escape' })
    await flushFrame()
    expect(handlers.onReady).not.toHaveBeenCalled()
    expect(handlers.onContentKey).not.toHaveBeenCalled()
  })

  it('a normal page stays well under the budget and is never dropped', async () => {
    arm()
    iframe.focus()
    // 60fps of viewport + pointer + a click for a whole second.
    for (let i = 0; i < 60; i++) {
      fromFrame({ type: 'viewport', viewport: { scrollX: i, scrollY: 0, width: 1, height: 1, dpr: 1, scale: 1 } })
      fromFrame({ type: 'pointer', hit: null })
    }
    fromFrame({ type: 'contentClick', pageX: 1, pageY: 1 })
    await flushFrame()
    expect(handlers.onFlood).not.toHaveBeenCalled()
    expect(handlers.onViewport).toHaveBeenCalledTimes(1)
  })

  it('the disposer removes the listener and cancels a pending flush', async () => {
    arm()
    iframe.focus()
    fromFrame({ type: 'contentClick', pageX: 1, pageY: 1 })
    dispose!()
    dispose = null
    expect(messageListeners).toBe(0)
    await flushFrame()
    expect(handlers.onContentClick).not.toHaveBeenCalled()
  })
})

// ── The budget cannot be dodged by DELETING a field ──────────────────────────
// The budget used to be spent only after the `type` filter, so a message that
// carried the namespace and no `type` was free: 50,000 of them produced
// flooded=0 and left the channel armed, while 700 well-formed ones tripped the
// drop exactly as documented. The stated guarantee — "past 600 namespace
// messages in a second the channel is dropped whole" — was defeated by omitting
// one field (adversarial review, 2026-08-15).
describe('every message the frame sends is charged, whatever shape it is', () => {
  it('drops the channel on namespaced traffic carrying NO type at all', () => {
    arm()
    iframe.focus()
    for (let i = 0; i < INBOUND_FLOOD_BUDGET + 5; i++) fromFrame({ id: i, ok: true, result: {} })
    expect(handlers.onFlood).toHaveBeenCalledTimes(1)
    expect(messageListeners).toBe(0)

    // …and the channel really is gone, not merely reported.
    fromFrame({ type: 'ready' })
    expect(handlers.onReady).not.toHaveBeenCalled()
  })

  it('drops the channel on a burst that is not even in the namespace', () => {
    arm()
    for (let i = 0; i < INBOUND_FLOOD_BUDGET + 5; i++) rawFromFrame({ hello: i })
    expect(handlers.onFlood).toHaveBeenCalledTimes(1)
    expect(messageListeners).toBe(0)
  })

  it('leaves the low-volume request/response traffic alone', () => {
    // canvas-frame-rpc's replies are namespaced with an id and no type, and are
    // capped at four in flight. They cost a unit each and nothing more.
    arm()
    for (let i = 0; i < 40; i++) fromFrame({ id: i, ok: true, result: { chain: [] } })
    expect(handlers.onFlood).not.toHaveBeenCalled()
    expect(messageListeners).toBe(1)
  })

  // ── "No type" was buying the reply path's size exemption ───────────────────
  // A namespaced message with no `type` returns before the size bound and was
  // charged ONE unit, so the cheapest way to send an unbounded payload 600
  // times a second was to DELETE a field rather than to be a reply. A real
  // canvas-frame-rpc reply carries a numeric correlation id; a message with
  // neither is garbage no version of this protocol emits, and is charged what
  // deserialising it cost (adversarial re-attack, 2026-08-15).
  it('charges a namespaced message that is neither typed nor rpc-shaped as oversize', () => {
    arm()
    const trips = Math.floor(INBOUND_FLOOD_BUDGET / INBOUND_OVERSIZE_COST) + 1
    // Well under the 601 a one-unit charge would have needed.
    expect(trips).toBeLessThan(INBOUND_FLOOD_BUDGET)
    for (let i = 0; i < trips - 1; i++) fromFrame({ ok: true, result: {}, pad: 'x'.repeat(1000) })
    expect(handlers.onFlood).not.toHaveBeenCalled()
    fromFrame({ ok: true, result: {}, pad: 'x'.repeat(1000) })
    expect(handlers.onFlood).toHaveBeenCalledTimes(1)
    expect(messageListeners).toBe(0)
  })

  it('a non-numeric id does not buy the reply path either', () => {
    arm()
    const trips = Math.floor(INBOUND_FLOOD_BUDGET / INBOUND_OVERSIZE_COST) + 1
    for (let i = 0; i < trips; i++) fromFrame({ id: `${i}`, ok: true, result: {} })
    expect(handlers.onFlood).toHaveBeenCalledTimes(1)
  })

  it('does NOT break the genuine reply path: rpc-shaped replies still cost one unit', () => {
    // Far more than the handful an oversize charge would allow, and legitimately
    // larger than an event — this is the path a snapshot comes back on.
    arm()
    for (let i = 0; i < 200; i++) fromFrame({ id: i, ok: true, result: { chain: [], big: 'x'.repeat(2000) } })
    expect(handlers.onFlood).not.toHaveBeenCalled()
    expect(messageListeners).toBe(1)
  })
})

// ── Size (adversarial review, 2026-08-15) ────────────────────────────────────
// Nothing capped how BIG an inbound message could be: a single `pointer`
// carrying a 20,971,520-byte `hit.name` was accepted and dispatched, because the
// clamp to 120 characters happens on the way into the STORE — long after the
// payload has been materialised on the host thread and hung off React state.
describe('an inbound message has a size bound', () => {
  const oversizedName = (): string => 'a'.repeat(MAX_INBOUND_STRING_CHARS + 1)
  const hitWith = (name: string): Record<string, unknown> => ({
    role: 'button',
    name,
    tag: 'button',
    box: { x: 1, y: 2, width: 3, height: 4 },
  })

  it('refuses a pointer whose reported name is a megabyte, instead of dispatching it', async () => {
    arm()
    fromFrame({ type: 'pointer', hit: hitWith('a'.repeat(2 * 1024 * 1024)) })
    await flushFrame()
    expect(handlers.onPointer).not.toHaveBeenCalled()
  })

  it('refuses an oversized viewport, click and key just the same', async () => {
    arm()
    iframe.focus()
    fromFrame({ type: 'viewport', viewport: { scrollX: 0, scrollY: 0, width: 1, height: 1, dpr: 1, scale: 1, pad: oversizedName() } })
    fromFrame({ type: 'contentClick', pageX: 1, pageY: 1, hit: hitWith(oversizedName()) })
    fromFrame({ type: 'contentKey', key: 'Escape', pad: oversizedName() })
    await flushFrame()
    expect(handlers.onViewport).not.toHaveBeenCalled()
    expect(handlers.onContentClick).not.toHaveBeenCalled()
    expect(handlers.onContentKey).not.toHaveBeenCalled()
  })

  it('refuses a message that hides its bulk in a binary field', async () => {
    arm()
    fromFrame({ type: 'pointer', hit: hitWith('Save'), pad: new ArrayBuffer(4 * 1024 * 1024) })
    await flushFrame()
    expect(handlers.onPointer).not.toHaveBeenCalled()
  })

  it('refuses a message that is a graph rather than a report', async () => {
    arm()
    const wide: Record<string, unknown> = {}
    for (let i = 0; i < 5000; i++) wide[`k${i}`] = i
    fromFrame({ type: 'pointer', hit: hitWith('Save'), pad: wide })
    // Deep, and cyclic — postMessage carries both, and the walk must terminate.
    const deep: Record<string, unknown> = {}
    let node = deep
    for (let i = 0; i < 40; i++) {
      node.next = {}
      node = node.next as Record<string, unknown>
    }
    node.loop = deep
    fromFrame({ type: 'pointer', hit: hitWith('Save'), pad: deep })
    await flushFrame()
    expect(handlers.onPointer).not.toHaveBeenCalled()
  })

  it('still takes a long-but-plausible accessible name, clamped as before', async () => {
    arm()
    fromFrame({ type: 'pointer', hit: hitWith('a'.repeat(MAX_INBOUND_STRING_CHARS)) })
    await flushFrame()
    expect(handlers.onPointer).toHaveBeenCalledTimes(1)
    const hit = (handlers.onPointer as unknown as { mock: { calls: Array<[{ name: string }]> } }).mock.calls[0][0]
    expect(hit.name).toHaveLength(120)
  })

  it('charges an oversized message enough that a handful of them drop the channel', () => {
    arm()
    const trips = Math.floor(INBOUND_FLOOD_BUDGET / INBOUND_OVERSIZE_COST) + 1
    for (let i = 0; i < trips - 1; i++) fromFrame({ type: 'pointer', hit: hitWith(oversizedName()) })
    expect(handlers.onFlood).not.toHaveBeenCalled()
    fromFrame({ type: 'pointer', hit: hitWith(oversizedName()) })
    expect(handlers.onFlood).toHaveBeenCalledTimes(1)
    expect(messageListeners).toBe(0)
  })

  it('the same COUNT of well-formed reports is not dropped — it is the size that costs', async () => {
    arm()
    const trips = Math.floor(INBOUND_FLOOD_BUDGET / INBOUND_OVERSIZE_COST) + 1
    for (let i = 0; i < trips; i++) fromFrame({ type: 'pointer', hit: hitWith('Save') })
    await flushFrame()
    expect(handlers.onFlood).not.toHaveBeenCalled()
    expect(handlers.onPointer).toHaveBeenCalledTimes(1)
  })

  // ── The bound MEASURED instead of allowlisting (adversarial re-attack) ─────
  // Every value kind the protocol does not use walked straight past a check
  // that could only measure `byteLength`/`size`: a BigInt is a primitive with
  // neither, an ImageBitmap reports neither, and raw ArrayBuffers were capped
  // one at a time and simply packed. Each of these was MEASURED as accepted
  // against the real function before the allowlist went in.
  it('refuses a BigInt payload — twenty megabytes of magnitude that reported no size at all', () => {
    // The measured attack was `2n ** (8n * 20000000n)`; a megabyte of it makes
    // the same point in a fraction of the time.
    const huge = 2n ** (8n * 1_000_000n)
    expect(
      withinInboundSizeBounds({
        ns: CANVAS_BRIDGE_NS,
        type: 'pointer',
        hit: { role: 'x', name: 'y', tag: 'z', box: {} },
        pad: huge,
      }),
    ).toBe(false)
    // Refused by KIND, not by size: no bridge event carries a bigint at all, so
    // a one-digit one is refused just the same and there is no size to argue
    // about.
    expect(withinInboundSizeBounds({ ns: CANVAS_BRIDGE_NS, type: 'ready', pad: 1n })).toBe(false)
  })

  it('refuses the ImageBitmap/ImageData shape: no byteLength, no size, no enumerable keys', () => {
    // 8192x8192 is 268 MB of backing store behind an object the old walk saw as
    // an empty leaf.
    class ImageBitmapLike {
      readonly width = 8192
      readonly height = 8192
      close(): void {}
    }
    expect(withinInboundSizeBounds({ ns: CANVAS_BRIDGE_NS, type: 'ready', pad: new ImageBitmapLike() })).toBe(false)
    // Same shape, reached the other way: a null-prototype object has no
    // enumerable own properties to walk either.
    const bare = Object.create(null) as Record<string, unknown>
    bare.width = 8192
    bare.height = 8192
    expect(withinInboundSizeBounds({ ns: CANVAS_BRIDGE_NS, type: 'ready', pad: bare })).toBe(false)
  })

  it('refuses ArrayBuffers outright rather than capping them one at a time', () => {
    // Exactly at the old per-buffer cap, so the old check measured it and said
    // yes; the protocol carries no binary at all, so the answer is no.
    expect(withinInboundSizeBounds({ ns: CANVAS_BRIDGE_NS, type: 'ready', pad: new ArrayBuffer(16_384) })).toBe(false)
    // …and the pack: individually legal, collectively a megabyte a message.
    const packed: Record<string, unknown> = { ns: CANVAS_BRIDGE_NS, type: 'ready' }
    for (let i = 0; i < 50; i++) packed[`b${i}`] = new ArrayBuffer(16_384)
    expect(withinInboundSizeBounds(packed)).toBe(false)
    // A typed array over one is refused for the same reason (it used to be
    // caught only incidentally, by enumerating its indices into the value cap).
    expect(withinInboundSizeBounds({ ns: CANVAS_BRIDGE_NS, type: 'ready', pad: new Uint8Array(8) })).toBe(false)
  })

  it('refuses every other kind the five events never carry', () => {
    for (const pad of [
      () => 'a function',
      Symbol('nope'),
      new Map([['a', 1]]),
      new Set([1]),
      new Date(),
      /re/g,
      new Error('boom'),
    ]) {
      expect(withinInboundSizeBounds({ ns: CANVAS_BRIDGE_NS, type: 'ready', pad })).toBe(false)
    }
  })

  it('still takes everything the five events DO carry, arrays included', () => {
    expect(
      withinInboundSizeBounds({
        ns: CANVAS_BRIDGE_NS,
        type: 'pointer',
        pageX: 10.5,
        pageY: -20,
        hit: { role: 'button', name: 'Save', tag: 'button', uxId: 'save', box: { x: 1, y: 2, width: 3, height: 4 } },
      }),
    ).toBe(true)
    // Non-finite numbers are NOT refused here: `finite()` is what cleans them
    // on the way to the store, and refusing them would drop a message the
    // geometry guard exists to handle (the finite-guard test above proves the
    // channel still delivers one).
    expect(withinInboundSizeBounds({ ns: CANVAS_BRIDGE_NS, type: 'contentClick', pageX: Number.NaN, pageY: Infinity })).toBe(true)
    expect(withinInboundSizeBounds({ ns: CANVAS_BRIDGE_NS, type: 'ready', ok: true, extra: null, missing: undefined })).toBe(true)
    // Arrays are in the vocabulary and bounded like everything else.
    expect(withinInboundSizeBounds({ ns: CANVAS_BRIDGE_NS, type: 'ready', pad: [1, 'two', { three: 3 }] })).toBe(true)
    expect(withinInboundSizeBounds({ ns: CANVAS_BRIDGE_NS, type: 'ready', pad: new Array(MAX_INBOUND_VALUES + 1).fill(0) })).toBe(false)
  })

  it('does not DISPATCH a bigint-padded report, and charges it as oversize', async () => {
    arm()
    const hit = { role: 'button', name: 'Save', tag: 'button', box: { x: 1, y: 2, width: 3, height: 4 } }
    fromFrame({ type: 'pointer', hit, pad: 2n ** (8n * 1_000_000n) })
    // Awaited: delivery is coalesced to the next frame, so asserting before the
    // flush would pass whether or not the message was refused.
    await flushFrame()
    expect(handlers.onPointer).not.toHaveBeenCalled()
    // One unit plus the oversize remainder each, so a handful ends the channel
    // instead of six hundred a second being allowed.
    const trips = Math.floor(INBOUND_FLOOD_BUDGET / INBOUND_OVERSIZE_COST) + 1
    for (let i = 1; i < trips - 1; i++) fromFrame({ type: 'pointer', hit, pad: 1n })
    expect(handlers.onFlood).not.toHaveBeenCalled()
    fromFrame({ type: 'pointer', hit, pad: 1n })
    expect(handlers.onFlood).toHaveBeenCalledTimes(1)
    expect(messageListeners).toBe(0)
  })

  it('bounds the check itself: the real events pass, the shapes that cost do not', () => {
    // The five legitimate messages, at their largest.
    expect(withinInboundSizeBounds({ ns: CANVAS_BRIDGE_NS, type: 'ready' })).toBe(true)
    expect(
      withinInboundSizeBounds({
        ns: CANVAS_BRIDGE_NS,
        type: 'viewport',
        viewport: { scrollX: 0, scrollY: 0, width: 1920, height: 1080, dpr: 2, scale: 1 },
      }),
    ).toBe(true)
    expect(
      withinInboundSizeBounds({
        ns: CANVAS_BRIDGE_NS,
        type: 'pointer',
        pageX: 10,
        pageY: 20,
        hit: { role: 'button', name: 'Save', tag: 'button', uxId: 'save-button', box: { x: 1, y: 2, width: 3, height: 4 } },
      }),
    ).toBe(true)
    expect(withinInboundSizeBounds({ ns: CANVAS_BRIDGE_NS, type: 'contentKey', key: 'ArrowUp' })).toBe(true)

    // One string over the cap, one key over it, one value graph over it.
    expect(withinInboundSizeBounds({ a: 'a'.repeat(MAX_INBOUND_STRING_CHARS + 1) })).toBe(false)
    expect(withinInboundSizeBounds({ ['k'.repeat(MAX_INBOUND_STRING_CHARS + 1)]: 1 })).toBe(false)
    const many: Record<string, unknown> = {}
    for (let i = 0; i <= MAX_INBOUND_VALUES; i++) many[`k${i}`] = i
    expect(withinInboundSizeBounds(many)).toBe(false)
  })
})
