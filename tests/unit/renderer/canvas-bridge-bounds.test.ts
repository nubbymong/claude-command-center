// @vitest-environment jsdom
// The bounds the BRIDGE enforces, inside the page, before anything is posted.
//
// The sanitiser re-checks all of these and has good coverage of its own, which
// is exactly why they went untested here: a snapshot that blows the bridge's
// limits still arrives correct, so nothing downstream notices. What is lost is
// the reason the bridge has limits at all — everything it builds is built on
// the renderer's UI thread and structured-cloned across postMessage, so an
// unbounded walk is a frozen window and a multi-megabyte message that the
// sanitiser then dutifully trims to nothing.
//
// Round 5's mutation run deleted MAX_DEPTH, the truncation report, the
// value-length ceiling and the analysis run timeout, and the whole suite stayed
// green.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'

let runImpl: () => Promise<{ violations: unknown[]; incomplete: unknown[] }> = async () => ({
  violations: [],
  incomplete: [],
})

vi.mock('../../../src/main/canvas/bridge/analysis-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/canvas/bridge/analysis-loader')>()
  return { ...actual, ensureAnalysis: async () => ({ version: 'fake', run: () => runImpl() }) }
})

import { captureSnapshot } from '../../../src/main/canvas/bridge/snapshot'
import { ANALYSIS_RUN_TIMEOUT_MS } from '../../../src/main/canvas/bridge/analysis-loader'
import { stubLayout } from './canvas-bridge-harness'
import type { SnapshotNode } from '../../../src/shared/canvas'

function countNodes(node: SnapshotNode): number {
  return 1 + node.children.reduce((n, c) => n + countNodes(c), 0)
}

function depthOf(node: SnapshotNode): number {
  return node.children.length === 0 ? 1 : 1 + Math.max(...node.children.map(depthOf))
}

function flatten(node: SnapshotNode, out: SnapshotNode[] = []): SnapshotNode[] {
  out.push(node)
  for (const child of node.children) flatten(child, out)
  return out
}

beforeAll(() => stubLayout())
beforeEach(() => {
  document.body.innerHTML = ''
  runImpl = async () => ({ violations: [], incomplete: [] })
})

