// @vitest-environment jsdom
// The SemanticSnapshot the bundled bridge produces (spec §4): form-state
// semantics, the sr-only heuristic, the measurement findings, scoping, and the
// token economy that makes scoped snapshots the affordable default.
//
// jsdom supplies no layout, so boxes come from data-test-box stubs (see the
// harness): what is pinned here is the logic ON TOP of geometry, not geometry.
// axe-core is not exercised — it cannot run under jsdom — so these runs go
// through the measurement-only path, which is also the degraded path a blocked
// analysis chunk falls back to.

import { describe, it, expect, beforeAll } from 'vitest'
import { bridgeRequest, installBridge, stubLayout } from './canvas-bridge-harness'
import { serializeSnapshot } from '../../../src/shared/canvas-snapshot-serialize'
import type { CanvasSnapshotResult, SemanticSnapshot, SnapshotNode } from '../../../src/shared/canvas'

function flatten(node: SnapshotNode, out: SnapshotNode[] = []): SnapshotNode[] {
  out.push(node)
  for (const child of node.children) flatten(child, out)
  return out
}

function byUxId(result: CanvasSnapshotResult, uxId: string): SnapshotNode | undefined {
  return flatten(result.root).find((n) => n.uxId === uxId)
}

function issueRules(node: SnapshotNode | undefined): string[] {
  return (node?.issues ?? []).map((i) => i.rule)
}

async function snapshot(options: Record<string, unknown> = {}): Promise<CanvasSnapshotResult> {
  const reply = await bridgeRequest('snapshot', { analysis: false, ...options })
  expect(reply.ok, reply.error).toBe(true)
  return reply.result as CanvasSnapshotResult
}

/** 20 cards × 6 boxed nodes: dense enough for the scoped-vs-unscoped ratio to
 *  mean something, laid out so no two cards touch. */
function cards(): string {
  return Array.from({ length: 20 }, (_, i) => {
    const y = 1000 + i * 120
    return `
      <section data-ux-id="card-${i}" data-test-box="0,${y},400,100"
               style="background-color: rgb(255,255,255); padding: 12px">
        <h2 data-test-box="8,${y + 8},380,24" style="font-size: 18px; color: rgb(20,20,20)">Card ${i}</h2>
        <p data-test-box="8,${y + 36},380,20" style="font-size: 14px; color: rgb(60,60,60)">Body copy for card ${i}</p>
        <a href="/card/${i}" data-test-box="8,${y + 60},120,32" style="display: inline-block; color: rgb(0,90,200)">Open card ${i}</a>
        <button data-test-box="140,${y + 60},80,32" style="display: inline-block">Pin ${i}</button>
        <span data-test-box="230,${y + 60},60,32" style="color: rgb(90,90,90)">meta ${i}</span>
      </section>`
  }).join('')
}

beforeAll(() => {
  stubLayout()
  document.title = 'Fixture page'
  document.body.innerHTML = `
    <h1 data-test-box="0,0,600,40">Dashboard</h1>

    <!-- deliberately screen-reader-only: 1x1 and clipped -->
    <span data-ux-id="skip" data-test-box="0,0,1,1"
          style="position: absolute; overflow: hidden; clip-path: inset(50%)">Skip to content</span>

    <form data-ux-id="signup" data-test-box="0,60,400,300">
      <label for="email">Email address</label>
      <input id="email" name="email" type="email" value="nick@example.com" data-test-box="0,90,300,32" />

      <label for="pw">Password</label>
      <input id="pw" name="password" type="password" value="hunter2" data-test-box="0,130,300,32" />

      <input id="terms" type="checkbox" checked data-test-box="0,170,16,16" />
      <label for="terms">Accept terms</label>

      <input id="code" type="text" aria-invalid="true" value="abc" data-test-box="0,200,300,32" />
      <input id="ref" type="text" disabled value="locked" data-test-box="0,240,300,32" />

      <button data-ux-id="submit" type="submit" data-test-box="0,280,16,16"
              style="display: inline-block">Go</button>
    </form>

    <!-- text that does not fit its box -->
    <div data-ux-id="clipped" data-test-box="0,520,220,20" data-test-scroll="340,220,20,20"
         style="overflow: hidden">A very long label that does not fit its container</div>

    <!-- low contrast on a flat background -->
    <p data-ux-id="muted" data-test-box="0,560,400,20"
       style="color: rgb(170,170,170); background-color: rgb(255,255,255)">Low contrast body text</p>

    <!-- low contrast over a gradient: the case axe reports as incomplete -->
    <div data-ux-id="hero" data-test-box="0,600,400,80"
         style="background-image: linear-gradient(90deg, rgb(255,255,255), rgb(235,235,235))">
      <p data-test-box="10,610,380,20" style="color: rgb(205,205,205)">Hero headline</p>
    </div>

    <!-- two in-flow cards sitting on top of each other -->
    <div data-ux-id="overlap-a" data-test-box="0,700,200,60">Card A</div>
    <div data-ux-id="overlap-b" data-test-box="100,720,200,60">Card B</div>

    <!-- faded to near nothing -->
    <p data-ux-id="ghost" data-test-box="0,800,300,20" style="opacity: 0.04">Almost invisible</p>

    ${cards()}`
  installBridge()
})

