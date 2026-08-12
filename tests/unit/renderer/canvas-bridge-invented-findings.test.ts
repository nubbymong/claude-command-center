// @vitest-environment jsdom
// The guards whose removal INVENTS a finding.
//
// Written from a mutation campaign over the whole canvas pipeline: 231 guards
// neutralised one at a time, and these are the ones nothing noticed. Every rule
// here already had tests for the finding it produces; what none of them had was
// a test for the case it must stay QUIET on — which is the half that carries the
// P0 gate, since a review that cries wolf is not a review.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { AxeViolation } from '../../../src/main/canvas/bridge/analysis-loader'

let violations: AxeViolation[] = []

vi.mock('../../../src/main/canvas/bridge/analysis-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/canvas/bridge/analysis-loader')>()
  return {
    ...actual,
    ensureAnalysis: async () => ({ version: 'fake', run: async () => ({ violations, incomplete: [] }) }),
  }
})

import { captureSnapshot } from '../../../src/main/canvas/bridge/snapshot'
import { stubLayout } from './canvas-bridge-harness'
import type { SnapshotNode } from '../../../src/shared/canvas'

function flatten(node: SnapshotNode, out: SnapshotNode[] = []): SnapshotNode[] {
  out.push(node)
  for (const child of node.children) flatten(child, out)
  return out
}

function rulesOn(root: SnapshotNode, uxId: string): string[] {
  const node = flatten(root).find((n) => n.uxId === uxId)
  return (node?.issues ?? []).map((i) => i.rule)
}

function allRules(root: SnapshotNode): string[] {
  return flatten(root).flatMap((n) => (n.issues ?? []).map((i) => i.rule))
}

beforeAll(() => stubLayout())
beforeEach(() => {
  document.body.innerHTML = ''
  violations = []
})

describe('the overlap rule stays quiet where overlap is not a defect', () => {
  it('never reports a node as overlapping its own descendant', () => {
    // An ancestor contains its children by definition. Without the containment
    // skip every card on every page overlaps its own contents, and the rule
    // reports the page it was pointed at as broken from top to bottom.
    document.body.innerHTML = `<div data-ux-id="card" data-test-box="0,0,300,200">card
        <p data-ux-id="inner" data-test-box="10,10,280,40">inner text</p>
      </div>`
    return captureSnapshot({ analysis: false }).then((result) => {
      expect(allRules(result.root)).not.toContain('overlap')
    })
  })

  it('ignores a brush of one box against another', async () => {
    // Kerning bleed and a one-pixel rounding seam are not findings. The gate is
    // a FRACTION of the smaller box, so a touch has to be discarded while a
    // real cover is kept.
    document.body.innerHTML =
      `<div data-ux-id="a" data-test-box="0,0,300,100">a</div>` +
      `<div data-ux-id="b" data-test-box="0,99,300,100">b</div>`
    const grazed = await captureSnapshot({ analysis: false })
    expect(allRules(grazed.root)).not.toContain('overlap')

    // The control: the same pair, actually stacked.
    document.body.innerHTML =
      `<div data-ux-id="a" data-test-box="0,0,300,100">a</div>` +
      `<div data-ux-id="b" data-test-box="0,10,300,100">b</div>`
    const stacked = await captureSnapshot({ analysis: false })
    expect(allRules(stacked.root)).toContain('overlap')
  })

  it('ignores screen-reader-only and faded-out boxes', async () => {
    // Both are in the accessibility tree and neither is painted where its box
    // says. A rule that measures them reports collisions no eye can see — and
    // the sr-only wrapper is the commonest idiom in accessible markup.
    document.body.innerHTML =
      `<div data-ux-id="a" data-test-box="0,0,300,100" style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%)">a</div>` +
      `<div data-ux-id="b" data-test-box="0,10,300,100" style="opacity: 0">b</div>` +
      `<div data-ux-id="c" data-test-box="0,20,300,100">c</div>`
    const result = await captureSnapshot({ analysis: false })
    expect(rulesOn(result.root, 'a')).not.toContain('overlap')
    expect(rulesOn(result.root, 'b')).not.toContain('overlap')
  })

  it('ignores a box with neither text nor a way to be used', async () => {
    // A spacer, a backdrop, a decorative rule. They overlap constantly and by
    // design, and none of it is a defect.
    document.body.innerHTML =
      `<div data-ux-id="spacer" data-test-box="0,0,300,100"></div>` +
      `<div data-ux-id="other" data-test-box="0,10,300,100"></div>`
    const result = await captureSnapshot({ analysis: false })
    expect(allRules(result.root)).not.toContain('overlap')
  })
})

