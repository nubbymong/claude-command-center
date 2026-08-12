// @vitest-environment jsdom
// How axe's findings become the snapshot's issues.
//
// axe fires on whichever element owns the text; the snapshot emits only the
// nodes it considers meaningful. Everything interesting lives in that gap, and
// the gap had no coverage at all — round 4 found that deleting the join outright
// left 4,123 tests green.
//
// The analysis module is a controllable fake here rather than real axe-core, on
// purpose: under jsdom axe declines every contrast check for want of layout, so
// real axe cannot produce the three-different-ratios case this file exists for.
// What is under test is the JOIN, and the join's input is exactly this shape.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { AxeViolation } from '../../../src/main/canvas/bridge/analysis-loader'

let violations: AxeViolation[] = []
let incomplete: AxeViolation[] = []
let passes: AxeViolation[] = []

vi.mock('../../../src/main/canvas/bridge/analysis-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/canvas/bridge/analysis-loader')>()
  return {
    ...actual,
    ensureAnalysis: async () => ({
      version: 'fake',
      run: async () => ({ violations, incomplete, passes }),
    }),
  }
})

import { captureSnapshot } from '../../../src/main/canvas/bridge/snapshot'
import { stubLayout } from './canvas-bridge-harness'
import type { AxeIssue, CanvasSnapshotResult, SnapshotNode } from '../../../src/shared/canvas'

function flatten(node: SnapshotNode, out: SnapshotNode[] = []): SnapshotNode[] {
  out.push(node)
  for (const child of node.children) flatten(child, out)
  return out
}

function nodeFor(result: CanvasSnapshotResult, uxId: string): SnapshotNode | undefined {
  return flatten(result.root).find((n) => n.uxId === uxId)
}

function contrast(selector: string, ratio: number): AxeViolation {
  return {
    id: 'color-contrast',
    impact: 'serious',
    nodes: [
      {
        element: document.querySelector(selector) as Element,
        impact: 'serious',
        any: [{ data: { contrastRatio: ratio, expectedContrastRatio: '4.5:1' } }],
      },
    ],
  }
}

beforeAll(() => {
  stubLayout()
})

beforeEach(() => {
  document.body.innerHTML = ''
  violations = []
  incomplete = []
  passes = []
})

/**
 * Three sibling wrappers the snapshot does NOT emit as nodes of their own,
 * inside one region that it does — the commonest shape on any price list.
 *
 * Each one owns text AND an element child, which is what keeps it out of the
 * tree: a leaf with text earns a line, a wrapper does not. They still have
 * boxes, because in a real browser they do, and the box is the whole point.
 */
function threePriceWrappers(): void {
  document.body.innerHTML = `
    <main data-ux-id="pricing" data-test-box="0,0,900,400">
      <div class="price" id="p1" data-test-box="10,20,80,24"><i></i>$9</div>
      <div class="price" id="p2" data-test-box="10,60,80,24"><i></i>$19</div>
      <div class="price" id="p3" data-test-box="10,100,80,24"><i></i>$29</div>
    </main>`
}