describe('snapshot shape (spec §4)', () => {
  it('returns a document root with viewport, and refs unique in document order', async () => {
    const result = await snapshot()
    expect(result.root.ref).toBe('e0')
    expect(result.root.role).toBe('document')
    expect(result.root.name).toBe('Fixture page')
    expect(typeof result.viewport.width).toBe('number')
    expect(typeof result.viewport.dpr).toBe('number')

    const nodes = flatten(result.root)
    const refs = nodes.map((n) => n.ref)
    expect(new Set(refs).size).toBe(refs.length)
    // e0 is the synthetic root; every walked node is e1..eN in walk order.
    const numbers = refs.slice(1).map((r) => Number(r.slice(1)))
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b))
  })

  it('carries accessible names computed by the accname algorithm, not by tag guessing', async () => {
    const result = await snapshot()
    const nodes = flatten(result.root)
    // label[for] association, not placeholder or id.
    const email = nodes.find((n) => n.state?.type === 'email')
    expect(email?.name).toBe('Email address')
    expect(byUxId(result, 'submit')?.name).toBe('Go')

    const link = nodes.find((n) => n.name === 'Open card 3')
    expect(link?.role).toBe('link')
    expect(nodes.find((n) => n.name === 'Card 3')?.role).toBe('heading')
    // A <section> with no accessible name is generic, not a region — the table
    // encodes HTML-AAM, it does not map tags to roles blindly.
    expect(byUxId(result, 'card-3')?.role).toBe('')
  })
})

describe('form-state semantics (HARD P2 requirement)', () => {
  it('reports type, checked, disabled and aria-invalid', async () => {
    const nodes = flatten((await snapshot()).root)
    const checkbox = nodes.find((n) => n.state?.type === 'checkbox')
    expect(checkbox?.state).toMatchObject({ type: 'checkbox', checked: true })

    const disabled = nodes.find((n) => n.state?.disabled)
    expect(disabled?.state?.value).toBe('locked')

    const invalid = nodes.find((n) => n.state?.ariaInvalid)
    expect(invalid?.state).toMatchObject({ ariaInvalid: true, value: 'abc' })
  })

  it('reports a plain field value but never a secret one', async () => {
    const nodes = flatten((await snapshot()).root)
    const email = nodes.find((n) => n.state?.type === 'email')
    expect(email?.state?.value).toBe('nick@example.com')

    const password = nodes.find((n) => n.state?.type === 'password')
    expect(password?.state?.value).toBe('(redacted)')
    expect(JSON.stringify(nodes)).not.toContain('hunter2')
  })

  it('reports effective opacity so faded-to-nothing content is visible in text', async () => {
    const ghost = byUxId(await snapshot(), 'ghost')
    expect(ghost?.state?.opacity).toBeCloseTo(0.04, 5)
  })
})

describe('sr-only heuristic (HARD P2 requirement)', () => {
  it('marks a clipped 1x1 element and suppresses its size finding', async () => {
    const skip = byUxId(await snapshot(), 'skip')
    expect(skip?.state?.srOnly).toBe(true)
    // Without the heuristic this is a 1x1 target and unreadable text — the two
    // false positives P0 run-2 produced.
    expect(issueRules(skip)).not.toContain('target-size')
    expect(issueRules(skip)).not.toContain('color-contrast')
  })
})

