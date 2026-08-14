// @vitest-environment jsdom
// The hidden off-screen capture path: what answers canvas_snapshot while the
// user is at the terminal. Runs the REAL modules end to end in jsdom — only
// the iframe's postMessage is stubbed (jsdom cannot serve ccc-ux://), so the
// test plays the page's half of the bridge protocol: announce ready, then
// answer the snapshot ask by correlation id at the canvas's own origin.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  captureHeadless,
  HEADLESS_VIEWPORT,
  _configureHeadlessForTest,
  _headlessFramesForTest,
  _resetHeadlessCaptureForTest,
} from '../../../src/renderer/canvas/canvas-headless-capture'
import { CANVAS_BRIDGE_NS } from '../../../src/shared/canvas'

const EVENT = {
  requestId: 'req-1',
  sessionId: 'sess-1',
  canvasId: 'canvas-1',
  versionId: 'v2',
  entry: 'index.html',
  options: {},
}
const ORIGIN = 'ccc-ux://canvas-1'

interface Posted {
  msg: Record<string, unknown>
  origin: string
}

function mountedIframe(): HTMLIFrameElement {
  const iframe = document.querySelector<HTMLIFrameElement>('[data-canvas-headless] iframe')
  if (!iframe) throw new Error('no headless iframe mounted')
  return iframe
}

/** Stub the frame's postMessage (jsdom serves nothing) and record the asks. */
function tapFrame(iframe: HTMLIFrameElement): Posted[] {
  const posted: Posted[] = []
  const target = iframe.contentWindow as Window
  target.postMessage = ((msg: Record<string, unknown>, origin: string) => {
    posted.push({ msg, origin })
  }) as typeof window.postMessage
  return posted
}

function fromFrame(iframe: HTMLIFrameElement, body: Record<string, unknown>, origin = ORIGIN): void {
  window.dispatchEvent(
    new MessageEvent('message', { data: { ns: CANVAS_BRIDGE_NS, ...body }, source: iframe.contentWindow as Window, origin }),
  )
}

async function microtasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
}

beforeEach(() => {
  _resetHeadlessCaptureForTest()
  document.body.innerHTML = ''
})

afterEach(() => {
  _resetHeadlessCaptureForTest()
})

