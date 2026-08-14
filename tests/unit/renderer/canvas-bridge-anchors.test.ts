// @vitest-environment jsdom
//
// P3 anchoring in the BUNDLED bridge: the inspect chain (click-to-lock +
// expand-to-parent data), fingerprint minting, and resolveAnchors — including
// the refactor fixtures the spec's testing section names (an id survives its
// text being edited; the fingerprint ordinal's shrink/ambiguity behaviour).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installBridge, bridgeRequest, collectEvents, stubLayout } from './canvas-bridge-harness'
import type { CanvasAnchorResolution, CanvasInspectEntry } from '../../../src/shared/canvas'

function setBody(html: string): void {
  document.body.innerHTML = html
}

let restoreElementFromPoint: (() => void) | null = null

/** jsdom has no hit testing: route elementFromPoint to a fixture-chosen node. */
function pointHits(el: Element | null): void {
  const original = Object.getOwnPropertyDescriptor(Document.prototype, 'elementFromPoint')
  Document.prototype.elementFromPoint = () => el
  restoreElementFromPoint = () => {
    if (original) Object.defineProperty(Document.prototype, 'elementFromPoint', original)
  }
}

beforeEach(() => {
  stubLayout({ x: 0, y: 0, width: 50, height: 20 })
  installBridge()
})

afterEach(() => {
  restoreElementFromPoint?.()
  restoreElementFromPoint = null
  document.body.innerHTML = ''
})

async function inspectAt(x: number, y: number): Promise<CanvasInspectEntry[]> {
  const reply = await bridgeRequest('inspect', { x, y })
  expect(reply.ok).toBe(true)
  return (reply.result as { chain: CanvasInspectEntry[] }).chain
}

async function resolve(anchors: unknown[]): Promise<CanvasAnchorResolution[]> {
  const reply = await bridgeRequest('resolveAnchors', { anchors })
  expect(reply.ok).toBe(true)
  return (reply.result as { results: CanvasAnchorResolution[] }).results
}

describe('inspect (the selection ladder)', () => {
  it('returns the meaningful chain deepest-first, each rung carrying its fingerprint', async () => {
    setBody(`
      <main data-test-box="0,0,800,600">
        <form data-test-box="10,10,400,200">
          <button data-ux-id="save" data-test-box="20,20,80,24">Save</button>
        </form>
      </main>`)
    pointHits(document.querySelector('button'))

    const chain = await inspectAt(30, 30)
    expect(chain.length).toBeGreaterThanOrEqual(3)
    expect(chain[0]).toMatchObject({ role: 'button', name: 'Save', uxId: 'save' })
    expect(chain[0].fingerprint).toMatchObject({ role: 'button', name: 'Save', ordinal: 0 })
    expect(chain[0].fingerprint.ancestorPath).toBe('main>form')
    // Parents follow, outward.
    expect(chain[1].role).toBe('form')
    expect(chain[2].role).toBe('main')
  })

  it('gives look-alike siblings distinct ordinals', async () => {
    setBody(`
      <main data-test-box="0,0,800,600">
        <button data-test-box="0,0,50,20">Do</button>
        <button data-test-box="0,30,50,20">Do</button>
      </main>`)
    const buttons = document.querySelectorAll('button')
    pointHits(buttons[1])
    const chain = await inspectAt(10, 40)
    expect(chain[0].fingerprint.ordinal).toBe(1)
  })
})

