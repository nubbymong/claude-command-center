// @vitest-environment jsdom
//
// P3 anchoring in the BUNDLED bridge: the inspect chain (click-to-lock +
// expand-to-parent data), fingerprint minting, and resolveAnchors — including
// the refactor fixtures the spec's testing section names (an id survives its
// text being edited; the fingerprint ordinal's shrink/ambiguity behaviour).

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { installBridge, bridgeRequest, collectEvents, stubLayout } from './canvas-bridge-harness'
import type { AnchorRef, CanvasAnchorResolution, CanvasInspectEntry } from '../../../src/shared/canvas'
// The HOST half of the anchoring round trip — the real guards the pane runs,
// not a restatement of them.
import { clampString, safeAnchorResolutions, safeInspectResult } from '../../../src/renderer/utils/canvas-geometry-guard'
import { squash } from '../../../src/main/canvas/bridge/semantics'

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

// ── One rule, both sides (adversarial re-attack, 2026-08-15) ────────────────
// The host began stripping the whole format class from every page-authored
// string it STORES while the content side only collapsed whitespace. Anchoring
// is exact string equality between a stored value and a recomputed one, so the
// two stopped agreeing: an element whose accessible name held an emoji ZWJ
// sequence, a Persian ZWNJ, a bidi isolate or a zero-width space failed to
// re-anchor on EVERY re-render although it was present and unchanged, and the
// resolution checklist said "needs re-pointing" permanently. Two independent
// equality checks were broken by it — content-side `matchesFingerprint` and
// host-side `checkedResolution` — so the fixture below drives the WHOLE round
// trip through the real functions on both sides rather than either one alone.
describe('an anchor survives the trip host-side and back', () => {
  /** Written as code points so this file never carries an invisible character. */
  const ZWSP = String.fromCodePoint(0x200b)
  const ZWNJ = String.fromCodePoint(0x200c)
  const ZWJ = String.fromCodePoint(0x200d)
  const LRI = String.fromCodePoint(0x2066)
  const PDI = String.fromCodePoint(0x2069)
  const WOMAN = String.fromCodePoint(0x1f469)
  const LAPTOP = String.fromCodePoint(0x1f4bb)
  const RAINBOW = String.fromCodePoint(0x1f308)
  const WHITE_FLAG = String.fromCodePoint(0x1f3f3)
  const VS16 = String.fromCodePoint(0xfe0f)

  /** Emoji ZWJ sequences, a Persian ZWNJ word, a bidi isolate, a zero-width
   *  space — the shapes measured as permanently unresolvable. */
  const HOSTILE_NAMES: Array<[string, string]> = [
    ['emoji ZWJ (woman technologist)', `${WOMAN}${ZWJ}${LAPTOP} Developer`],
    ['emoji ZWJ (rainbow flag)', `${WHITE_FLAG}${VS16}${ZWJ}${RAINBOW} Pride`],
    ['Persian ZWNJ', String.fromCodePoint(0x0645, 0x06cc) + ZWNJ + String.fromCodePoint(0x0631, 0x0648, 0x0645)],
    ['bidi isolate', `${LRI}Save${PDI} now`],
    ['zero-width space', `Sa${ZWSP}ve`],
  ]

  /**
   * The FULL path a fingerprint takes in the product, real functions only:
   *   content mints it (bundled bridge, `inspect`)
   *     -> host cleans it on the way in (`safeInspectResult`) and stores it
   *     -> content is asked to find it again (bundled bridge, `resolveAnchors`)
   *     -> host checks the reply against the anchor it holds
   *        (`safeAnchorResolutions`).
   * Whatever comes back is what the resolution checklist would show.
   */
  async function roundTrip(kind: 'fingerprint' | 'ux-id'): Promise<{ anchor: AnchorRef; result: CanvasAnchorResolution }> {
    const inspect = await bridgeRequest('inspect', { x: 30, y: 30 })
    expect(inspect.ok).toBe(true)
    const { chain } = safeInspectResult(inspect.result)
    expect(chain.length).toBeGreaterThan(0)
    const anchor: AnchorRef =
      kind === 'ux-id' ? { kind: 'ux-id', id: chain[0].uxId ?? '' } : { kind: 'fingerprint', ...chain[0].fingerprint }
    const reply = await bridgeRequest('resolveAnchors', { anchors: [anchor] })
    expect(reply.ok).toBe(true)
    return { anchor, result: safeAnchorResolutions(reply.result, [anchor])[0] }
  }

  for (const [label, name] of HOSTILE_NAMES) {
    it(`re-anchors a fingerprint whose name carries a ${label}`, async () => {
      setBody(`
        <main data-test-box="0,0,800,600">
          <form data-test-box="10,10,400,200">
            <button data-test-box="20,20,80,24">${name}</button>
          </form>
        </main>`)
      pointHits(document.querySelector('button'))

      const { anchor, result } = await roundTrip('fingerprint')
      // The stored anchor really did go through the host's clean — otherwise
      // this asserts nothing about the two rules agreeing.
      const stored = (anchor as Extract<AnchorRef, { kind: 'fingerprint' }>).name
      expect(stored).toBe(clampString(squash(name)))
      // …and the element, present and unchanged, is found again.
      expect(result).toMatchObject({ found: true, via: 'fingerprint', name: stored })
    })
  }

  it('re-anchors when the format control is in the ROLE, not the name', async () => {
    setBody(`
      <main data-test-box="0,0,800,600">
        <div role="button${ZWSP}" data-test-box="20,20,80,24">Save</div>
      </main>`)
    pointHits(document.querySelector('div'))

    const { anchor, result } = await roundTrip('fingerprint')
    expect((anchor as Extract<AnchorRef, { kind: 'fingerprint' }>).role).toBe('button')
    expect(result).toMatchObject({ found: true, via: 'fingerprint', role: 'button' })
  })

  it('re-anchors when the format control is in the ANCESTOR PATH', async () => {
    setBody(`
      <main data-test-box="0,0,800,600">
        <div role="form${ZWSP}" data-test-box="10,10,400,200">
          <button data-test-box="20,20,80,24">Save</button>
        </div>
      </main>`)
    pointHits(document.querySelector('button'))

    const { anchor, result } = await roundTrip('fingerprint')
    expect((anchor as Extract<AnchorRef, { kind: 'fingerprint' }>).ancestorPath).toBe('main>form')
    expect(result).toMatchObject({ found: true, via: 'fingerprint' })
  })

  it('re-anchors a ux-id carrying one too — the primary anchor is an equality as well', async () => {
    setBody(`
      <main data-test-box="0,0,800,600">
        <button data-ux-id="save${ZWSP}-button" data-test-box="20,20,80,24">Save</button>
      </main>`)
    pointHits(document.querySelector('button'))

    const { anchor, result } = await roundTrip('ux-id')
    expect((anchor as Extract<AnchorRef, { kind: 'ux-id' }>).id).toBe('save-button')
    expect(result).toMatchObject({ found: true, via: 'ux-id', uxId: 'save-button' })
  })

  it('CONTROL: an ordinary name round-trips, so the fixtures above are not vacuously green', async () => {
    setBody(`
      <main data-test-box="0,0,800,600">
        <form data-test-box="10,10,400,200">
          <button data-test-box="20,20,80,24">Enregistrer</button>
        </form>
      </main>`)
    pointHits(document.querySelector('button'))
    const { result } = await roundTrip('fingerprint')
    expect(result).toMatchObject({ found: true, via: 'fingerprint', name: 'Enregistrer' })
  })

  it('the two sides produce the SAME string: the host clean is a no-op on the content output', () => {
    // The invariant the whole mechanism rests on, stated once and directly.
    // `squash` is the content side's name computation; `clampString` is the
    // host's. If the host still has something to strip, the two values differ
    // and every fingerprint over such a name is unresolvable.
    for (const [, name] of HOSTILE_NAMES) {
      const content = squash(name)
      expect(clampString(content)).toBe(content)
    }
    // A newline is a format control too, and must still read as a word break
    // rather than being deleted into a welded word.
    expect(squash('Save\nNow')).toBe('Save Now')
    expect(squash(`Save${ZWSP} Now`)).toBe('Save Now')
    expect(squash('Enregistrer — 保存 · ✓')).toBe('Enregistrer — 保存 · ✓')
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
