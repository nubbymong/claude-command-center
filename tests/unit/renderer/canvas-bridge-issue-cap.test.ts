// @vitest-environment jsdom
// What survives when one node has more findings than the wire allows.
//
// Three passes contribute issues to a node — measurement, overlap, and the axe
// join — and for four rounds none of them knew what the others had spent. The
// cap tested `node.issues.length`, the overlap pass ran first, and twenty-one
// overlapping boxes therefore erased a `critical` missing button name to make
// room for twenty `moderate` overlaps. A cap the cheapest finding can exhaust
// is not a budget; it is a race, and the agent is told the node is clean.
//
// The analysis module is a controllable fake (see canvas-bridge-axe-join.test.ts
// for why): under jsdom real axe declines every contrast check for want of
// layout, and what is under test here is the accounting, not axe.

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
import { MAX_ISSUES_PER_NODE } from '../../../src/shared/canvas'
import type { CanvasSnapshotResult, SnapshotNode } from '../../../src/shared/canvas'

function flatten(node: SnapshotNode, out: SnapshotNode[] = []): SnapshotNode[] {
  out.push(node)
  for (const child of node.children) flatten(child, out)
  return out
}

function nodeFor(result: CanvasSnapshotResult, uxId: string): SnapshotNode | undefined {
  return flatten(result.root).find((n) => n.uxId === uxId)
}

function rulesOf(node: SnapshotNode | undefined): string[] {
  return (node?.issues ?? []).map((i) => i.rule)
}

/** An axe result naming one element, with the impact the caller cares about. */
function violation(id: string, selector: string, impact: string): AxeViolation {
  return {
    id,
    impact,
    nodes: [{ element: document.querySelector(selector) as Element, impact }],
  }
}

beforeAll(() => {
  stubLayout()
})

beforeEach(() => {
  document.body.innerHTML = ''
  violations = []
})

