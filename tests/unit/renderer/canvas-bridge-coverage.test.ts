// @vitest-environment jsdom
// Findings that vanished with nothing said.
//
// Distinct from the suppression suite next door: nothing here needs a hostile
// page or even an unusual one. These are shapes the walk simply did not reach,
// and every one of them produced a snapshot that looked like a clean result.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { captureSnapshot } from '../../../src/main/canvas/bridge/snapshot'
import { stubLayout } from './canvas-bridge-harness'
import type { AxeIssue, SnapshotNode } from '../../../src/shared/canvas'

function flatten(node: SnapshotNode, out: SnapshotNode[] = []): SnapshotNode[] {
  out.push(node)
  for (const child of node.children) flatten(child, out)
  return out
}

function issuesOf(nodes: SnapshotNode[]): AxeIssue[] {
  return nodes.flatMap((n) => n.issues ?? [])
}

const GREY = 'color: rgb(170,170,170); background-color: rgb(255,255,255); font-size: 14px'

beforeAll(() => stubLayout())
beforeEach(() => {
  document.body.innerHTML = ''
})

describe('text in a container that gets no node is still measured', () => {
  it('finds the contrast defect one empty child element used to erase', async () => {
    // `<div>text<i></i></div>`. A leaf with text earns a line in the tree; a
    // wrapper does not — so the element that OWNS the text was not emitted, was
    // therefore never a candidate, and the measurement pass never looked at it.
    // The axe join has climbed to the nearest emitted ancestor for this exact
    // shape since round 3; the measurement half never did.
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <div data-test-box="10,20,300,24" style="${GREY}">Low contrast<i></i></div>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    const finding = (page?.issues ?? []).find((i) => i.rule === 'color-contrast')
    expect(finding).toBeDefined()
    // Attributed to the ancestor, so it carries the owner's own box to say
    // where the problem actually is.
    expect(finding?.at).toEqual({ x: 10, y: 20, width: 300, height: 24 })
  })

  it('still reports nothing when that same text is fine (the control)', async () => {
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <div data-test-box="10,20,300,24" style="color: rgb(0,0,0); background-color: rgb(255,255,255); font-size: 14px">Fine<i></i></div>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    expect((page?.issues ?? []).map((i) => i.rule)).not.toContain('color-contrast')
  })

  it('does not double-report text that DID get its own node', async () => {
    // A leaf with text is emitted and measured as a candidate. If it were also
    // collected as an un-emitted owner the agent would read the same defect
    // twice, on two different nodes.
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <p data-ux-id="leaf" data-test-box="10,20,300,24" style="${GREY}">Low contrast</p>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const all = issuesOf(flatten(result.root)).filter((i) => i.rule === 'color-contrast')
    expect(all).toHaveLength(1)
  })

  it('bounds what one ancestor absorbs, and counts the rest', async () => {
    // 40 un-emitted rows all climb to the same `<main>`. The per-node ceiling
    // has to be charged as they arrive rather than by trimming afterwards:
    // building 40 issue objects to keep 20 is the per-node cost that froze the
    // UI thread one field over.
    const rows = Array.from(
      { length: 40 },
      (_, i) => `<div data-test-box="0,${i * 24},300,24" style="${GREY}">Row ${i}<i></i></div>`,
    ).join('')
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,960">${rows}</main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    expect(page?.issues?.length).toBeLessThanOrEqual(20)
    expect(page?.issuesDropped).toBe(20)
  })

  it('ignores text in a container that is not painted', async () => {
    // The emitted path drops `display: none` and `visibility: hidden` before it
    // measures anything, and the un-emitted path has to drop them too — a rule
    // that reports contrast on text nobody can see is the false-positive class
    // this whole feature was gated on.
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <div style="${GREY}; visibility: hidden" data-test-box="10,20,300,24">Low contrast<i></i></div>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    expect((page?.issues ?? []).map((i) => i.rule)).not.toContain('color-contrast')
  })

  it('inherits the inert exemption, which no ancestor tag carries', async () => {
    // `inert` is the one exemption computed on the candidate rather than found
    // by climbing tags, so the un-emitted path has to be handed it explicitly.
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <div inert data-test-box="0,0,900,200">
          <div data-test-box="10,20,300,24" style="${GREY}">Low contrast<i></i></div>
        </div>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    expect((page?.issues ?? []).map((i) => i.rule)).not.toContain('color-contrast')
  })

  it('respects the exemptions the emitted path respects', async () => {
    // The un-emitted path runs the same rules, so it must inherit the same
    // exemptions — otherwise closing a coverage hole opens a false-positive one.
    document.body.innerHTML = `<main data-ux-id="page" data-test-box="0,0,900,400">
        <fieldset disabled data-test-box="0,0,900,200">
          <div data-test-box="10,20,300,24" style="${GREY}">Low contrast<i></i></div>
        </fieldset>
      </main>`
    const result = await captureSnapshot({ analysis: false })
    const page = flatten(result.root).find((n) => n.uxId === 'page')
    expect((page?.issues ?? []).map((i) => i.rule)).not.toContain('color-contrast')
  })
})

describe('a duplicate data-ux-id reviews every match, not an arbitrary one', () => {
  it('scopes to all the elements carrying the id', async () => {
    // Ids are supposed to be unique and nothing enforces it — a component
    // rendered in a list carries the same one on every row. Taking the first
    // match sent the whole review to one arbitrary row and said nothing about
    // it, so the agent read a clean report of a region it had not asked about.
    document.body.innerHTML = `
      <section data-ux-id="row" data-test-box="0,0,300,40"><p data-test-box="0,0,300,20">First</p></section>
      <section data-ux-id="row" data-test-box="0,40,300,40"><p data-test-box="0,40,300,20" style="${GREY}">Low contrast</p></section>`
    const result = await captureSnapshot({ scope: ['row'], analysis: false })
    const names = flatten(result.root).map((n) => n.name)
    expect(names).toContain('First')
    expect(names).toContain('Low contrast')
    // And the defect in the second one is actually reported.
    expect(issuesOf(flatten(result.root)).map((i) => i.rule)).toContain('color-contrast')
  })

  it('bounds how many matches one id can pull in', async () => {
    const rows = Array.from(
      { length: 20 },
      (_, i) => `<section data-ux-id="row" data-test-box="0,${i * 40},300,40">Row ${i}</section>`,
    ).join('')
    document.body.innerHTML = rows
    const result = await captureSnapshot({ scope: ['row'], analysis: false })
    expect(flatten(result.root).filter((n) => n.uxId === 'row')).toHaveLength(8)
  })

  it('still resolves a unique id to exactly one root (the control)', async () => {
    document.body.innerHTML = `
      <section data-ux-id="row" data-test-box="0,0,300,40">Only</section>
      <section data-ux-id="other" data-test-box="0,40,300,40">Other</section>`
    const result = await captureSnapshot({ scope: ['row'], analysis: false })
    const scoped = flatten(result.root).filter((n) => n.uxId === 'row')
    expect(scoped).toHaveLength(1)
    expect(flatten(result.root).map((n) => n.name)).not.toContain('Other')
  })
})