describe('captureHeadless', () => {
  it('mounts an off-screen frame with the pane-identical sandbox and asks only after ready', async () => {
    const pending = captureHeadless({ ...EVENT, options: { scope: ['card-1'], analysis: true } })

    const iframe = mountedIframe()
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms')
    expect(iframe.referrerPolicy).toBe('no-referrer')
    expect(iframe.src).toContain('ccc-ux://canvas-1/v2/index.html')
    const container = iframe.parentElement as HTMLDivElement
    expect(container.style.position).toBe('fixed')
    expect(container.style.width).toBe(`${HEADLESS_VIEWPORT.width}px`)
    // Off-screen, never hidden: display/visibility change what layout and the
    // a11y pass compute, position does not.
    expect(container.style.left).toBe('-13000px')
    expect(container.style.display).not.toBe('none')
    expect(container.style.visibility).not.toBe('hidden')

    const posted = tapFrame(iframe)
    await microtasks()
    expect(posted).toHaveLength(0) // nothing asked before the bridge announces itself

    fromFrame(iframe, { type: 'ready' })
    await microtasks()
    expect(posted).toHaveLength(1)
    expect(posted[0].origin).toBe(ORIGIN)
    expect(posted[0].msg).toMatchObject({ ns: CANVAS_BRIDGE_NS, type: 'snapshot', scope: ['card-1'], analysis: true })

    fromFrame(iframe, {
      id: posted[0].msg.id,
      ok: true,
      result: {
        viewport: { width: 'nonsense', height: 800, dpr: 1 },
        root: { ref: 'e0', role: 'document', name: 'Page', box: {}, children: [] },
      },
    })

    const reply = await pending
    expect(reply.ok).toBe(true)
    expect(reply.ok === true && reply.headless).toBe(true)
    // Sanitised exactly like the live path: the junk width is bounded here.
    expect(reply.ok === true && reply.result.viewport).toEqual({ width: 0, height: 800, dpr: 1 })
  })

  it('ignores a ready from a foreign origin', async () => {
    _configureHeadlessForTest({ readyTimeoutMs: 60 })
    const pending = captureHeadless(EVENT)
    const iframe = mountedIframe()
    tapFrame(iframe)

    fromFrame(iframe, { type: 'ready' }, 'ccc-ux://canvas-someone-else')
    const reply = await pending
    expect(reply.ok).toBe(false)
    expect(reply.ok === false && reply.error).toContain('did not finish loading in time')
  })

  it('reuses the laid-out frame for a follow-up capture of the same version', async () => {
    const first = captureHeadless(EVENT)
    const iframe = mountedIframe()
    const posted = tapFrame(iframe)
    fromFrame(iframe, { type: 'ready' })
    await microtasks()
    fromFrame(iframe, {
      id: posted[0].msg.id,
      ok: true,
      result: { viewport: { width: 1280, height: 800, dpr: 1 }, root: { ref: 'e0', role: 'document', name: 'p', box: {}, children: [] } },
    })
    await first

    const second = captureHeadless(EVENT)
    await microtasks()
    expect(document.querySelectorAll('[data-canvas-headless]')).toHaveLength(1) // same frame, no remount
    expect(posted).toHaveLength(2)
    fromFrame(iframe, {
      id: posted[1].msg.id,
      ok: true,
      result: { viewport: { width: 1280, height: 800, dpr: 1 }, root: { ref: 'e0', role: 'document', name: 'p', box: {}, children: [] } },
    })
    const reply = await second
    expect(reply.ok).toBe(true)
  })

  it('fails with the loading reason when the bridge never announces, and unmounts the frame', async () => {
    _configureHeadlessForTest({ readyTimeoutMs: 40 })
    const reply = await captureHeadless(EVENT)
    expect(reply.ok).toBe(false)
    expect(reply.ok === false && reply.error).toContain('did not finish loading in time')
    expect(document.querySelectorAll('[data-canvas-headless]')).toHaveLength(0)
    expect(_headlessFramesForTest().size).toBe(0)
  })

  it('refuses a fourth simultaneous hidden document', async () => {
    _configureHeadlessForTest({ readyTimeoutMs: 5_000 })
    void captureHeadless({ ...EVENT, versionId: 'v1' })
    void captureHeadless({ ...EVENT, versionId: 'v2' })
    void captureHeadless({ ...EVENT, versionId: 'v3' })
    const reply = await captureHeadless({ ...EVENT, versionId: 'v4' })
    expect(reply.ok).toBe(false)
    expect(reply.ok === false && reply.error).toContain('off-screen frame limit')
    _resetHeadlessCaptureForTest() // release the three hanging readies
  })

  it('sweeps idle frames out on the TTL', async () => {
    _configureHeadlessForTest({ frameTtlMs: 30 })
    const pending = captureHeadless(EVENT)
    const iframe = mountedIframe()
    const posted = tapFrame(iframe)
    fromFrame(iframe, { type: 'ready' })
    await microtasks()
    fromFrame(iframe, {
      id: posted[0].msg.id,
      ok: true,
      result: { viewport: { width: 1280, height: 800, dpr: 1 }, root: { ref: 'e0', role: 'document', name: 'p', box: {}, children: [] } },
    })
    await pending

    expect(_headlessFramesForTest().size).toBe(1)
    await new Promise((r) => setTimeout(r, 90))
    expect(_headlessFramesForTest().size).toBe(0)
    expect(document.querySelectorAll('[data-canvas-headless]')).toHaveLength(0)
  })
})
