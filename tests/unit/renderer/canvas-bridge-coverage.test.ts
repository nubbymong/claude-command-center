// @vitest-environment jsdom
// Findings that vanished with nothing said.
//
// Distinct from the suppression suite next door: nothing here needs a hostile
// page or even an unusual one. These are shapes the walk simply did not reach,
// and every one of them produced a snapshot that looked like a clean result.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { captureSnapshot } from '../../../src/main/canvas/bridge/snapshot'
import { stubLayout } from './canvas-bridge-harness'
import type { AxeIssue, SnapshotNode } from '../../../src/shared/canvas'

function flatten(node: SnapshotNode, out: SnapshotNode[] = []): SnapshotNode[] {
  out.push(node)
  for (const child of node.children) flatten(child, out)
  return out
}

function issuesOf(nodes: SnapshotNode[]): AxeIssue[] {
  return nodes.flatMap((n) => n.issues ?? [])
}

const GREY = 'color: rgb(170,170,170); background-color: rgb(255,255,255); font-size: 14px'

beforeAll(() => stubLayout())
beforeEach(() => {
  document.body.innerHTML = ''
})

describe('text in a container that gets no node is still measured', () => {
  it('finds the contrast defect one empty child element used to erase', async () => {
    // `<div>text<i></i></div>`. A leaf with text earns a line in the tree; a
    // wrapper does not — so the element that OWNS the text was not emitted, was
    // therefore never a candidate, and the measurement pass never looked at it.
    // The axe join has climbed to the nearest emitted ancestor for this exact
    // shape since round 3; the measurement half never did.
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <div data-test-box="10,20,300,24" style="${GREY}">Low contrast<i></i></div>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    const finding = (page?.issues ?? []).find((i) => i.rule === 'color-contrast')
    expect(finding).toBeDefined()
    // Attributed to the ancestor, so it carries the owner's own box to say
    // where the problem actually is.
    expect(finding?.at).toEqual({ x: 10, y: 20, width: 300, height: 24 })
  })

  it('still reports nothing when that same text is fine (the control)', async () => {
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <div data-test-box="10,20,300,24" style="color: rgb(0,0,0); background-color: rgb(255,255,255); font-size: 14px">Fine<i></i></div>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    expect((page?.issues ?? []).map((i) => i.rule)).not.toContain('color-contrast')
  })

  it('does not double-report text that DID get its own node', async () => {
    // A leaf with text is emitted and measured as a candidate. If it were also
    // collected as an un-emitted owner the agent would read the same defect
    // twice, on two different nodes.
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <p data-ux-id="leaf" data-test-box="10,20,300,24" style="${GREY}">Low contrast</p>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const all = issuesOf(flatten(result.root)).filter((i) => i.rule === 'color-contrast')
    expect(all).toHaveLength(1)
  })

  it('bounds what one ancestor absorbs, and counts the rest', async () => {
    // 40 un-emitted rows all climb to the same `<main>`. The per-node ceiling
    // has to be charged as they arrive rather than by trimming afterwards:
    // building 40 issue objects to keep 20 is the per-node cost that froze the
    // UI thread one field over.
    const rows = Array.from(
      { length: 40 },
      (_, i) => `<div data-test-box="0,${i * 24},300,24" style="${GREY}">Row ${i}<i></i></div>`,
    ).join('')
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,960">${rows}</main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    expect(page?.issues?.length).toBeLessThanOrEqual(20)
    expect(page?.issuesDropped).toBe(20)
  })

  it('ignores text in a container that is not painted', async () => {
    // The emitted path drops `display: none` and `visibility: hidden` before it
    // measures anything, and the un-emitted path has to drop them too — a rule
    // that reports contrast on text nobody can see is the false-positive class
    // this whole feature was gated on.
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <div style="${GREY}; visibility: hidden" data-test-box="10,20,300,24">Low contrast<i></i></div>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    expect((page?.issues ?? []).map((i) => i.rule)).not.toContain('color-contrast')
  })

  it('inherits the inert exemption, which no ancestor tag carries', async () => {
    // `inert` is the one exemption computed on the candidate rather than found
    // by climbing tags, so the un-emitted path has to be handed it explicitly.
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <div inert data-test-box="0,0,900,200">
          <div data-test-box="10,20,300,24" style="${GREY}">Low contrast<i></i></div>
        </div>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    expect((page?.issues ?? []).map((i) => i.rule)).not.toContain('color-contrast')
  })

  it('respects the exemptions the emitted path respects', async () => {
    // The un-emitted path runs the same rules, so it must inherit the same
    // exemptions — otherwise closing a coverage hole opens a false-positive one.
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <fieldset disabled data-test-box="0,0,900,200">
          <div data-test-box="10,20,300,24" style="${GREY}">Low contrast<i></i></div>
        </fieldset>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    expect((page?.issues ?? []).map((i) => i.rule)).not.toContain('color-contrast')
  })
})