describe('measurement findings', () => {
  it('flags text clipped by its own box', async () => {
    const clipped = byUxId(await snapshot(), 'clipped')
    const issue = (clipped?.issues ?? []).find((i) => i.rule === 'clipped-content')
    expect(issue).toBeDefined()
    expect(issue?.measured).toBe('340px content in 220px box')
    expect(issue?.needed).toBe('340px')
  })

  it('flags a hit target below the WCAG 2.2 minimum', async () => {
    const submit = byUxId(await snapshot(), 'submit')
    const issue = (submit?.issues ?? []).find((i) => i.rule === 'target-size')
    expect(issue).toBeDefined()
    expect(issue?.measured).toBe('16x16px')
    expect(issue?.needed).toBe('24x24px')
  })

  it('flags low contrast on a flat background when axe is not available', async () => {
    const muted = byUxId(await snapshot(), 'muted')
    const issue = (muted?.issues ?? []).find((i) => i.rule === 'color-contrast')
    expect(issue).toBeDefined()
    // #aaa on white is ~2.32:1 against a 4.5:1 requirement.
    expect(issue?.measured).toMatch(/^2\.3\d:1$/)
    expect(issue?.needed).toBe('4.5:1')
  })

  it('flags low contrast over a gradient — the case axe reports as incomplete', async () => {
    const nodes = flatten((await snapshot()).root)
    const headline = nodes.find((n) => n.name === 'Hero headline')
    expect(issueRules(headline)).toContain('color-contrast-gradient')
  })

  it('flags in-flow content boxes that sit on top of each other', async () => {
    const result = await snapshot()
    const a = byUxId(result, 'overlap-a')
    const issue = (a?.issues ?? []).find((i) => i.rule === 'overlap')
    expect(issue).toBeDefined()
    expect(issue?.measured).toContain('px²')
    // …and cards that merely sit next to each other are left alone.
    expect(issueRules(byUxId(result, 'card-7'))).not.toContain('overlap')
  })
})

describe('scoping and token economy (spec §4.1)', () => {
  it('scopes to a data-ux-id subtree and reports ids that matched nothing', async () => {
    const result = await snapshot({ scope: ['card-3', 'no-such-card'] })
    const nodes = flatten(result.root)
    expect(nodes.some((n) => n.uxId === 'card-3')).toBe(true)
    expect(nodes.some((n) => n.uxId === 'card-4')).toBe(false)
    expect(result.unmatchedScope).toEqual(['no-such-card'])
  })

  it('carries styles only for scoped nodes', async () => {
    const unscoped = await snapshot()
    expect(flatten(unscoped.root).every((n) => n.styles === undefined)).toBe(true)

    const scoped = await snapshot({ scope: ['card-3'] })
    const card = byUxId(scoped, 'card-3')
    expect(card?.styles).toBeDefined()
    expect(card?.styles?.['background-color']).toBe('rgb(255, 255, 255)')
  })

  it('a scoped snapshot of one card is a small fraction of the whole page', async () => {
    const stamp = (result: CanvasSnapshotResult): SemanticSnapshot => ({
      versionId: 'v1',
      capturedAt: '2026-08-11T00:00:00Z',
      viewport: result.viewport,
      root: result.root,
    })
    const unscoped = serializeSnapshot(stamp(await snapshot()))
    const scoped = serializeSnapshot(stamp(await snapshot({ scope: ['card-3'] })))
    // Spec §10 P2 acceptance: under 15% — and that is WITH the scoped nodes
    // carrying their styles.
    expect(scoped.length / unscoped.length).toBeLessThan(0.15)
  })
})

describe('analysis degradation', () => {
  it('still returns the tree when the axe chunk cannot be loaded', async () => {
    // Nothing serves /__ccc__/canvas-analysis.js here, so the dynamic import
    // fails — the snapshot must survive it with measurement findings intact.
    const reply = await bridgeRequest('snapshot', {}, 15_000)
    expect(reply.ok, reply.error).toBe(true)
    const result = reply.result as CanvasSnapshotResult
    // A CODE, not a message: this string reaches the agent outside the
    // untrusted envelope, so its vocabulary is closed.
    expect(result.analysisError).toBe('load-failed')
    expect(flatten(result.root).length).toBeGreaterThan(10)
    expect(issueRules(byUxId(result, 'submit'))).toContain('target-size')
  })
})
