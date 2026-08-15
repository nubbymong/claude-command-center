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
  INBOUND_FLOOD_BUDGET,
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
