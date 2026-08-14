// @vitest-environment jsdom
// The ANALYSIS path — the one `canvas_snapshot` actually takes.
//
// Every other bridge test passes `analysis: false`, because the loader's
// `import('/__ccc__/canvas-analysis.js')` can never resolve under jsdom. That is
// not a detail: it is why two rounds of adversarial review could not see that
// axe-core was bundled as an IIFE and never ran at all, and why the round that
// fixed that could not see that the join and the contrast arbitration were
// broken underneath it. A green suite meant nothing here.
//
// So this file points the loader at the real analysis module and runs genuine
// axe-core over a jsdom document. Geometry is still stubbed (jsdom has no
// layout), but the rules, the results, and the join are real.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'

vi.mock('../../../src/main/canvas/bridge/analysis-loader', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/main/canvas/bridge/analysis-loader')>()
  const real = await import('../../../src/main/canvas/bridge/analysis')
  return { ...actual, ensureAnalysis: async () => real }
})

import { captureSnapshot } from '../../../src/main/canvas/bridge/snapshot'
import { stubLayout } from './canvas-bridge-harness'
import type { CanvasSnapshotResult, SnapshotNode } from '../../../src/shared/canvas'

function flatten(node: SnapshotNode, out: SnapshotNode[] = []): SnapshotNode[] {
  out.push(node)
  for (const child of node.children) flatten(child, out)
  return out
}

function nodeFor(result: CanvasSnapshotResult, uxId: string): SnapshotNode | undefined {
  return flatten(result.root).find((n) => n.uxId === uxId)
}

function rules(node: SnapshotNode | undefined): string[] {
  return (node?.issues ?? []).map((i) => i.rule)
}

beforeAll(() => {
  stubLayout()
})

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('axe actually runs and its results actually land', () => {
  it('produces real findings and attaches them to the right node', async () => {
    document.body.innerHTML = `
      <button data-ux-id="nameless" data-test-box="0,0,48,48"></button>
      <button data-ux-id="named" data-test-box="0,60,48,48">Save</button>
    `
    const result = await captureSnapshot({ analysis: true })

    // If this is empty the chunk did not load, the rules did not run, or the
    // join dropped everything — the three failures that hid behind each other.
    expect(result.analysisError).toBeUndefined()
    expect(rules(nodeFor(result, 'nameless'))).toContain('button-name')
    expect(rules(nodeFor(result, 'named'))).not.toContain('button-name')

    const issue = (nodeFor(result, 'nameless')!.issues ?? []).find((i) => i.rule === 'button-name')!
    expect(issue.severity).toBeTruthy() // populated, not a placeholder
  })

  it('runs the real rule set, not a stub', async () => {
    // Guards the failure that shipped: the chunk was bundled as an IIFE, so the
    // module namespace was empty, `run` was not a function, and every capture
    // silently took the degraded path. `analysisError` stayed undefined because
    // degradation WAS the only path. Assert on real rule output instead.
    document.body.innerHTML = `<a data-ux-id="bare" href="#x" data-test-box="0,0,40,40"></a>`
    const result = await captureSnapshot({ analysis: true })
    expect(result.analysisError).toBeUndefined()
    expect(rules(nodeFor(result, 'bare'))).toContain('link-name')
  })
})