describe('text that paints outside the box its element reports', () => {
  // `isVisible` asks the ELEMENT for a border box, and text can be painted
  // without one. Both branches of the walk were gated on it, so this text was
  // refused a node for want of a box and then refused a measurement for the
  // same reason — with `truncated`, `depthLimited` and `hiddenContent` all
  // unset, so the capture reported success over text it never looked at.

  it('measures a display:contents wrapper, which has no box at all', async () => {
    // A React fragment or a grid pass-through. The wrapper generates no box;
    // its text is laid out in the parent's flow and is fully on screen.
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <div style="${GREY}; display: contents" data-test-rects="none" data-test-text-box="10,20,120,18">Low contrast<i></i></div>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    const finding = (page?.issues ?? []).find((i) => i.rule === 'color-contrast')
    expect(finding).toBeDefined()
    // The box of the TEXT, not of the element that does not have one.
    expect(finding?.at).toEqual({ x: 10, y: 20, width: 120, height: 18 })
  })

  it('measures a zero-height box whose text spills out of it', async () => {
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <div style="${GREY}; height: 0; overflow: visible" data-test-box="10,20,300,0" data-test-text-box="10,20,120,18">Low contrast<i></i></div>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    expect((page?.issues ?? []).map((i) => i.rule)).toContain('color-contrast')
  })

  it('reports nothing when that same text is readable (the control)', async () => {
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <div style="color: rgb(0,0,0); background-color: rgb(255,255,255); font-size: 14px; display: contents" data-test-rects="none" data-test-text-box="10,20,120,18">Fine<i></i></div>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    expect((page?.issues ?? []).map((i) => i.rule)).not.toContain('color-contrast')
  })

  it('measures a MEANINGFUL container that has no box, which both branches dropped', async () => {
    // `<p>` earns a node, so it took the emitted branch — and failed it for
    // want of a box, with the owner branch refusing it for being meaningful.
    // Two gates, one silent loss.
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <p style="${GREY}; display: contents" data-test-rects="none" data-test-text-box="10,20,120,18">Low contrast</p>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    expect((page?.issues ?? []).map((i) => i.rule)).toContain('color-contrast')
  })

  it('says NOTHING about a zero-height box that clips — the accordion idiom', async () => {
    // `height: 0; overflow: hidden` is how a collapsed panel is written, and it
    // is empty on screen. Reporting contrast here would invent a finding on
    // content a browser does not paint, on one of the commonest idioms there
    // is — the exact false-positive class this feature is gated on.
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <div style="${GREY}; height: 0; overflow: hidden" data-test-box="10,20,300,0" data-test-text-box="10,20,120,18">Low contrast<i></i></div>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    expect((page?.issues ?? []).map((i) => i.rule)).not.toContain('color-contrast')
  })

  it('says NOTHING about display:none, which also reports no box', async () => {
    // `display: none` and `display: contents` are indistinguishable by
    // `getBoundingClientRect` — both are zeros — and the difference between
    // them is the whole gate.
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <div style="${GREY}; display: none" data-test-rects="none" data-test-text-box="10,20,120,18">Low contrast<i></i></div>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    expect((page?.issues ?? []).map((i) => i.rule)).not.toContain('color-contrast')
  })

  it('says NOTHING about a box-less element that is visibility:hidden', async () => {
    // The one shape that keeps its layout — so its text MEASURES as painted —
    // and paints nothing.
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <div style="${GREY}; display: contents; visibility: hidden" data-test-rects="none" data-test-text-box="10,20,120,18">Low contrast<i></i></div>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    expect((page?.issues ?? []).map((i) => i.rule)).not.toContain('color-contrast')
  })

  it('says NOTHING when the text itself measures as empty', async () => {
    // No `data-test-text-box`, so every run comes back 0×0. A union of nothing
    // is not a box, and inventing one would put `at` on the page origin.
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <div style="${GREY}; display: contents" data-test-rects="none">Low contrast<i></i></div>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    expect((page?.issues ?? []).map((i) => i.rule)).not.toContain('color-contrast')
  })

  it('says NOTHING about a zero-height SCROLL container', async () => {
    // `overflow: auto` on a collapsed box is scrollable, and none of it is on
    // screen. It is not spelled `hidden`, which is the only word the first
    // version of this guard looked for.
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <div style="${GREY}; height: 0; overflow: auto" data-test-box="10,20,300,0" data-test-text-box="10,20,120,18">Low contrast<i></i></div>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    expect((page?.issues ?? []).map((i) => i.rule)).not.toContain('color-contrast')
  })

  it('says NOTHING about a zero-height box that is visibility:hidden', async () => {
    // The zero-size branch needs the same `visibility` gate the box-less one
    // does: the element spills, so the text measures — and paints nothing.
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <div style="${GREY}; height: 0; overflow: visible; visibility: hidden" data-test-box="10,20,300,0" data-test-text-box="10,20,120,18">Low contrast<i></i></div>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    expect((page?.issues ?? []).map((i) => i.rule)).not.toContain('color-contrast')
  })

  it('bounds how many text runs of one element it measures', async () => {
    // A page is free to give one element a hundred thousand text-node children.
    // `directText` walks them for a string concat; measuring them costs a layout
    // query each, so the union is taken over the first few. Here the 40th run is
    // far away from the 1st: with the bound the union is the 1st alone, without
    // it the union stretches to cover both.
    const runs = Array.from({ length: 40 }, (_, i) => `run${i}<b></b>`).join('')
    const boxes = Array.from({ length: 40 }, (_, i) => (i === 39 ? '800,300,60,18' : '10,20,120,18')).join(';')
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <div style="${GREY}; display: contents" data-test-rects="none" data-test-text-box="${boxes}">${runs}</div>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    const finding = (page?.issues ?? []).find((i) => i.rule === 'color-contrast')
    expect(finding?.at).toEqual({ x: 10, y: 20, width: 120, height: 18 })
  })

  it('does not stretch the box across whitespace between runs', async () => {
    // Most text nodes on a formatted page are the whitespace between elements.
    // They paint nothing worth a finding, and measuring them drags `at` out to
    // cover the gaps — here, a trailing blank run parked far off to the side.
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400"><div style="${GREY}; display: contents" data-test-rects="none" data-test-text-box="10,20,120,18;800,300,60,18">Low contrast<i></i> </div></main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    const finding = (page?.issues ?? []).find((i) => i.rule === 'color-contrast')
    expect(finding?.at).toEqual({ x: 10, y: 20, width: 120, height: 18 })
  })

  it('leaves a run that measured as nothing out of the union', async () => {
    // A run the engine gives no box — off-screen in a `content-visibility`
    // subtree, or simply not laid out yet — is zeros, and zeros are a point at
    // the page ORIGIN. Folded into the union it drags `at` up to the top-left
    // corner of the document, which is a marker pointing at the wrong thing
    // rather than a missing one.
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400"><div style="${GREY}; display: contents" data-test-rects="none" data-test-text-box="500,300,120,18;0,0,0,0">Low contrast<i></i>more</div></main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    const finding = (page?.issues ?? []).find((i) => i.rule === 'color-contrast')
    expect(finding?.at).toEqual({ x: 500, y: 300, width: 120, height: 18 })
  })

  it('reports the text box in PAGE coordinates, like every other box', async () => {
    // A Range measures against the viewport, and the snapshot's boxes are all
    // page-relative — so on a scrolled page an unconverted `at` points at
    // whatever happens to be that far down the current view instead.
    const scrolled = { configurable: true, get: () => 120 }
    Object.defineProperty(window, 'scrollX', scrolled)
    Object.defineProperty(window, 'scrollY', scrolled)
    try {
      document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400"><div style="${GREY}; display: contents" data-test-rects="none" data-test-text-box="10,20,120,18">Low contrast<i></i></div></main>`
      const result = await captureSnapshot({ analysis: false })
      const page = flatten(result.root).find((n) => n.uxId === 'page')
      const finding = (page?.issues ?? []).find((i) => i.rule === 'color-contrast')
      expect(finding?.at).toEqual({ x: 130, y: 140, width: 120, height: 18 })
      // The emitted path already converts; the two must agree or the agent
      // cannot tell which convention a given box is in.
      expect(page?.box).toEqual({ x: 120, y: 120, width: 900, height: 400 })
    } finally {
      Object.defineProperty(window, 'scrollX', { configurable: true, get: () => 0 })
      Object.defineProperty(window, 'scrollY', { configurable: true, get: () => 0 })
    }
  })

  it('still prefers the element box when the element has one', async () => {
    // The ordinary case must not start reporting text-run boxes: `at` has meant
    // the owner's own box since round 3 and the axe join agrees with it.
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <div data-test-box="10,20,300,24" data-test-text-box="11,21,60,12" style="${GREY}">Low contrast<i></i></div>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    const finding = (page?.issues ?? []).find((i) => i.rule === 'color-contrast')
    expect(finding?.at).toEqual({ x: 10, y: 20, width: 300, height: 24 })
  })
})

