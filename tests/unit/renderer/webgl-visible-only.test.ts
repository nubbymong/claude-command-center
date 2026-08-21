/**
 * Only the terminal that is ON SCREEN may hold a WebGL context.
 *
 * The rule is enforced by where `installWebglWithRecovery` is called from, and
 * that is not something a unit test can observe: TerminalView builds an xterm
 * terminal, a WebGL addon and a ResizeObserver on mount, none of which exist in
 * jsdom. So this reads the source, and it pins exactly the two things that make
 * the rule true — the call happens in an effect keyed on `isActive`, and it does
 * NOT happen in the mount effect.
 *
 * Why the rule matters, stated here because a future reader will otherwise see
 * an attach/detach on every tab switch and "simplify" it back:
 *
 *  - Chromium allows about SIXTEEN WebGL contexts per renderer and evicts the
 *    oldest beyond that. Every session in this app keeps its TerminalView
 *    mounted, so a seventeenth session did not merely fail to get a context, it
 *    took one from a terminal that was using it — arriving as a context-loss
 *    storm, i.e. as the crash the recovery code exists to survive.
 *  - `@xterm/addon-webgl` keeps ONE glyph atlas per PROCESS, so every extra live
 *    context is one more terminal that someone else's atlas rebuild can blank.
 *    With a single live context there is no "someone else", which is what makes
 *    the whole class of corruption go away rather than be coordinated around.
 */
import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const SRC = path.resolve(__dirname, '../../../src/renderer/components/TerminalView.tsx')
const src = fs.readFileSync(SRC, 'utf8')

/** The `useEffect(...)` call that encloses `index`, with its dependency array. */
function enclosingEffect(index: number): string {
  const start = src.lastIndexOf('useEffect(', index)
  expect(start).toBeGreaterThan(-1)
  let depth = 0
  for (let i = src.indexOf('(', start); i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error('unbalanced parentheses around the effect')
}

describe('WebGL is attached only while the pane is visible', () => {
  const calls = [...src.matchAll(/installWebglWithRecovery\(/g)].map((m) => m.index!)

  it('is installed from exactly one place', () => {
    // Two call sites would mean two lifetimes, and the second would be the one
    // nobody remembered to detach.
    expect(calls).toHaveLength(1)
  })

  it('that place is an effect that re-runs when visibility changes', () => {
    const effect = enclosingEffect(calls[0])
    const deps = effect.slice(effect.lastIndexOf('}, ['))
    expect(deps).toContain('isActive')
    // …and it bails out when the pane is not on screen.
    expect(effect).toMatch(/if \(!isActive\) return/)
  })

  it('the effect detaches on cleanup', () => {
    // Without this the attach is a leak: the context outlives the visibility
    // that justified it, and we are back to N mounted terminals holding N
    // contexts.
    const effect = enclosingEffect(calls[0])
    expect(effect).toMatch(/return \(\) => \{/)
    expect(effect).toMatch(/\.dispose\(\)/)
  })

  it('the terminal mount effect no longer attaches WebGL itself', () => {
    // The mount effect is where this used to live, and its lifetime is the
    // TERMINAL's — which is exactly the lifetime that produced one context per
    // open session.
    const mount = src.indexOf('term.open(container)')
    expect(mount).toBeGreaterThan(-1)
    expect(calls[0]).toBeLessThan(mount)
  })

  it('the atlas coordinator registration shares the attach lifetime', () => {
    // A terminal with no context has nothing to resync, and leaving it
    // registered has it clearing its render model on behalf of an atlas it is
    // not drawing from.
    const effect = enclosingEffect(calls[0])
    expect(effect).toContain('atlasCoordinator.register(')
    expect(effect).toMatch(/unregister\?\.\(\)/)
  })
})
