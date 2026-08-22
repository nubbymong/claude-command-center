// @vitest-environment jsdom
// The content side of x-ray Off (#367): the bridge's hover surface can be
// switched off, and while it is off the page does no per-mousemove work.
//
// This is what the host CANNOT do for itself. The host can drop a report it did
// not want (and does — see canvas-xray-pane), but only the content can decline
// to hit-test, measure and structured-clone a message on every mouse move. "The
// page behaves like a normal browser tab" is a claim about the PAGE's work, so
// it is pinned here, against the BUNDLED bridge that ccc-ux:// actually serves.
//
// What must survive being switched off is pinned too: viewport reporting and
// the request/response surface. A canvas whose scroll position stopped updating
// would be a broken pane, not a quiet one.

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { bridgeRequest, collectEvents, installBridge, stubLayout } from './canvas-bridge-harness'

/** jsdom has no hit testing; the fixture decides what is "under" the pointer. */
function pointAt(el: Element | null): void {
  ;(document as { elementFromPoint?: unknown }).elementFromPoint = () => el
}

function moveMouse(times = 3): void {
  for (let i = 0; i < times; i++) document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
}

async function setHoverReporting(enabled: unknown): Promise<{ ok: boolean; result?: unknown }> {
  return bridgeRequest('hoverReporting', { enabled })
}

beforeAll(() => {
  stubLayout({ x: 10, y: 20, width: 100, height: 30 })
  document.body.innerHTML = `<main><button data-ux-id="save-btn">Save draft</button></main>`
  pointAt(document.querySelector('[data-ux-id="save-btn"]'))
  installBridge()
})

// Module state in the bundled script: every test leaves it as it found it.
afterEach(async () => {
  await setHoverReporting(true)
})

describe('the hover surface is live by default', () => {
  it('reports pointer moves before the host has said anything', async () => {
    const events = collectEvents('pointer', 300)
    moveMouse(5)
    expect((await events).length).toBeGreaterThanOrEqual(1)
  })

  it('reports clicks before the host has said anything', async () => {
    const events = collectEvents('contentClick', 300)
    document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect((await events).length).toBe(1)
  })
})

describe('switched off, the page does no hover work at all', () => {
  it('acknowledges the request with what it is now doing', async () => {
    const reply = await setHoverReporting(false)
    expect(reply.ok).toBe(true)
    expect(reply.result).toEqual({ enabled: false })
  })

  it('emits no pointer events however much the mouse moves', async () => {
    await setHoverReporting(false)
    const events = collectEvents('pointer', 300)
    moveMouse(25)
    expect(await events).toEqual([])
  })

  it('emits nothing on mouseleave either — the same gate covers the clear', async () => {
    await setHoverReporting(false)
    const events = collectEvents('pointer', 300)
    document.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
    expect(await events).toEqual([])
  })

  it('emits no contentClick — in Off a click selects nothing, so there is nothing to report', async () => {
    await setHoverReporting(false)
    const events = collectEvents('contentClick', 300)
    for (let i = 0; i < 5; i++) document.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(await events).toEqual([])
  })

  it('drops a move that was queued a frame before the switch', async () => {
    // The rAF the move scheduled is still pending when the host switches off;
    // without the re-check on the frame it would land after Off took effect.
    const events = collectEvents('pointer', 300)
    moveMouse(1)
    await setHoverReporting(false)
    expect(await events).toEqual([])
  })
})

describe('switching off silences the hover surface and nothing else', () => {
  it('keeps reporting the viewport — a pane that stopped tracking scroll is broken, not quiet', async () => {
    await setHoverReporting(false)
    const events = collectEvents('viewport', 300)
    window.dispatchEvent(new Event('scroll'))
    expect((await events).length).toBeGreaterThanOrEqual(1)
  })

  it('still answers requests — snapshots and anchor resolution are not hover', async () => {
    await setHoverReporting(false)
    const reply = await bridgeRequest('boxMap')
    expect(reply.ok).toBe(true)
    expect(Array.isArray(reply.result)).toBe(true)
  })
})

describe('the switch is reversible and fails live', () => {
  it('resumes reporting when asked to', async () => {
    await setHoverReporting(false)
    await setHoverReporting(true)
    const events = collectEvents('pointer', 300)
    moveMouse(5)
    expect((await events).length).toBeGreaterThanOrEqual(1)
  })

  it('takes only a literal false for an answer — a malformed request cannot blind the pane', async () => {
    for (const value of [undefined, null, 0, '', 'false', 'off'] as unknown[]) {
      const reply = await setHoverReporting(value)
      expect(reply.result, String(value)).toEqual({ enabled: true })
    }
    const events = collectEvents('pointer', 300)
    moveMouse(5)
    expect((await events).length).toBeGreaterThanOrEqual(1)
  })
})
