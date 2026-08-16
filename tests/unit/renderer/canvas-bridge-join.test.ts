// @vitest-environment jsdom
// How axe results are ATTRIBUTED to snapshot nodes.
//
// Separate from canvas-bridge-analysis.test.ts because this needs a controlled
// violation, not a real one: the interesting case is a finding on an element the
// snapshot never emitted, and jsdom always downgrades color-contrast to
// `incomplete` (no rendering), so real axe cannot produce that case here. A real
// browser produces it constantly — `<div>Price <span>10</span></div>` is the
// commonest text container there is, and it is not "meaningful", so it is not a
// node. The join used to require an exact element hit and dropped those findings
// on the floor: deleting the entire join left the whole suite green.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { AxeViolation } from '../../../src/main/canvas/bridge/analysis-loader'

/** Whatever the current test put in here is what "axe" will report. */
const staged: { violations: AxeViolation[]; incomplete: AxeViolation[] } = { violations: [], incomplete: [] }

vi.mock('../../../src/main/canvas/bridge/analysis-loader', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/main/canvas/bridge/analysis-loader')>()
  return {
    ...actual,
    ensureAnalysis: async () => ({ version: 'test', run: async () => staged }),
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

function violationOn(el: Element, id = 'color-contrast'): AxeViolation {
  return { id, impact: 'serious', nodes: [{ element: el, impact: 'serious' }] }
}

beforeAll(() => stubLayout())
beforeEach(() => {
  staged.violations = []
  staged.incomplete = []
  document.body.innerHTML = ''
})

describe('joining axe results onto the tree', () => {
  it('attributes a finding on an unemitted wrapper to the nearest emitted ancestor', async () => {
    document.body.innerHTML = `
      <section data-ux-id="panel" data-test-box="0,0,300,80">
        <div id="wrapper" data-test-box="0,0,300,40">Price <span data-test-box="0,0,40,20">10</span></div>
      </section>
    `
    const wrapper = document.getElementById('wrapper')!
    staged.violations = [violationOn(wrapper)]

    const result = await captureSnapshot({ analysis: true })
    const panel = flatten(result.root).find((n) => n.uxId === 'panel')

    // The wrapper is genuinely not a node — assert that, so this cannot start
    // passing for the wrong reason if `isMeaningful` ever changes.
    expect(flatten(result.root).some((n) => n.name === 'Price')).toBe(false)
    expect((panel?.issues ?? []).map((i) => i.rule)).toContain('color-contrast')
  })

  it('still attributes an exact hit to the element itself, not an ancestor', async () => {
    document.body.innerHTML = `
      <section data-ux-id="panel" data-test-box="0,0,300,80">
        <button data-ux-id="cta" data-test-box="0,0,40,40">Buy</button>
      </section>
    `
    staged.violations = [violationOn(document.querySelector('button')!, 'button-name')]

    const result = await captureSnapshot({ analysis: true })
    const all = flatten(result.root)
    expect((all.find((n) => n.uxId === 'cta')?.issues ?? []).map((i) => i.rule)).toContain('button-name')
    expect((all.find((n) => n.uxId === 'panel')?.issues ?? []).map((i) => i.rule)).not.toContain('button-name')
  })

  it('does not climb out of a deeply buried subtree onto the document', async () => {
    // Bounded on purpose: a finding 20 levels below the nearest node says
    // nothing useful about that node, and silently hanging it there would be a
    // different kind of lie from dropping it.
    const deep = Array.from({ length: 12 }, () => '<div>').join('')
    document.body.innerHTML = `
      <section data-ux-id="panel" data-test-box="0,0,300,80">
        ${deep}<i id="buried">x</i>${'</div>'.repeat(12)}
      </section>
    `
    staged.violations = [violationOn(document.getElementById('buried')!)]

    const result = await captureSnapshot({ analysis: true })
    const panel = flatten(result.root).find((n) => n.uxId === 'panel')
    expect((panel?.issues ?? []).map((i) => i.rule)).not.toContain('color-contrast')
  })

  it('does not report the same rule twice on one node', async () => {
    document.body.innerHTML = `<button data-ux-id="cta" data-test-box="0,0,40,40">Buy</button>`
    const btn = document.querySelector('button')!
    staged.violations = [violationOn(btn, 'button-name'), violationOn(btn, 'button-name')]

    const result = await captureSnapshot({ analysis: true })
    const cta = flatten(result.root).find((n) => n.uxId === 'cta')
    expect((cta?.issues ?? []).filter((i) => i.rule === 'button-name')).toHaveLength(1)
  })
})