describe('resolveAnchors', () => {
  it('finds by ux-id first, reports 1:1 with the request, and describes the match', async () => {
    setBody(`
      <main data-test-box="0,0,800,600">
        <button data-ux-id="save" data-test-box="20,20,80,24">Save</button>
      </main>`)
    const results = await resolve([
      { kind: 'ux-id', id: 'save' },
      { kind: 'ux-id', id: 'gone' },
      { kind: 'plan-step', id: 'P2.3' },
    ])
    expect(results).toHaveLength(3)
    expect(results[0]).toMatchObject({ found: true, via: 'ux-id', uxId: 'save', role: 'button', name: 'Save' })
    expect((results[0] as { box: { width: number } }).box.width).toBe(80)
    expect(results[1]).toEqual({ found: false })
    expect(results[2]).toEqual({ found: false })
  })

  it('REFACTOR FIXTURE: the ux-id anchor survives its own content being edited', async () => {
    setBody(`<main data-test-box="0,0,800,600"><button data-ux-id="save" data-test-box="20,20,80,24">Save</button></main>`)
    const before = await resolve([{ kind: 'ux-id', id: 'save' }])
    expect(before[0].found).toBe(true)

    // The agent reworded the button — the id must still anchor.
    document.querySelector('button')!.textContent = 'Save changes'
    const after = await resolve([{ kind: 'ux-id', id: 'save' }])
    expect(after[0]).toMatchObject({ found: true, via: 'ux-id', name: 'Save changes' })
  })

  it('falls back to the fingerprint at its ordinal among look-alikes', async () => {
    setBody(`
      <main data-test-box="0,0,800,600">
        <button data-test-box="0,0,50,20">Do</button>
        <button data-test-box="0,30,50,20">Do</button>
        <button data-test-box="0,60,50,20">Do</button>
      </main>`)
    const fp = { kind: 'fingerprint', role: 'button', name: 'Do', ancestorPath: 'main', ordinal: 1 }
    const results = await resolve([fp])
    expect(results[0]).toMatchObject({ found: true, via: 'fingerprint' })
    expect((results[0] as { box: { y: number } }).box.y).toBe(30)
  })

  it('ORDINAL BEHAVIOUR: a field collapsed to one is accepted; a shrunken ambiguous field is refused', async () => {
    // Ordinal 2 was captured when there were three; now there is exactly one.
    setBody(`<main data-test-box="0,0,800,600"><button data-test-box="0,0,50,20">Do</button></main>`)
    const collapsed = await resolve([{ kind: 'fingerprint', role: 'button', name: 'Do', ancestorPath: 'main', ordinal: 2 }])
    expect(collapsed[0].found).toBe(true)

    // Two remain: candidates[2] is gone and the field is ambiguous — refusing
    // is the honest answer (a wrong "found" re-points the user's note).
    setBody(`
      <main data-test-box="0,0,800,600">
        <button data-test-box="0,0,50,20">Do</button>
        <button data-test-box="0,30,50,20">Do</button>
      </main>`)
    const ambiguous = await resolve([{ kind: 'fingerprint', role: 'button', name: 'Do', ancestorPath: 'main', ordinal: 2 }])
    expect(ambiguous[0]).toEqual({ found: false })
  })

  it('answers malformed anchors with found:false rather than throwing', async () => {
    setBody(`<main data-test-box="0,0,800,600"><button data-test-box="0,0,50,20">Do</button></main>`)
    const results = await resolve([
      null,
      42,
      { kind: 'fingerprint', role: 'button' }, // missing fields
      { kind: 'fingerprint', role: 'button', name: 'Do', ancestorPath: 'main', ordinal: -1 },
    ])
    expect(results).toEqual([{ found: false }, { found: false }, { found: false }, { found: false }])
  })
})

describe('reported events (click-to-lock, the two keys)', () => {
  it('reports a click with its page point', async () => {
    setBody(`<main data-test-box="0,0,800,600"><button data-test-box="20,20,80,24">Save</button></main>`)
    pointHits(document.querySelector('button'))
    const eventsPromise = collectEvents('contentClick', 200)
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    const events = await eventsPromise
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'contentClick' })
  })

  it('reports Escape and ArrowUp from a non-editable target, and nothing else', async () => {
    setBody(`<main data-test-box="0,0,800,600"><input data-test-box="0,0,100,20" /></main>`)
    const keysPromise = collectEvents('contentKey', 250)
    // From the document: reported.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    // Not on the allowlist: never relayed.
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    // From an editable target: never relayed (that would be a keylogger).
    document.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    const events = await keysPromise
    expect(events.map((e) => e.key)).toEqual(['Escape', 'ArrowUp'])
  })
})