describe('the walk is bounded where it is BUILT, not only where it is received', () => {
  // An explicit timeout, because this fixture is the slowest thing in the unit
  // suite and the default 10s was never headroom: it measures ~1.4s alone and
  // roughly seven times that under a full parallel run, so it sat one new test
  // FILE away from failing and eventually got three. The cost is not the walk —
  // it is jsdom's `getComputedStyle`, which is O(document) per call, making
  // 5,000 elements quadratic here and nothing like a browser. Timing the bridge
  // under jsdom measures jsdom.
  //
  // The fixture cannot be smaller: MAX_NODES is 4,000 and the point is to
  // exceed it.
  it('stops at the node cap and says the tree is partial', { timeout: 60_000 }, async () => {
    // 5,000 text leaves, each meaningful and each with a box. Low-contrast, so
    // that anything which measures them leaves evidence behind.
    const grey = 'color: rgb(170,170,170); background-color: rgb(255,255,255); font-size: 14px'
    const rows = Array.from({ length: 5000 }, (_, i) => `<p data-test-box="0,${i},80,16" style="${grey}">r${i}</p>`).join('')
    document.body.innerHTML = rows

    const result = await captureSnapshot({ analysis: false })
    expect(countNodes(result.root)).toBeLessThanOrEqual(4001)
    expect(result.truncated).toBe(true)
    // The thousand leaves past the cap must not come back through the
    // un-emitted-text pass. They are not un-emitted wrappers: they are
    // MEANINGFUL nodes this capture has already declared lost, and measuring
    // them anyway would attribute findings to ancestors for nodes the same
    // report says are missing — a page that says "partial" and then reports on
    // the part it dropped.
    //
    // `at` is the tell: it is set only when a finding is attributed to a node
    // other than the one it fired on, which is exactly what that pass does.
    const attributed = flatten(result.root).flatMap((n) => n.issues ?? []).filter((i) => i.at)
    expect(attributed).toHaveLength(0)
  })

  it('stops collecting un-emitted text owners at the cap', { timeout: 60_000 }, async () => {
    // The owner list is the one collection a page fills without earning a node,
    // so the node cap does not bound it. 4,001 wrappers, each owning text and
    // each disqualified from a node of its own by one empty child.
    //
    // The count is what shows the cap: every owner past the per-host ceiling is
    // charged as a drop, so 4,000 collected leaves 20 kept and 3,980 counted.
    // One more collected would be one more counted.
    const grey = 'color: rgb(170,170,170); background-color: rgb(255,255,255); font-size: 14px'
    const rows = Array.from(
      { length: 4001 },
      (_, i) => `<div data-test-box="0,${i},80,16" style="${grey}">r${i}<i></i></div>`,
    ).join('')
    document.body.innerHTML = rows

    const result = await captureSnapshot({ analysis: false })
    expect(result.root.issuesDropped).toBe(3980)
  })

  it('stops at the depth cap and says so in its own words', async () => {
    // A single chain far past the cap. Non-semantic wrappers splice their
    // children up a level, so each level carries a box AND a role to earn a
    // line of its own — otherwise the whole chain collapses and measures 1 deep.
    let html = '<p data-ux-id="deepest" data-test-box="0,0,80,16">bottom</p>'
    for (let i = 0; i < 200; i++) html = `<section aria-label="l${i}" data-test-box="0,0,80,16">${html}</section>`
    document.body.innerHTML = html

    const result = await captureSnapshot({ analysis: false })
    expect(depthOf(result.root)).toBeLessThanOrEqual(66)
    // …and the report is the point: a tree that just stops, with nothing said,
    // reads to the agent as a page that ends there.
    expect(result.depthLimited).toBe(true)
    expect(flatten(result.root).some((n) => n.uxId === 'deepest')).toBe(false)
    // NOT `truncated`. That flag means nodes were dropped and drives a note
    // blaming the node limit — a limit that did not fire here.
    expect(result.truncated).toBeUndefined()
  })

  it('never calls a deeply-nested page node-TRUNCATED, whatever it lost', async () => {
    // 70 levels of wrappers past the cap. `truncated` reads to the agent as
    // "the page exceeded the snapshot node limit" and that limit did not fire —
    // it told every capture of any app with deep providers or portals that the
    // tree was partial, forever, and cost a second full capture each time.
    let html = ''
    for (let i = 0; i < 70; i++) html = `<div>${html}</div>`
    document.body.innerHTML = `<p data-test-box="0,0,80,16">visible</p>${html}`

    const result = await captureSnapshot({ analysis: false })
    expect(result.truncated).toBeUndefined()
    // The depth flag DOES fire, and correctly: there is DOM below the cap that
    // was not walked. Whether it held anything is unknowable without walking
    // it, which is the thing the cap exists to refuse — so the claim is scoped
    // to what is certain. The one case it can rule out is the next test.
    expect(result.depthLimited).toBe(true)
  })

  it('says nothing when the element it refused was an empty leaf', async () => {
    // The only over-claim it can cheaply avoid: the refused element itself has
    // no children and is not meaningful, so nothing was behind it.
    let html = '<div></div>'
    for (let i = 0; i < 64; i++) html = `<div>${html}</div>`
    document.body.innerHTML = `<p data-test-box="0,0,80,16">visible</p>${html}`

    const result = await captureSnapshot({ analysis: false })
    expect(result.depthLimited).toBeUndefined()
    expect(result.truncated).toBeUndefined()
  })

  it('does not report a depth limit for a tag that never contributes', async () => {
    // Exactly at the boundary: 64 wrappers, so the innermost sits at the last
    // depth the walk accepts and its child is the first thing refused. A
    // <script> there is refused for being a <script>, and refusing one loses
    // nothing at any depth.
    const nest = (leaf: string) => {
      let html = leaf
      for (let i = 0; i < 64; i++) html = `<div>${html}</div>`
      return html
    }
    document.body.innerHTML = nest('<script>void 0</script>')
    expect((await captureSnapshot({ analysis: false })).depthLimited).toBeUndefined()

    // A skipped tag with markup inside it reaches the same answer — and it does
    // so through the empty-leaf guard rather than through the ordering, because
    // a parser keeps `<noscript>`'s content as TEXT and `<template>`'s in a
    // DocumentFragment, so neither has element children to count.
    document.body.innerHTML = nest('<noscript><div><p>text</p></div></noscript>')
    expect((await captureSnapshot({ analysis: false })).depthLimited).toBeUndefined()

    // The control: an element that WOULD have been walked, at the same depth,
    // does report it. Without this the assertion above passes for any reason.
    document.body.innerHTML = nest('<p data-test-box="0,0,80,16">too deep</p>')
    expect((await captureSnapshot({ analysis: false })).depthLimited).toBe(true)
  })

  it('says nothing about truncation for a page that fits', async () => {
    document.body.innerHTML = Array.from({ length: 20 }, (_, i) => `<p data-test-box="0,${i},80,16">r${i}</p>`).join('')
    const result = await captureSnapshot({ analysis: false })
    expect(result.truncated).toBeUndefined()
    expect(result.depthLimited).toBeUndefined()
  })
})

describe('what a field holds is a bounded number', () => {
  it('caps the reported length rather than echoing whatever the page set', async () => {
    document.body.innerHTML = `<input data-ux-id="big" data-test-box="0,0,200,32" />`
    const input = document.querySelector('input') as HTMLInputElement
    // Not typed by a human — set by the page, which is the point.
    input.value = 'x'.repeat(3_000_000)

    const node = flatten((await captureSnapshot({ analysis: false })).root).find((n) => n.uxId === 'big')
    expect(node?.state?.valueLength).toBe(1_000_000)
  })

  it('reports a real length unchanged, so the cap is a cap and not a constant', async () => {
    document.body.innerHTML = `<input data-ux-id="small" data-test-box="0,0,200,32" />`
    ;(document.querySelector('input') as HTMLInputElement).value = 'hello'

    const node = flatten((await captureSnapshot({ analysis: false })).root).find((n) => n.uxId === 'small')
    expect(node?.state?.valueLength).toBe(5)
  })
})

describe('a wedged analysis cannot hold the reply open', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('gives up on a run that never settles and reports it as a failure', async () => {
    // axe is a singleton and a page can keep it busy; without the timeout the
    // snapshot promise never settles, and the broker's own timeout fires with
    // the capture still running inside the frame.
    vi.useFakeTimers()
    runImpl = () => new Promise(() => {})
    document.body.innerHTML = `<p data-ux-id="p" data-test-box="0,0,80,16">text</p>`

    const capture = captureSnapshot({ analysis: true })
    await vi.advanceTimersByTimeAsync(ANALYSIS_RUN_TIMEOUT_MS + 1000)
    const result = await capture

    expect(result.analysisError).toBe('run-failed')
    // The snapshot itself still arrives — measurement is unaffected.
    expect(flatten(result.root).some((n) => n.uxId === 'p')).toBe(true)
  })
})
