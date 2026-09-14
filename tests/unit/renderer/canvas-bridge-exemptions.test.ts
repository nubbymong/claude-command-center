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

/** A 1x1 transparent GIF — a real, resolvable `url()` layer. */
let IMAGE = ''

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
  IMAGE =
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

  it('names the declaring ancestor ONCE, not every paragraph under it', async () => {
    // A coverage note is worth having; 300 copies of it is not. One
    // `background-image` on a hero put this on every paragraph beneath it, and
    // on a dense page that pushed a genuine `critical` off the per-node wire
    // budget — so the note cost real findings.
    document.body.innerHTML = `<div data-ux-id="hero" data-test-box="0,0,900,600" style="background-color: rgb(255,255,255); ${IMAGE}">
        ${Array.from({ length: 40 }, (_, i) => `<p data-ux-id="p${i}" data-test-box="0,${i * 15},300,14" style="color: rgb(170,170,170); font-size: 14px">Body ${i}</p>`).join('')}
      </div>`
    const result = await captureSnapshot({ analysis: false })
    const all = flatten(result.root).flatMap((n) => n.issues ?? [])
    expect(all.filter((i) => i.rule === 'contrast-not-assessed')).toHaveLength(1)
    // And it points at the ancestor that caused it, so the agent has somewhere
    // to go — the same `at` convention the axe join uses.
    const note = all.find((i) => i.rule === 'contrast-not-assessed')
    expect(note?.at).toEqual({ x: 0, y: 0, width: 900, height: 600 })
  })
})

describe('a backdrop that cannot be READ is never reported as passing', () => {
  // The blocker this closes. `parseColor` understood only #hex and rgb(), so
  // Tailwind v4's `oklch()` palette produced nothing — and nothing is what the
  // backdrop climb also produces for "no background here", so the composite fell
  // through to PAGE WHITE. Near-black text on a near-black hero measured 14.62:1
  // and was reported as fine. axe never covers it either: a gradient surface is
  // always `incomplete`, which is why this path exists at all.

  it('measures Tailwind-spelled gradient stops instead of imaginary white', async () => {
    const rules = await rulesFor(
      `<div data-test-box="0,0,900,400" style="background-image: linear-gradient(oklch(0.208 0.042 265.755), oklch(0.129 0.042 264.695))">
         <p data-ux-id="grey" data-test-box="0,0,300,20" style="color: oklch(0.279 0.041 260.031); font-size: 14px">Hero copy</p>
       </div>`,
    )
    expect(rules).toContain('color-contrast-gradient')
  })

  it('pins WHICH backdrop it measured against', async () => {
    // The ratio is the evidence: against the real stops this text is ~1.22:1,
    // against the page white the old code fell back to it is ~14.6:1. Asserting
    // the number is what makes this test unable to pass on the broken code.
    document.body.innerHTML = `<div data-test-box="0,0,900,400" style="background-image: linear-gradient(oklch(0.208 0.042 265.755), oklch(0.129 0.042 264.695))">
        <p data-ux-id="grey" data-test-box="0,0,300,20" style="color: oklch(0.279 0.041 260.031); font-size: 14px">Hero copy</p>
      </div>`
    const result = await captureSnapshot({ analysis: false })
    const node = flatten(result.root).find((n) => n.uxId === 'grey')
    const finding = (node?.issues ?? []).find((i) => i.rule === 'color-contrast-gradient')
    expect(finding).toBeDefined()
    expect(parseFloat(finding?.measured ?? '')).toBeLessThan(2)
  })

  it('declines loudly when a gradient stop does not resolve', async () => {
    // `color-mix()` resolves to a colour this parser cannot compute. Declining
    // is safe — the note claims no defect — and a silent skip is not, because
    // the flat branch would then composite against white.
    const rules = await rulesFor(
      `<div data-test-box="0,0,900,200" style="background-image: linear-gradient(rgb(from red r g b), rgb(17,17,17))">
         <p data-ux-id="grey" data-test-box="0,0,300,20" style="color: rgb(20,20,20); font-size: 14px">Hero copy</p>
       </div>`,
    )
    expect(rules).toContain('contrast-not-assessed')
    expect(rules).not.toContain('color-contrast')
  })

  it('declines when an ancestor BACKGROUND COLOUR does not resolve', async () => {
    // The quietest version of the bug. An unparseable `background-color` was
    // skipped, and a skipped layer is indistinguishable from an absent one — so
    // the climb kept going and composited against page white. No gradient, no
    // image, nothing to hint that a layer had been dropped.
    //
    // `color(prophoto-rgb …)` is a colour space this parser deliberately does
    // not model, and every engine keeps it verbatim in the computed value — so
    // this is the shape a real page delivers, not a fixture contrivance.
    const rules = await rulesFor(
      `<div data-test-box="0,0,900,200" style="background-color: color(prophoto-rgb 0.05 0.05 0.06)">
         <p data-ux-id="grey" data-test-box="0,0,300,20" style="color: rgb(20,20,20); font-size: 14px">Hero copy</p>
       </div>`,
    )
    expect(rules).toContain('contrast-not-assessed')
    expect(rules).not.toContain('color-contrast')
  })

  it('declines when the TEXT colour does not resolve', async () => {
    const rules = await rulesFor(
      `<div data-test-box="0,0,900,200" style="background-color: rgb(255,255,255)">
         <p data-ux-id="grey" data-test-box="0,0,300,20" style="color: rgb(from red r g b); font-size: 14px">Hero copy</p>
       </div>`,
    )
    expect(rules).toContain('contrast-not-assessed')
  })

  it('still reports a real defect when everything DID resolve (the control)', async () => {
    // Without this the suite would pass just as well if the code declined on
    // everything, which is the cheap way to make a false-positive test go green.
    const rules = await rulesFor(
      `<div data-test-box="0,0,900,200" style="background-color: oklch(0.984 0.003 247.858)">
         <p data-ux-id="grey" data-test-box="0,0,300,20" style="color: oklch(0.869 0.022 252.894); font-size: 14px">Faint</p>
       </div>`,
    )
    expect(rules).toContain('color-contrast')
    expect(rules).not.toContain('contrast-not-assessed')
  })
})
