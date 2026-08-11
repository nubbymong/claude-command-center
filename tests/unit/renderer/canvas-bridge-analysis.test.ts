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

describe('contrast is covered by SOMEBODY on the analysis path', () => {
  // The regression: axe returns color-contrast as `incomplete` — neither pass
  // nor fail — whenever the foreground has alpha, the text overlaps, the content
  // is generated, or the font is an icon font. The old code discarded
  // `incomplete` AND stood the measurement pass down globally the moment axe
  // ran, so these nodes were checked by nobody, on the only path production uses.
  it('reports low contrast even when the foreground has alpha (axe declines it)', async () => {
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