describe('contrast stays quiet on text nobody is looking at', () => {
  const GREY = 'color: rgb(170,170,170); background-color: rgb(255,255,255); font-size: 14px'

  it('says nothing about text faded to nothing', async () => {
    // `opacity: 0` keeps the box and the announcement, so it is reported rather
    // than dropped — but its COLOUR is not what anyone sees, and measuring it
    // produces a finding on content that is not on screen.
    document.body.innerHTML = `<p data-ux-id="faded" data-test-box="0,0,300,24" style="${GREY}; opacity: 0">Low contrast</p>`
    const result = await captureSnapshot({ analysis: false })
    expect(rulesOn(result.root, 'faded')).not.toContain('color-contrast')
  })

  it('weighs a bold keyword as bold, not as a parse failure', async () => {
    // The large-text threshold is 3:1 against 4.5:1, and `font-weight: bold` is
    // half of what makes text large. Read as a number the keyword is NaN, the
    // weight falls back to 400, and 18.66px bold text at 3.5:1 — which passes —
    // is reported as a failure.
    document.body.innerHTML =
      `<p data-ux-id="bold" data-test-box="0,0,300,30" style="color: rgb(138,138,138); background-color: rgb(255,255,255); font-size: 19px; font-weight: bold">Large bold</p>`
    const result = await captureSnapshot({ analysis: false })
    expect(rulesOn(result.root, 'bold')).not.toContain('color-contrast')

    // The control: the same colours at the same size, not bold, are a finding.
    document.body.innerHTML =
      `<p data-ux-id="plain" data-test-box="0,0,300,30" style="color: rgb(138,138,138); background-color: rgb(255,255,255); font-size: 19px; font-weight: normal">Large plain</p>`
    const plain = await captureSnapshot({ analysis: false })
    expect(rulesOn(plain.root, 'plain')).toContain('color-contrast')
  })
})

describe('the clipping rule stays quiet where nothing clips', () => {
  it('says nothing about screen-reader-only text, which is clipped on purpose', async () => {
    // The sr-only idiom IS a 1×1 box with `overflow: hidden` and content
    // overflowing it. Reporting that as clipped text is a finding on every
    // accessible page, and it was the P0 false positive this feature is gated
    // on.
    document.body.innerHTML = `<span data-ux-id="sr" data-test-box="0,0,1,1" data-test-scroll="200,1,20,1"
        style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%)">Skip to content</span>`
    const result = await captureSnapshot({ analysis: false })
    expect(rulesOn(result.root, 'sr')).not.toContain('clipped-content')
  })

  it('says nothing about content that simply overflows a box that does not clip', async () => {
    // `overflow: visible` is the default and it paints outside the box. The
    // scroll sizes exceed the client sizes on almost every page, so a rule that
    // fires on those alone fires on almost every element of it.
    document.body.innerHTML = `<p data-ux-id="loose" data-test-box="0,0,300,24" data-test-scroll="900,300,24,24">Wide text</p>`
    const loose = await captureSnapshot({ analysis: false })
    expect(rulesOn(loose.root, 'loose')).not.toContain('clipped-content')

    // The control: the same overflow, on a box that clips.
    document.body.innerHTML = `<p data-ux-id="tight" data-test-box="0,0,300,24" data-test-scroll="900,300,24,24" style="overflow: hidden">Wide text</p>`
    const tight = await captureSnapshot({ analysis: false })
    expect(rulesOn(tight.root, 'tight')).toContain('clipped-content')
  })
})

describe('contrast coverage is handed only the results that are about contrast', () => {
  it('does not treat every incomplete axe result as a contrast decline', async () => {
    // The measurement pass stands down where axe FAILED a contrast check. The
    // set it reads is filtered by rule id, and without that filter an unrelated
    // incomplete result — `aria-valid-attr`, say — marks the node as axe's
    // business, and the measurement pass steps back from a defect that nobody
    // then reports.
    // A violation, because that is the set the coverage question reads: "axe
    // owns what it FAILED". An unrelated failure on this node must not hand
    // axe the contrast question too.
    violations = [
      { id: 'button-name', impact: 'critical', nodes: [{ target: ['[data-ux-id="dim"]'] }] } as unknown as AxeViolation,
    ]
    document.body.innerHTML = `<p data-ux-id="dim" data-test-box="0,0,300,24" style="color: rgb(170,170,170); background-color: rgb(255,255,255); font-size: 14px">Low contrast</p>`
    const result = await captureSnapshot({ analysis: true })
    expect(rulesOn(result.root, 'dim')).toContain('color-contrast')
  })
})
