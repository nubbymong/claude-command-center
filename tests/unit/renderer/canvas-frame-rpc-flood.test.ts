// @vitest-environment jsdom
//
// The bridge RPC under a page that sets the call rate (adversarial review,
// 2026-08-14). `askCanvasFrame` removed its listener on reply or timeout, and
// that read as cleanup — but the pane issues one call per inbound
// `contentClick`, so the page chose how many were outstanding at once. 500
// forged clicks produced 500 live `message` listeners, each holding a 5s timer
// and a pending promise, after which every later message was dispatched to all
// of them. Browse is the default mode, so no user action was needed, and the
// renderer that wedges is the one drawing every terminal in the app.
//
// Listeners are COUNTED here rather than modelled: the leak was invisible to
// any test that only checked the promise.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  askCanvasFrame,
  framesInFlight,
  MAX_FRAME_REQUESTS_IN_FLIGHT,
} from '../../../src/renderer/canvas/canvas-frame-rpc'
import { CANVAS_BRIDGE_NS } from '../../../src/shared/canvas'

const CANVAS_ID = 'canvas-1'
const ORIGIN = `ccc-ux://${CANVAS_ID}`

let frameWindow: Window
let posted: Array<Record<string, unknown>>
let messageListeners: number

const realAdd = window.addEventListener.bind(window)
const realRemove = window.removeEventListener.bind(window)

beforeEach(() => {
  document.body.innerHTML = ''
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  frameWindow = iframe.contentWindow as Window
  posted = []
  // A page that simply never answers — the shape of the attack, and of a slow
  // page too.
  frameWindow.postMessage = ((msg: Record<string, unknown>) => {
    posted.push(msg)
  }) as typeof window.postMessage

  messageListeners = 0
  window.addEventListener = ((type: string, fn: never, opts: never) => {
    if (type === 'message') messageListeners++
    return realAdd(type, fn, opts)
  }) as typeof window.addEventListener
  window.removeEventListener = ((type: string, fn: never, opts: never) => {
    if (type === 'message') messageListeners--
    return realRemove(type, fn, opts)
  }) as typeof window.removeEventListener
})

afterEach(() => {
  window.addEventListener = realAdd
  window.removeEventListener = realRemove
  vi.useRealTimers()
})

function reply(id: unknown, result: unknown = { chain: [] }): void {
  window.dispatchEvent(
    new MessageEvent('message', { data: { ns: CANVAS_BRIDGE_NS, id, ok: true, result }, source: frameWindow, origin: ORIGIN }),
  )
}

describe('outstanding requests to one frame are capped', () => {
  it('500 page-driven inspects leave a constant number of listeners, not 500', async () => {
    const settled: string[] = []
    const calls: Array<Promise<unknown>> = []
    for (let i = 0; i < 500; i++) {
      calls.push(
        askCanvasFrame(frameWindow, CANVAS_ID, { type: 'inspect', x: i, y: i }, 5000).then(
          () => settled.push('ok'),
          (err: Error) => settled.push(err.message),
        ),
      )
    }

    expect(messageListeners).toBe(MAX_FRAME_REQUESTS_IN_FLIGHT)
    expect(framesInFlight(frameWindow)).toBe(MAX_FRAME_REQUESTS_IN_FLIGHT)
    // Only the admitted ones ever reached the frame.
    expect(posted).toHaveLength(MAX_FRAME_REQUESTS_IN_FLIGHT)

    // The refusals are immediate and say why — the word the tool layer's
    // failure vocabulary matches on.
    await Promise.all(calls.slice(MAX_FRAME_REQUESTS_IN_FLIGHT))
    expect(settled).toHaveLength(500 - MAX_FRAME_REQUESTS_IN_FLIGHT)
    expect(settled.every((m) => /in flight/i.test(m))).toBe(true)

    // Answering the outstanding ones gives the budget back and clears every
    // listener.
    for (const msg of posted) reply(msg.id)
    await Promise.all(calls)
    expect(messageListeners).toBe(0)
    expect(framesInFlight(frameWindow)).toBe(0)
  })

  it('a settled request frees exactly one slot, so real work continues', async () => {
    const first: Array<Promise<unknown>> = []
    for (let i = 0; i < MAX_FRAME_REQUESTS_IN_FLIGHT; i++) {
      first.push(askCanvasFrame(frameWindow, CANVAS_ID, { type: 'inspect', x: i, y: i }, 5000).catch(() => undefined))
    }
    await expect(askCanvasFrame(frameWindow, CANVAS_ID, { type: 'inspect', x: 9, y: 9 }, 5000)).rejects.toThrow(/in flight/i)

    reply(posted[0].id)
    await first[0]
    expect(framesInFlight(frameWindow)).toBe(MAX_FRAME_REQUESTS_IN_FLIGHT - 1)

    const admitted = askCanvasFrame(frameWindow, CANVAS_ID, { type: 'inspect', x: 9, y: 9 }, 5000)
    expect(posted).toHaveLength(MAX_FRAME_REQUESTS_IN_FLIGHT + 1)
    reply(posted[posted.length - 1].id, { chain: [] })
    await expect(admitted).resolves.toEqual({ chain: [] })

    for (const msg of posted.slice(1, MAX_FRAME_REQUESTS_IN_FLIGHT)) reply(msg.id)
    await Promise.all(first)
    expect(messageListeners).toBe(0)
  })

  it('a timeout also frees its slot and its listener', async () => {
    vi.useFakeTimers()
    const pending = askCanvasFrame(frameWindow, CANVAS_ID, { type: 'inspect', x: 1, y: 1 }, 100).catch(
      (err: Error) => err.message,
    )
    expect(framesInFlight(frameWindow)).toBe(1)
    await vi.advanceTimersByTimeAsync(150)
    await expect(pending).resolves.toMatch(/did not answer/i)
    expect(framesInFlight(frameWindow)).toBe(0)
    expect(messageListeners).toBe(0)
  })

  it('a throwing postMessage frees its slot too', async () => {
    frameWindow.postMessage = (() => {
      throw new Error('frame gone')
    }) as typeof window.postMessage
    await expect(askCanvasFrame(frameWindow, CANVAS_ID, { type: 'inspect', x: 1, y: 1 }, 100)).rejects.toThrow('frame gone')
    expect(framesInFlight(frameWindow)).toBe(0)
    expect(messageListeners).toBe(0)
  })
})