// axe publishes itself onto `window`, and that global IS the object the analysis
// module calls. The page shares a realm with the bridge and cannot be locked out
// of it — what these pin is that the ONE-LINE versions do not work, and that
// nothing silently reports a clean pass when a page has interfered.
describe('a page cannot quietly switch the analysis off', () => {
  const axeGlobal = () => (window as unknown as { axe?: Record<string, unknown> }).axe

  // Rule configuration lives in axe's own state, so capturing the function
  // references does not protect the rule set — only resetting it does.
  //
  // Note which attack is NOT here: `{ rules: [{ id, enabled: false }] }` fails
  // whether or not the reset happens, because the run pins its rule set with
  // `runOnly`. A test built on that would have asserted a property that holds
  // for an unrelated reason and reported the reset as guarded when it was not.
  // These two do work, and are the reason the reset exists.
  it.each([
    [
      'rewrites the rule to use an always-passing check',
      {
        checks: [{ id: 'always-ok', evaluate: 'function () { return true; }' }],
        rules: [{ id: 'link-name', any: ['always-ok'], all: [], none: [] }],
      },
    ],
    ['narrows the rule until it matches nothing', { rules: [{ id: 'link-name', selector: '#nothing-matches' }] }],
  ])('still reports the finding when the page %s', async (_label, config) => {
    document.body.innerHTML = `<a data-ux-id="bare" href="#x" data-test-box="0,0,40,40"></a>`
    // Warm the loader so `window.axe` exists to be tampered with.
    await captureSnapshot({ analysis: true })
    ;(axeGlobal()!.configure as (o: unknown) => void)(config)

    const result = await captureSnapshot({ analysis: true })
    expect(result.analysisError).toBeUndefined()
    expect(rules(nodeFor(result, 'bare'))).toContain('link-name')
  })

  it('keeps using the real run() after the page replaces window.axe.run', async () => {
    // The one-liner: `window.axe.run = async () => ({ violations: [] })`
    // silences every rule, nothing throws, no analysisError is raised, and the
    // agent is told the pass ran clean.
    document.body.innerHTML = `<a data-ux-id="bare" href="#x" data-test-box="0,0,40,40"></a>`
    await captureSnapshot({ analysis: true })
    const real = axeGlobal()!.run
    axeGlobal()!.run = async () => ({ violations: [], incomplete: [], passes: [] })
    try {
      const result = await captureSnapshot({ analysis: true })
      expect(result.analysisError).toBeUndefined()
      expect(rules(nodeFor(result, 'bare'))).toContain('link-name')
    } finally {
      axeGlobal()!.run = real
    }
  })
})

describe('contrast is covered by SOMEBODY on the analysis path', () => {
  // The regression: axe returns color-contrast as `incomplete` — neither pass
  // nor fail — whenever the foreground has alpha, the text overlaps, the content
  // is generated, or the font is an icon font. The old code discarded
  // `incomplete` AND stood the measurement pass down globally the moment axe
  // ran, so these nodes were checked by nobody, on the only path production uses.
  //
  // WHAT THESE ACTUALLY PIN, AND WHAT THEY DO NOT. jsdom has no layout, so axe
  // declines EVERY contrast check here — 100% `incomplete`, against 14–50% in a
  // real browser. So every case below exercises the "axe declined, does anyone
  // else cover it?" branch, which is precisely the branch that regressed. None
  // of them exercises the mix, and none of them demonstrates that a particular
  // CSS construct is the reason axe declined: under jsdom the reason is always
  // the missing layout. A real browser is the only place that distinction can
  // be tested, and CI does not run one.
  it('covers a node axe returned no verdict for', async () => {
    // Alpha on the foreground is the classic real-browser reason for a declined
    // check — though NOT for this specific value: measured in headless Chromium,
    // rgba(0,0,0,0.28) on white comes back as a violation, not `incomplete`. It
    // is here as an ordinary node that axe did not judge, which under jsdom is
    // all of them.
    document.body.innerHTML = `
      <p data-ux-id="faded" data-test-box="0,0,300,20"
         style="color: rgba(0,0,0,0.28); background-color: rgb(255,255,255); font-size: 14px">Terms apply</p>
    `
    const withAxe = await captureSnapshot({ analysis: true })
    expect(withAxe.analysisError).toBeUndefined()
    expect(rules(nodeFor(withAxe, 'faded'))).toContain('color-contrast')
  })

  it('does not lose the finding that the measurement-only path already caught', async () => {
    const markup = `
      <p data-ux-id="grey" data-test-box="0,0,300,20"
         style="color: rgb(170,170,170); background-color: rgb(255,255,255); font-size: 14px">Low contrast body text</p>
    `
    document.body.innerHTML = markup
    const degraded = await captureSnapshot({ analysis: false })
    document.body.innerHTML = markup
    const analysed = await captureSnapshot({ analysis: true })

    // Turning analysis ON must never REMOVE a finding turning it off would give.
    // That is exactly what happened: 2.32:1 was reported with analysis:false and
    // silently vanished with analysis:true.
    expect(rules(nodeFor(degraded, 'grey'))).toContain('color-contrast')
    expect(rules(nodeFor(analysed, 'grey'))).toContain('color-contrast')
  })

  it('reports each contrast finding once, not twice', async () => {
    document.body.innerHTML = `
      <p data-ux-id="grey" data-test-box="0,0,300,20"
         style="color: rgb(170,170,170); background-color: rgb(255,255,255); font-size: 14px">Low contrast body text</p>
    `
    const result = await captureSnapshot({ analysis: true })
    expect(rules(nodeFor(result, 'grey')).filter((r) => r === 'color-contrast')).toHaveLength(1)
  })
})
