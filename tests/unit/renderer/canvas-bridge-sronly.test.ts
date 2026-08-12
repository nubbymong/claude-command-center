// @vitest-environment jsdom
// The sr-only heuristic — a HARD requirement from the P0 run-2 post-mortem, and
// simultaneously the highest-value thing on the page for an attacker to forge.
//
// `[sr-only]` tells the agent to stop reporting a node. The existing guard for it
// asserted `not.toContain('target-size')` on a plain <span> that was never going
// to produce a target-size finding in the first place, so it held whether or not
// the suppression existed: deleting the suppression left it green. Every fixture
// here is CONTROLLED — the same element without the marker must produce the
// findings, or the test is not testing anything.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { captureSnapshot } from '../../../src/main/canvas/bridge/snapshot'
import { stubLayout } from './canvas-bridge-harness'
import type { SnapshotNode } from '../../../src/shared/canvas'

function flatten(node: SnapshotNode, out: SnapshotNode[] = []): SnapshotNode[] {
  out.push(node)
  for (const child of node.children) flatten(child, out)
  return out
}

/** One 1x1 low-contrast link — small enough to fail target-size, faint enough to
 *  fail contrast — with whatever hiding style the case under test needs.
 *
 *  `display: block` is deliberate: an inline target is exempt from SC 2.5.8, so
 *  an inline fixture would silently never produce a target-size finding and the
 *  suppression assertions would pass for the wrong reason. That is exactly the
 *  failure this file exists to correct, so it must not be repeated here. */
async function linkWith(style: string): Promise<SnapshotNode | undefined> {
  document.body.innerHTML = `
    <a href="#main" data-ux-id="skip" data-test-box="0,0,1,1"
       style="display: block; color: rgb(200,200,200); background-color: rgb(255,255,255); font-size: 12px; ${style}">Skip to content</a>
  `
  const result = await captureSnapshot({ analysis: false })
  return flatten(result.root).find((n) => n.uxId === 'skip')
}

function rules(node: SnapshotNode | undefined): string[] {
  return (node?.issues ?? []).map((i) => i.rule)
}

beforeAll(() => stubLayout())
beforeEach(() => {
  document.body.innerHTML = ''
})

describe('sr-only suppression (HARD P2 requirement)', () => {
  it('the fixture really does produce both findings when it is NOT hidden', async () => {
    // The control. If this ever stops failing, every suppression test below is
    // vacuous and must be treated as broken rather than passing.
    const plain = await linkWith('')
    expect(plain?.state?.srOnly).toBeUndefined()
    expect(rules(plain)).toContain('target-size')
    expect(rules(plain)).toContain('color-contrast')
  })

  it.each([
    ['clip on a positioned element', 'position: absolute; clip: rect(1px, 1px, 1px, 1px)'],
    ['clip-path inset(50%)', 'clip-path: inset(50%)'],
    ['a 1x1 positioned overflow-hidden box', 'position: absolute; overflow: hidden'],
  ])('marks %s and suppresses the findings it makes meaningless', async (_label, style) => {
    const hidden = await linkWith(style)
    expect(hidden?.state?.srOnly).toBe(true)
    expect(rules(hidden)).not.toContain('target-size')
    expect(rules(hidden)).not.toContain('color-contrast')
  })

  it('does NOT accept a full-size positioned overflow-hidden box', async () => {
    // The size bound is the whole difference between "the 1x1 clipping box every
    // sr-only recipe uses" and "any positioned panel with `overflow: hidden`" —
    // which is a card, a modal, a dropdown, most of a design system. Without it
    // a page suppresses every finding under any such panel with two ordinary
    // CSS properties.
    document.body.innerHTML = `
      <div data-test-box="0,0,400,300" style="position: absolute; overflow: hidden">
        <a href="#main" data-ux-id="skip" data-test-box="0,0,1,1"
           style="display: block; color: rgb(200,200,200); background-color: rgb(255,255,255); font-size: 12px">Skip</a>
      </div>`
    const inPanel = flatten((await captureSnapshot({ analysis: false })).root).find((n) => n.uxId === 'skip')
    expect(inPanel?.state?.srOnly).toBeUndefined()
    expect(rules(inPanel)).toContain('target-size')
    expect(rules(inPanel)).toContain('color-contrast')
  })

  it('finds the pattern on a WRAPPER, not only on the element itself', async () => {
    // The sr-only recipe normally sits on a wrapper and the text is a couple of
    // elements down — `<div class="sr-only"><span><a>…</a></span></div>` is the
    // usual shape. Checking only the element itself reports every such label as
    // a 1px target with unreadable contrast, which is where the P0 run-2 false
    // positives came from.
    document.body.innerHTML = `
      <div data-test-box="0,0,1,1" style="position: absolute; clip: rect(1px, 1px, 1px, 1px)">
        <span data-test-box="0,0,1,1">
          <a href="#main" data-ux-id="skip" data-test-box="0,0,1,1"
             style="display: block; color: rgb(200,200,200); background-color: rgb(255,255,255); font-size: 12px">Skip</a>
        </span>
      </div>`
    const nested = flatten((await captureSnapshot({ analysis: false })).root).find((n) => n.uxId === 'skip')
    expect(nested?.state?.srOnly).toBe(true)
    expect(rules(nested)).not.toContain('target-size')
  })

  it('does NOT accept `clip` without positioning — that hides nothing', async () => {
    // CSS `clip` only applies to absolutely positioned elements, so on a static
    // box it is a visual no-op that getComputedStyle still reports. Accepting it
    // was a pure-CSS, zero-JavaScript way for a page to mark any subtree sr-only
    // and delete every finding on it while the content stayed plainly visible —
    // and the resulting `[sr-only]` is legitimately emitted, so nothing
    // downstream could tell it was a forgery.
    const cloaked = await linkWith('position: static; clip: rect(1px, 1px, 1px, 1px)')
    expect(cloaked?.state?.srOnly).toBeUndefined()
    expect(rules(cloaked)).toContain('target-size')
    expect(rules(cloaked)).toContain('color-contrast')
  })
})

describe('content that is not painted is not reported', () => {
  it('drops a visibility:hidden element rather than measuring it', async () => {
    // `visibility: hidden` keeps its box and its client rects, so geometry alone
    // called it visible — and every finding on it was a false positive about
    // content nobody can see. (`display: none` has no rects and never got here.)
    const invisible = await linkWith('visibility: hidden')
    expect(invisible).toBeUndefined()
  })
})
