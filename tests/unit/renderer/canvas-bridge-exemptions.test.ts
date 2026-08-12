// @vitest-environment jsdom
// The two exemptions that stop the contrast rule, and what they must NOT stop.
//
// Every exemption here is a suppression primitive: what it covers gets no
// contrast finding, and nothing downstream can tell an honest exemption from a
// forged one. So each needs a CONTROL — the same fixture without the exemption
// must produce the finding — or the test passes for the wrong reason, which is
// how the sr-only tests next door came to be rewritten.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { captureSnapshot } from '../../../src/main/canvas/bridge/snapshot'
import { stubLayout } from './canvas-bridge-harness'
import type { SnapshotNode } from '../../../src/shared/canvas'

function flatten(node: SnapshotNode, out: SnapshotNode[] = []): SnapshotNode[] {
  out.push(node)
  for (const child of node.children) flatten(child, out)
  return out
}

const GREY = 'color: rgb(170,170,170); background-color: rgb(255,255,255); font-size: 14px'

async function rulesFor(markup: string, uxId = 'grey'): Promise<string[]> {
  document.body.innerHTML = markup
  const result = await captureSnapshot({ analysis: false })
  const node = flatten(result.root).find((n) => n.uxId === uxId)
  return (node?.issues ?? []).map((i) => i.rule)
}

beforeAll(() => stubLayout())
beforeEach(() => {
  document.body.innerHTML = ''
})

describe('the inactive-control exemption cannot be claimed by a plain wrapper', () => {
  // WCAG 1.4.3 exempts inactive components, and axe drops disabled controls
  // before it consults layout — so the measurement pass has to cover them, and
  // therefore has to know which ones they are. It asked eight ancestors whether
  // ANY of them carried `aria-disabled`, which is state ARIA only defines for
  // widgets: one attribute on one generic `<div>` deleted contrast review for
  // everything inside it. The wrapper is not even emitted, so nothing in the
  // snapshot hinted at why. Component libraries do this routinely.
  const wrapped = (attr: string, depth = 1) => {
    let inner = `<p data-ux-id="grey" data-test-box="0,0,300,20" style="${GREY}">Low contrast</p>`
    for (let i = 0; i < depth; i++) inner = `<div ${i === depth - 1 ? attr : ''} data-test-box="0,0,900,200">${inner}</div>`
    return `<main data-ux-id="root" data-test-box="0,0,900,400">${inner}</main>`
  }

  it('reports the finding when the wrapper carries nothing (the control)', async () => {
    expect(await rulesFor(wrapped(''))).toContain('color-contrast')
  })

  it.each([1, 4, 7])('ignores aria-disabled on a generic ancestor %i level(s) up', async (depth) => {
    expect(await rulesFor(wrapped('aria-disabled="true"', depth))).toContain('color-contrast')
  })

  it('still exempts a control that really is disabled', async () => {
    // The exemption narrowed, not deleted: greyed out IS the design, and
    // reporting it tells a reviewer to fix the thing that works.
    const rules = await rulesFor(
      `<button data-ux-id="grey" disabled data-test-box="0,0,120,32" style="${GREY}">Save</button>`,
    )
    expect(rules).not.toContain('color-contrast')
  })

  it('still exempts a widget marked aria-disabled on itself', async () => {
    const rules = await rulesFor(
      `<div role="button" data-ux-id="grey" aria-disabled="true" data-test-box="0,0,120,32" style="${GREY}">Save</div>`,
    )
    expect(rules).not.toContain('color-contrast')
  })

  it('still honours `inert`, which really does have subtree semantics', async () => {
    // Unlike aria-disabled, `inert` is a real HTML attribute the browser
    // applies to a whole subtree — it removes it from interaction and from the
    // accessibility tree — so an ancestor carrying it is honoured.
    expect(await rulesFor(wrapped('inert', 3))).not.toContain('color-contrast')
  })
})

describe('text on an image is reported as unassessed, not as nothing', () => {
  // The one gap in "axe owns what it FAILED, measurement owns everything else".
  // axe routes text over a background-image to `incomplete` — never to
  // `violations` — so it is not in `contrastFailed`, measurement is asked to
  // cover it, and measurement declines because a photographic backdrop is
  // unknowable without sampling the render. Contrast was then checked by
  // NOBODY, silently, while the capture note said "contrast still applies".
  const IMAGE =
    "background-image: url('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')"

  it('reports the finding when the backdrop is a flat colour (the control)', async () => {
    const rules = await rulesFor(
      `<div data-test-box="0,0,900,200" style="background-color: rgb(255,255,255)">
         <p data-ux-id="grey" data-test-box="0,0,300,20" style="color: rgb(170,170,170); font-size: 14px">Low contrast</p>
       </div>`,
    )
    expect(rules).toContain('color-contrast')
  })

  it('says the check could not be made when an ancestor carries an image', async () => {
    const rules = await rulesFor(
      `<div data-test-box="0,0,900,200" style="background-color: rgb(255,255,255); ${IMAGE}">
         <p data-ux-id="grey" data-test-box="0,0,300,20" style="color: rgb(170,170,170); font-size: 14px">Low contrast</p>
       </div>`,
    )
    expect(rules).not.toContain('color-contrast')
    // Not a defect claim — it cannot be a false positive, because it does not
    // claim a defect. It claims that nobody checked, which is true.
    expect(rules).toContain('contrast-not-assessed')
  })

  it('still measures a gradient, whose stops ARE the backdrop', async () => {
    const rules = await rulesFor(
      `<div data-test-box="0,0,900,200" style="background-image: linear-gradient(rgb(255,255,255), rgb(238,238,238))">
         <p data-ux-id="grey" data-test-box="0,0,300,20" style="color: rgb(205,205,205); font-size: 14px">Low contrast</p>
       </div>`,
    )
    expect(rules).toContain('color-contrast-gradient')
    expect(rules).not.toContain('contrast-not-assessed')
  })
})