describe('a node with more findings than it can carry', () => {
  it('does not let overlapping boxes erase a critical missing name', async () => {
    // The reported repro, exactly: one nameless payment button under a pile of
    // in-flow boxes that sit on top of it. The overlaps are `moderate`; the
    // missing name is `critical` and is the only one a reviewer would act on.
    const pileup = Array.from(
      { length: 21 },
      (_, i) => `<div data-test-box="0,${i + 1},300,300">row ${i}</div>`,
    ).join('')
    document.body.innerHTML = `<button data-ux-id="pay" data-test-box="0,0,300,300"></button>${pileup}`
    violations = [violation('button-name', '[data-ux-id="pay"]', 'critical')]

    const result = await captureSnapshot({ analysis: true })
    expect(rulesOf(nodeFor(result, 'pay'))).toContain('button-name')
  })

  it('keeps a critical that axe reports after the node is already full', async () => {
    // axe emits in RULE order, so a missing-name finding routinely arrives
    // behind a page's worth of contrast findings. Arriving late is not a reason
    // to be dropped: the cap is a memory bound, not a ranking.
    //
    // Thirty plain wrappers, each with its OWN box so the dedupe treats them as
    // thirty findings rather than one. Which element the fake names is not the
    // point — what is under test is which finding survives the cap.
    const wrappers = Array.from(
      { length: 30 },
      (_, i) => `<div class="w" id="w${i}" data-test-box="10,${i * 10},80,24"><span>t${i}</span></div>`,
    ).join('')
    document.body.innerHTML = `<main data-ux-id="region" data-test-box="0,0,900,400">${wrappers}
      <div class="w" id="crit" data-test-box="10,700,80,24"><span>x</span></div></main>`
    violations = [
      ...Array.from({ length: 30 }, (_, i) => violation('color-contrast', `#w${i}`, 'moderate')),
      violation('button-name', '#crit', 'critical'),
    ]

    const region = nodeFor(await captureSnapshot({ analysis: true }), 'region')
    expect(rulesOf(region)).toContain('button-name')
    // …and the bound still holds: it traded one out, it did not grow.
    expect(region?.issues?.length).toBeLessThanOrEqual(MAX_ISSUES_PER_NODE)
  })

  it('says how many findings it could not carry, rather than reporting a short list as complete', async () => {
    // A realistic card grid: every card's price fails contrast, and they all
    // attribute to the one region the snapshot emits. Twenty-four defects
    // became twenty with nothing said, so the agent read four as fixed.
    const cards = Array.from({ length: 24 }, (_, i) => `<div class="card"><span id="c${i}">$${i}</span></div>`).join('')
    document.body.innerHTML = `<main data-ux-id="grid" data-test-box="0,0,900,400">${cards}</main>`
    violations = Array.from({ length: 24 }, (_, i) => ({
      id: 'color-contrast',
      impact: 'serious',
      nodes: [
        {
          element: document.querySelector(`#c${i}`) as Element,
          impact: 'serious',
          any: [{ data: { contrastRatio: 1 + i / 100, expectedContrastRatio: '4.5:1' } }],
        },
      ],
    }))

    const grid = nodeFor(await captureSnapshot({ analysis: true }), 'grid')
    expect(grid?.issues?.length).toBeLessThanOrEqual(MAX_ISSUES_PER_NODE)
    // The bridge reports a COUNT; the boundary turns it into words. Four went to
    // the axe cap, and the rest to the per-node wire cap.
    expect(grid?.issuesDropped).toBeGreaterThanOrEqual(4)
  })

  it('spends the last slots on severity, not on whichever pass ran first', async () => {
    // The shape that made the old accounting look fine in isolation: the
    // overlap pass fits inside its own share, the axe pass fits inside its own
    // share, and TOGETHER they are half again what the wire allows. Which ones
    // survive is then decided here and nowhere else — and `overlap` is the
    // least severe thing this bridge reports, so none of them should.
    const wrappers = Array.from(
      { length: 20 },
      (_, i) => `<div class="w" id="w${i}" data-test-box="10,${i * 10},80,24"><span>t${i}</span></div>`,
    ).join('')
    const siblings = Array.from(
      { length: 8 },
      (_, i) => `<div data-test-box="0,${i + 1},900,900">sibling ${i}</div>`,
    ).join('')
    document.body.innerHTML = `<main data-ux-id="hot" data-test-box="0,0,900,900">heading${wrappers}</main>${siblings}`
    violations = Array.from({ length: 20 }, (_, i) => violation('color-contrast', `#w${i}`, 'serious'))

    const hot = nodeFor(await captureSnapshot({ analysis: true }), 'hot')
    const rules = rulesOf(hot)
    expect(rules.filter((r) => r === 'overlap')).toHaveLength(0)
    expect(rules.filter((r) => r === 'color-contrast')).toHaveLength(MAX_ISSUES_PER_NODE)
    // Twenty of twenty-eight survive, and the count says so exactly: this is
    // the one path where nothing is a lower bound. (The slot the truncation
    // marker occupies is reserved at the trust boundary, not here — the bridge
    // is inside the page and its word for "some are missing" is a number.)
    expect(hot?.issuesDropped).toBe(8)
  })

  it('records the overlap cap as a drop instead of stopping silently', async () => {
    const pileup = Array.from(
      { length: 12 },
      (_, i) => `<div data-test-box="0,${i + 1},300,300">row ${i}</div>`,
    ).join('')
    document.body.innerHTML = `<div data-ux-id="first" data-test-box="0,0,300,300">first</div>${pileup}`

    const first = nodeFor(await captureSnapshot({ analysis: false }), 'first')
    expect(rulesOf(first).filter((r) => r === 'overlap').length).toBeLessThan(12)
    expect(first?.issuesDropped).toBeGreaterThan(0)
  })

  it('leaves an ordinary node with no drop count at all', async () => {
    // The counter must not fire on a page that fits, or every snapshot arrives
    // claiming findings are missing and the agent re-scopes forever.
    document.body.innerHTML = `<button data-ux-id="ok" data-test-box="0,0,120,40">Save</button>`
    violations = [violation('button-name', '[data-ux-id="ok"]', 'critical')]

    const ok = nodeFor(await captureSnapshot({ analysis: true }), 'ok')
    expect(ok?.issuesDropped).toBeUndefined()
    expect(rulesOf(ok)).toContain('button-name')
  })

  it('does not count a duplicate finding as a dropped one', async () => {
    document.body.innerHTML = `<button data-ux-id="dup" data-test-box="0,0,120,40">Save</button>`
    const one = violation('button-name', '[data-ux-id="dup"]', 'critical')
    violations = [one, { ...one, nodes: [...one.nodes] }]

    const dup = nodeFor(await captureSnapshot({ analysis: true }), 'dup')
    expect(rulesOf(dup).filter((r) => r === 'button-name')).toHaveLength(1)
    expect(dup?.issuesDropped).toBeUndefined()
  })

  it('does not collapse a critical into an identical moderate', async () => {
    // Same rule, same measurement, same place, different impact. The dedupe key
    // omitted severity, so whichever arrived first won — and axe's order is not
    // the reviewer's.
    document.body.innerHTML = `<main data-ux-id="both" data-test-box="0,0,900,400">
      <div class="w"><span id="t">text</span></div></main>`
    violations = [violation('color-contrast', '#t', 'moderate'), violation('color-contrast', '#t', 'critical')]

    const issues = nodeFor(await captureSnapshot({ analysis: true }), 'both')?.issues ?? []
    expect(issues.filter((i) => i.rule === 'color-contrast').map((i) => i.severity).sort()).toEqual([
      'critical',
      'moderate',
    ])
  })
})