describe('a duplicate data-ux-id reviews every match, not an arbitrary one', () => {
  it('scopes to all the elements carrying the id', async () => {
    // Ids are supposed to be unique and nothing enforces it — a component
    // rendered in a list carries the same one on every row. Taking the first
    // match sent the whole review to one arbitrary row and said nothing about
    // it, so the agent read a clean report of a region it had not asked about.
    document.body.innerHTML = `
      <section data-ux-id="row" data-test-box="0,0,300,40"><p data-test-box="0,0,300,20">First</p></section>
      <section data-ux-id="row" data-test-box="0,40,300,40"><p data-test-box="0,40,300,20" style="${GREY}">Low contrast</p></section>`
    const result = await captureSnapshot({ scope: ['row'], analysis: false })
    const names = flatten(result.root).map((n) => n.name)
    expect(names).toContain('First')
    expect(names).toContain('Low contrast')
    // And the defect in the second one is actually reported.
    expect(issuesOf(flatten(result.root)).map((i) => i.rule)).toContain('color-contrast')
  })

  it('bounds how many matches one id can pull in', async () => {
    const rows = Array.from(
      { length: 20 },
      (_, i) => `<section data-ux-id="row" data-test-box="0,${i * 40},300,40">Row ${i}</section>`,
    ).join('')
    document.body.innerHTML = rows
    const result = await captureSnapshot({ scope: ['row'], analysis: false })
    expect(flatten(result.root).filter((n) => n.uxId === 'row')).toHaveLength(8)
  })

  it('still resolves a unique id to exactly one root (the control)', async () => {
    document.body.innerHTML = `
      <section data-ux-id="row" data-test-box="0,0,300,40">Only</section>
      <section data-ux-id="other" data-test-box="0,40,300,40">Other</section>`
    const result = await captureSnapshot({ scope: ['row'], analysis: false })
    const scoped = flatten(result.root).filter((n) => n.uxId === 'row')
    expect(scoped).toHaveLength(1)
    expect(flatten(result.root).map((n) => n.name)).not.toContain('Other')
  })
})