describe('findings attributed to a shared ancestor', () => {
  it('keeps all three when three different defects walk up to the same node', async () => {
    threePriceWrappers()
    violations = [contrast('#p1', 2.47), contrast('#p2', 3.11), contrast('#p3', 1.98)]

    const result = await captureSnapshot({ analysis: true })
    const issues = nodeFor(result, 'pricing')?.issues ?? []

    // Deduping on the RULE alone kept one of these and dropped two real
    // defects — silently, with nothing in the output to say so.
    expect(issues.map((i) => i.measured).sort()).toEqual(['1.98:1', '2.47:1', '3.11:1'])
  })

  it('says WHERE each one is, so the ancestor is not a dead end', async () => {
    threePriceWrappers()
    violations = [contrast('#p1', 2.47), contrast('#p2', 3.11)]

    const result = await captureSnapshot({ analysis: true })
    const issues = nodeFor(result, 'pricing')?.issues ?? []

    // "main has a contrast problem" is not actionable; the offending
    // descendant's box is what makes it so.
    expect(issues).toHaveLength(2)
    expect(issues.map((i) => i.at)).toEqual([
      { x: 10, y: 20, width: 80, height: 24 },
      { x: 10, y: 60, width: 80, height: 24 },
    ])
  })

  it('leaves `at` off when the finding is on the node itself', async () => {
    document.body.innerHTML = `<button data-ux-id="save" data-test-box="0,0,48,48">Save</button>`
    violations = [contrast('[data-ux-id="save"]', 2.1)]

    const result = await captureSnapshot({ analysis: true })
    const issues = nodeFor(result, 'save')?.issues ?? []
    expect(issues).toHaveLength(1)
    expect(issues[0].at).toBeUndefined()
  })

  it('keeps two identical defects that are in two different places', async () => {
    // Two wrappers styled the same way measure the same ratio, so rule,
    // severity, measured and needed are all identical and only the location
    // differs. That is the commonest way for one CSS mistake to appear twice,
    // and collapsing it tells the agent to fix one of them.
    threePriceWrappers()
    violations = [contrast('#p1', 2.47), contrast('#p2', 2.47)]

    const result = await captureSnapshot({ analysis: true })
    const issues = nodeFor(result, 'pricing')?.issues ?? []
    expect(issues).toHaveLength(2)
    expect(issues.map((i) => i.at!.y)).toEqual([20, 60])
  })

  it('still collapses two findings that really are the same finding', async () => {
    document.body.innerHTML = `<main data-ux-id="region" data-test-box="0,0,900,400">
      <div class="wrap"><span id="only">text</span></div>
    </main>`
    violations = [contrast('#only', 2.47), contrast('#only', 2.47)]

    const result = await captureSnapshot({ analysis: true })
    expect(nodeFor(result, 'region')?.issues ?? []).toHaveLength(1)
  })

  it('does not read "axe never looked" as "axe passed it"', async () => {
    // axe's contrast rule does not MATCH an element it considers invisible on
    // screen — the `left: -9999px` family, a closed `<details>` — so such an
    // element appears in violations, incomplete and passes alike: nowhere. The
    // rule "measurement covers what axe returned as incomplete" then reads that
    // silence as a verdict and covers it with nobody, so turning analysis ON
    // removed a finding that turning it off produced.
    const markup = `<p data-ux-id="grey" data-test-box="0,0,300,20"
        style="color: rgb(170,170,170); background-color: rgb(255,255,255); font-size: 14px">Low contrast</p>`

    document.body.innerHTML = markup
    const degraded = await captureSnapshot({ analysis: false })

    document.body.innerHTML = markup
    // axe ran, found other things, and said nothing whatsoever about this node.
    violations = [
      { id: 'button-name', impact: 'critical', nodes: [{ element: document.body, impact: 'critical' }] },
    ]
    const analysed = await captureSnapshot({ analysis: true })

    const rulesOf = (r: CanvasSnapshotResult) => (nodeFor(r, 'grey')?.issues ?? []).map((i) => i.rule)
    expect(rulesOf(degraded)).toContain('color-contrast')
    expect(rulesOf(analysed)).toContain('color-contrast')
  })

  it('reports a node axe FAILED once, not twice', async () => {
    // A failing verdict is still a verdict. The measurement pass would find the
    // same defect and phrase it differently, so the agent would be told about
    // one problem twice with no way to know it was one.
    //
    // The ratio axe reports here is deliberately NOT the one the measurement
    // pass computes for these colours (2.32:1). Matching them would let the
    // join's dedupe collapse the pair and hide the double coverage — which is
    // what the first draft of this test did, and it passed against the bug.
    document.body.innerHTML = `<p data-ux-id="grey" data-test-box="0,0,300,20"
        style="color: rgb(170,170,170); background-color: rgb(255,255,255); font-size: 14px">Low contrast</p>`
    violations = [contrast('[data-ux-id="grey"]', 1.11)]

    const result = await captureSnapshot({ analysis: true })
    const contrasts = (nodeFor(result, 'grey')?.issues ?? []).filter((i) => i.rule === 'color-contrast')
    expect(contrasts).toHaveLength(1)
    expect(contrasts[0].measured).toBe('1.11:1')
  })

  it('stands measurement down on a node axe DID reach a verdict on', async () => {
    // The other half: a verdict, even a passing one, is axe's to own. Covering
    // it again would report a finding axe explicitly cleared.
    document.body.innerHTML = `<p data-ux-id="grey" data-test-box="0,0,300,20"
        style="color: rgb(170,170,170); background-color: rgb(255,255,255); font-size: 14px">Low contrast</p>`
    const el = document.querySelector('[data-ux-id="grey"]') as Element
    passes = [{ id: 'color-contrast', nodes: [{ element: el }] }]

    const result = await captureSnapshot({ analysis: true })
    expect((nodeFor(result, 'grey')?.issues ?? []).map((i) => i.rule)).not.toContain('color-contrast')
  })

  it('bounds how many findings one node can absorb', async () => {
    // Attributing to an ancestor CONCENTRATES findings, so widening the dedupe
    // key needs a ceiling or a page of 4,000 low-contrast wrappers builds 4,000
    // issue objects on one node and clones every one across postMessage.
    const wrappers = Array.from({ length: 60 }, (_, i) => `<div class="w"><span id="s${i}">t${i}</span></div>`).join('')
    document.body.innerHTML = `<main data-ux-id="region" data-test-box="0,0,900,400">${wrappers}</main>`
    violations = Array.from({ length: 60 }, (_, i) => contrast(`#s${i}`, 1 + i / 100))

    const result = await captureSnapshot({ analysis: true })
    const issues: AxeIssue[] = nodeFor(result, 'region')?.issues ?? []
    expect(issues.length).toBeLessThanOrEqual(20)
    expect(issues.length).toBeGreaterThan(1)
  })
})
