// @vitest-environment jsdom
// The renderer's middle hop. Most of what matters here is what happens when
// there is nothing to capture: the agent must get a reason it can act on rather
// than a hang.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  handleSnapshotRequest,
  registerCanvasFrame,
  _framesForTest,
} from '../../../src/renderer/canvas/canvas-snapshot-host'
import { CANVAS_BRIDGE_NS } from '../../../src/shared/canvas'

const EVENT = {
  requestId: 'req-1',
  sessionId: 'sess-1',
  canvasId: 'canvas-1',
  versionId: 'v2',
  options: {},
}

let frameWindow: Window
let posted: Array<{ msg: Record<string, unknown>; origin: string }>

/** A real (jsdom) frame window, with postMessage replaced so the test decides
 *  what — and whether — the "page" answers. */
function makeFrame(): void {
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  frameWindow = iframe.contentWindow as Window
  posted = []
  frameWindow.postMessage = ((msg: Record<string, unknown>, origin: string) => {
    posted.push({ msg, origin })
  }) as typeof window.postMessage
}

function replyFromFrame(body: Record<string, unknown>, origin = 'ccc-ux://canvas-1'): void {
  window.dispatchEvent(new MessageEvent('message', { data: { ns: CANVAS_BRIDGE_NS, ...body }, source: frameWindow, origin }))
}

beforeEach(() => {
  _framesForTest().clear()
  document.body.innerHTML = ''
  makeFrame()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('no live frame', () => {
  it('tells the agent to open the canvas instead of hanging', async () => {
    const reply = await handleSnapshotRequest(EVENT)
    expect(reply.ok).toBe(false)
    expect(reply.ok === false && reply.error).toContain('No Agent Canvas is open')
  })

  it('refuses a canvas that is not the one on screen', async () => {
    registerCanvasFrame({ ...EVENT, canvasId: 'canvas-other', getWindow: () => frameWindow, isReady: () => true })
    const reply = await handleSnapshotRequest(EVENT)
    expect(reply.ok === false && reply.error).toContain('does not match')
  })

  it('refuses a version that is not the one on screen, and names what is', async () => {
    registerCanvasFrame({ ...EVENT, versionId: 'v1', getWindow: () => frameWindow, isReady: () => true })
    const reply = await handleSnapshotRequest(EVENT)
    expect(reply.ok === false && reply.error).toContain('showing v1')
  })

  it('reports a frame that has not loaded yet', async () => {
    registerCanvasFrame({ ...EVENT, getWindow: () => null, isReady: () => true })
    const reply = await handleSnapshotRequest(EVENT)
    expect(reply.ok === false && reply.error).toContain('not loaded yet')
  })

  it('unregisters on unmount', () => {
    const off = registerCanvasFrame({ ...EVENT, getWindow: () => frameWindow, isReady: () => true })
    expect(_framesForTest().size).toBe(1)
    off()
    expect(_framesForTest().size).toBe(0)
  })
})

describe('capture', () => {
  it('asks the frame at its own origin and returns a sanitised result', async () => {
    registerCanvasFrame({ ...EVENT, getWindow: () => frameWindow, isReady: () => true })
    const pending = handleSnapshotRequest({ ...EVENT, options: { scope: ['card-1'], analysis: true } })

    // The request is targeted, not broadcast.
    expect(posted).toHaveLength(1)
    expect(posted[0].origin).toBe('ccc-ux://canvas-1')
    expect(posted[0].msg).toMatchObject({ ns: CANVAS_BRIDGE_NS, type: 'snapshot', scope: ['card-1'], analysis: true })

    replyFromFrame({
      id: posted[0].msg.id,
      ok: true,
      result: {
        viewport: { width: 'nonsense', height: 900, dpr: 2 },
        root: { ref: 'e0', role: 'document', name: 'Page', box: {}, children: [] },
      },
    })

    const reply = await pending
    expect(reply.ok).toBe(true)
    // Bounded before it crosses IPC: the junk width is already 0 here.
    expect(reply.ok === true && reply.result.viewport).toEqual({ width: 0, height: 900, dpr: 2 })
  })

  it('ignores replies with the wrong id or a foreign source', async () => {
    registerCanvasFrame({ ...EVENT, getWindow: () => frameWindow, isReady: () => true })
    const pending = handleSnapshotRequest(EVENT, 300)
    const id = posted[0].msg.id as number

    replyFromFrame({ id: id + 999, ok: true, result: { root: { ref: 'e0', role: 'x', name: 'wrong-id', box: {}, children: [] } } })
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { ns: CANVAS_BRIDGE_NS, id, ok: true, result: { root: { ref: 'e0', role: 'x', name: 'foreign', box: {}, children: [] } } },
        source: window, // not our frame
      }),
    )

    const reply = await pending
    expect(reply.ok).toBe(false)
    expect(reply.ok === false && reply.error).toContain('did not answer')
  })

  it('ignores a reply whose origin is not this canvas — a frame window survives navigation', async () => {
    registerCanvasFrame({ ...EVENT, getWindow: () => frameWindow, isReady: () => true })
    const pending = handleSnapshotRequest(EVENT, 300)
    const id = posted[0].msg.id as number

    // Same frame, same id, wrong document: another canvas, and the null origin
    // an opaque document serialises to.
    replyFromFrame({ id, ok: true, result: { root: { ref: 'e0', role: 'x', name: 'foreign', box: {}, children: [] } } }, 'ccc-ux://canvas-someone-else')
    replyFromFrame({ id, ok: true, result: { root: { ref: 'e0', role: 'x', name: 'opaque', box: {}, children: [] } } }, 'null')

    const reply = await pending
    expect(reply.ok).toBe(false)
    expect(reply.ok === false && reply.error).toContain('did not answer')
  })

  it('uses unpredictable correlation ids, so a page cannot pre-answer by guessing', async () => {
    registerCanvasFrame({ ...EVENT, getWindow: () => frameWindow, isReady: () => true })
    void handleSnapshotRequest(EVENT, 50)
    void handleSnapshotRequest(EVENT, 50)
    void handleSnapshotRequest(EVENT, 50)
    const ids = posted.map((p) => p.msg.id as number)
    expect(new Set(ids).size).toBe(3)
    // A counter would make these consecutive; these must not be.
    expect(ids[1] - ids[0]).not.toBe(1)
    expect(ids.every((id) => Number.isInteger(id) && id >= 0)).toBe(true)
    await new Promise((r) => setTimeout(r, 80))
  })

  it('turns a frame-side error into a failed reply', async () => {
    registerCanvasFrame({ ...EVENT, getWindow: () => frameWindow, isReady: () => true })
    const pending = handleSnapshotRequest(EVENT)
    replyFromFrame({ id: posted[0].msg.id, ok: false, error: 'unknown request: snapshot' })
    const reply = await pending
    expect(reply.ok === false && reply.error).toContain('unknown request')
  })

  it('gives up before main does, so the agent sees the specific reason', async () => {
    registerCanvasFrame({ ...EVENT, getWindow: () => frameWindow, isReady: () => true })
    const reply = await handleSnapshotRequest(EVENT, 50)
    expect(reply.ok === false && reply.error).toContain('did not answer the snapshot request in time')
  })
})
