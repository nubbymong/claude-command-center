// @vitest-environment jsdom
// Shadow DOM, which the snapshot could not see at all.
//
// `walk` read `el.children`, `resolveScope` read `document.querySelectorAll`,
// `nearestNode` read `parentElement` and `elementOf` typed axe's `target` as
// `string[]`. Not one of those crosses a shadow boundary, so a web component's
// entire contents were painted, interactive, and completely unreviewed — with
// `truncated`, `depthLimited` and `issuesDropped` all unset, so the tool
// reported SUCCESS on what was effectively a bare document root.
//
// That is ordinary markup for Lit, Stencil, Shoelace and Ionic, and one
// attribute (`<template shadowrootmode>`) in agent-authored HTML.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type { AxeViolation } from '../../../src/main/canvas/bridge/analysis-loader'

let violations: AxeViolation[] = []

// Real axe cannot run these cases under jsdom (no layout, and its shadow
// traversal needs a rendered tree), and what is under test is the JOIN — whose
// input is exactly this shape.
vi.mock('../../../src/main/canvas/bridge/analysis-loader', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/canvas/bridge/analysis-loader')>()
  return {
    ...actual,
    ensureAnalysis: async () => ({
      version: 'fake',
      run: async () => ({ violations, incomplete: [] }),
    }),
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

/** Attach an open shadow root and fill it. Returns the host. */
function host(tag: string, lightHtml: string, shadowHtml: string): Element {
  document.body.innerHTML = `<${tag} data-test-box="0,0,400,200">${lightHtml}</${tag}>`
  const el = document.body.firstElementChild as Element
  const root = el.attachShadow({ mode: 'open' })
  root.innerHTML = shadowHtml
  return el
}

beforeAll(() => stubLayout())
beforeEach(() => {
  document.body.innerHTML = ''
  violations = []
})

describe('an open shadow root is walked', () => {
  it('emits the component contents that used to be invisible', async () => {
    host('my-card', '', '<button data-test-box="10,10,120,40">Buy now</button>')
    const result = await captureSnapshot({ analysis: false })
    const names = flatten(result.root).map((n) => n.name)
    expect(names).toContain('Buy now')
  })

  it('measures inside the component, not just around it', async () => {
    // The point of walking it at all: the findings live on the contents.
    host('my-card', '', '<button data-test-box="10,10,18,18">Go</button>')
    const result = await captureSnapshot({ analysis: false })
    const button = flatten(result.root).find((n) => n.name === 'Go')
    expect(button).toBeDefined()
    expect((button?.issues ?? []).map((i) => i.rule)).toContain('target-size')
  })

  it('keeps light children AND shadow children, each exactly once', async () => {
    // A slotted light child is rendered inside the shadow tree but remains a
    // child of its LIGHT parent, so walking both sides cannot double-count it.
    host(
      'my-card',
      '<p data-test-box="0,60,300,20">Slotted copy</p>',
      '<slot></slot><footer data-test-box="0,100,300,20">Shadow footer</footer>',
    )
    const result = await captureSnapshot({ analysis: false })
    const names = flatten(result.root).map((n) => n.name)
    expect(names.filter((n) => n === 'Slotted copy')).toHaveLength(1)
    expect(names.filter((n) => n === 'Shadow footer')).toHaveLength(1)
  })

  it('descends through nested components', async () => {
    document.body.innerHTML = '<my-outer data-test-box="0,0,400,200"></my-outer>'
    const outer = document.body.firstElementChild as Element
    const outerRoot = outer.attachShadow({ mode: 'open' })
    outerRoot.innerHTML = '<my-inner data-test-box="0,0,400,100"></my-inner>'
    const inner = outerRoot.firstElementChild as Element
    inner.attachShadow({ mode: 'open' }).innerHTML = '<a href="#x" data-test-box="5,5,90,30">Deep link</a>'

    const result = await captureSnapshot({ analysis: false })
    expect(flatten(result.root).map((n) => n.name)).toContain('Deep link')
  })
})

describe('scoping reaches a data-ux-id inside a component', () => {
  it('finds the anchor a flat selector cannot see', async () => {
    host('my-card', '', '<section data-ux-id="panel" data-test-box="0,0,300,120">Panel</section>')
    const result = await captureSnapshot({ scope: ['panel'], analysis: false })
    expect(result.unmatchedScope).toBeUndefined()
    expect(flatten(result.root).some((n) => n.uxId === 'panel')).toBe(true)
  })

  it('still reports an id that really is absent', async () => {
    // The control. Without it this suite would pass just as well if the
    // fallback search always claimed a match.
    host('my-card', '', '<section data-ux-id="panel" data-test-box="0,0,300,120">Panel</section>')
    const result = await captureSnapshot({ scope: ['nope'], analysis: false })
    expect(result.unmatchedScope).toEqual(['nope'])
  })

  it('prefers the light-DOM match and does not pay for the deep search', async () => {
    document.body.innerHTML = `<div data-ux-id="panel" data-test-box="0,0,300,120">Light panel</div>
      <my-card data-test-box="0,200,400,200"></my-card>`
    const card = document.body.lastElementChild as Element
    card.attachShadow({ mode: 'open' }).innerHTML = '<section data-ux-id="panel" data-test-box="0,200,300,120">Shadow panel</section>'
    const result = await captureSnapshot({ scope: ['panel'], analysis: false })
    const scoped = flatten(result.root).filter((n) => n.uxId === 'panel')
    expect(scoped).toHaveLength(1)
    expect(scoped[0].name).toBe('Light panel')
  })
})

describe('an axe finding inside a component is placed, not dropped', () => {
  // axe reports `target` as an ARRAY of selectors — one per shadow boundary —
  // for anything in a shadow tree. The consumer tested `typeof target !== 'string'`
  // and returned null, and the declared type said `string[]`, so the compiler
  // agreed the array case was impossible.
  function buttonName(target: Array<string | string[]>, element?: Element): AxeViolation {
    return {
      id: 'button-name',
      impact: 'critical',
      nodes: [{ ...(element ? { element } : {}), impact: 'critical', target }],
    }
  }

  async function captureWith(given: AxeViolation[]): Promise<SnapshotNode[]> {
    violations = given
    const result = await captureSnapshot({ analysis: true })
    return flatten(result.root)
  }

  it('resolves the shadow-path target form', async () => {
    host('my-card', '', '<button id="go" data-test-box="10,10,120,40">Buy now</button>')
    const nodes = await captureWith([buttonName([['my-card', '#go']])])
    const button = nodes.find((n) => n.name === 'Buy now')
    expect((button?.issues ?? []).map((i) => i.rule)).toContain('button-name')
  })

  it('counts a finding it cannot place instead of discarding it', async () => {
    host('my-card', '', '<button id="go" data-test-box="10,10,120,40">Buy now</button>')
    const nodes = await captureWith([buttonName([['my-card', '#missing']])])
    // Nothing matched, so nothing can carry the finding — but the agent is told
    // one was lost rather than being handed a clean tree.
    expect(nodes[0].issuesDropped).toBe(1)
  })

  it('climbs OUT of the shadow tree to find the node that carries it', async () => {
    // The boundary crossing itself. axe fires on whichever element owns the
    // text, and a wrapper inside a shadow root is not emitted — so placing the
    // finding means walking up to the HOST, and `parentElement` is null at the
    // top of a shadow tree. Without `getRootNode().host` the climb stopped dead
    // and the finding was dropped.
    document.body.innerHTML = '<my-card data-ux-id="card" data-test-box="0,0,400,200"></my-card>'
    const card = document.body.firstElementChild as Element
    const root = card.attachShadow({ mode: 'open' })
    // A wrapper: owns text AND an element child, which is exactly what keeps it
    // out of the tree.
    root.innerHTML = '<div id="price" data-test-box="10,20,80,24">$9<i></i></div>'
    const wrapper = root.getElementById('price') as Element

    const nodes = await captureWith([buttonName([['my-card', '#price']], wrapper)])
    const host = nodes.find((n) => n.uxId === 'card')
    expect((host?.issues ?? []).map((i) => i.rule)).toContain('button-name')
    // Attributed to the host, so it carries the wrapper's own box to say where.
    expect(host?.issues?.[0].at).toEqual({ x: 10, y: 20, width: 80, height: 24 })
  })

  it('bounds what the root can absorb, and counts the rest', async () => {
    // The root became the fallback home for findings with no emitted ancestor,
    // which makes it a node that can accumulate — so it needs the same per-node
    // ceiling every other node has. It is not a candidate, so the trim pass had
    // to be told about it explicitly.
    document.body.innerHTML = Array.from(
      { length: 30 },
      (_, i) => `<div id="loose${i}" data-test-box="${i},0,10,10"></div>`,
    ).join('')
    const given = Array.from({ length: 30 }, (_, i) => {
      const el = document.getElementById(`loose${i}`) as Element
      return { id: `rule-${i}`, impact: 'serious', nodes: [{ element: el, impact: 'serious', target: [`#loose${i}`] }] }
    })
    const nodes = await captureWith(given)
    expect(nodes[0].issues?.length).toBeLessThanOrEqual(20)
    expect(nodes[0].issuesDropped).toBe(10)
  })

  it('attributes a finding with no emitted ancestor to the root, with its box', async () => {
    // A finding on a direct child of <body> had no emitted ancestor within six
    // hops, and the top of every unscoped document is that dead zone.
    document.body.innerHTML = '<div id="loose" data-test-box="4,8,120,40"></div>'
    const el = document.getElementById('loose') as Element
    const nodes = await captureWith([buttonName(['#loose'], el)])
    expect((nodes[0].issues ?? []).map((i) => i.rule)).toContain('button-name')
    expect(nodes[0].issues?.[0].at).toEqual({ x: 4, y: 8, width: 120, height: 40 })
  })
})

describe('a CLOSED shadow root is reported as unreadable', () => {
  it('flags a custom element that paints but exposes no tree', async () => {
    document.body.innerHTML = '<my-widget data-test-box="0,0,400,200"></my-widget>'
    const el = document.body.firstElementChild as Element
    el.attachShadow({ mode: 'closed' }).innerHTML = '<button>Invisible</button>'
    const result = await captureSnapshot({ analysis: false })
    // Nothing in the tree describes it — which is exactly why the bit exists.
    expect(flatten(result.root).map((n) => n.name)).not.toContain('Invisible')
    expect(result.hiddenContent).toBe(true)
  })

  it('does not fire for an OPEN root, which is read', async () => {
    host('my-card', '', '<button data-test-box="10,10,120,40">Buy now</button>')
    const result = await captureSnapshot({ analysis: false })
    expect(result.hiddenContent).toBeUndefined()
  })

  it('does not fire for an ordinary light-DOM component', async () => {
    // Most custom elements have no shadow root at all. A note that fires on them
    // costs the agent a second capture for nothing, which is the exact cost
    // `depthLimited` was split out of `truncated` to avoid.
    document.body.innerHTML = '<my-list data-test-box="0,0,400,200"><li data-test-box="0,0,400,20">One</li></my-list>'
    const result = await captureSnapshot({ analysis: false })
    expect(result.hiddenContent).toBeUndefined()
  })

  it('does not fire for a custom element that paints nothing', async () => {
    document.body.innerHTML = '<my-analytics></my-analytics>'
    const result = await captureSnapshot({ analysis: false })
    expect(result.hiddenContent).toBeUndefined()
  })

  it('does not fire for a custom element whose light children merely emit nothing', async () => {
    // `children.length === 0` at the call site counts EMITTED nodes, not DOM
    // children — so a component holding one unremarkable div reaches the same
    // branch as one holding nothing. Its content is readable; there is just
    // nothing in it worth a line.
    document.body.innerHTML = '<my-list data-test-box="0,0,400,200"><div data-test-box="0,0,400,20"></div></my-list>'
    const result = await captureSnapshot({ analysis: false })
    expect(result.hiddenContent).toBeUndefined()
  })

  it('does not fire for an ordinary empty element', async () => {
    // The clause that keeps this narrow is the hyphen in the tag name. Without
    // it every spacer, rule and CSS-drawn icon on every page — an empty painted
    // <div> — would claim the page could not be read.
    document.body.innerHTML = '<div data-test-box="0,0,400,8"></div><span data-test-box="0,20,16,16"></span>'
    const result = await captureSnapshot({ analysis: false })
    expect(result.hiddenContent).toBeUndefined()
  })
})

describe('the depth cap accounts for a shadow root', () => {
  it('reports depthLimited when the content below the cap is in a component', async () => {
    // The cap drops a whole subtree, and it drops it inside the page, so
    // nothing downstream can know. It counted light children and meaningfulness
    // and not `shadowRoot` — so a component sitting exactly at the boundary
    // took its entire contents with it and the tree simply stopped, reported as
    // complete.
    // EXACTLY at the boundary, and the count matters: body walks at depth 0, so
    // 64 wrappers put the component at depth 65 — the first element the cap
    // refuses. One wrapper more and a WRAPPER is the thing refused, and a
    // wrapper has light children, so the flag would be set by the clause that
    // was already there and the test would pass with the fix reverted. That is
    // what the first version of this fixture did.
    let html = '<my-leaf data-test-box="0,0,10,10"></my-leaf>'
    for (let i = 0; i < 64; i++) html = `<div data-test-box="0,0,400,200">${html}</div>`
    document.body.innerHTML = html
    const leaf = document.querySelector('my-leaf') as Element
    leaf.attachShadow({ mode: 'open' }).innerHTML = '<button data-test-box="0,0,10,10">Deep</button>'

    const result = await captureSnapshot({ analysis: false })
    expect(flatten(result.root).map((n) => n.name)).not.toContain('Deep')
    expect(result.depthLimited).toBe(true)
  })
})
