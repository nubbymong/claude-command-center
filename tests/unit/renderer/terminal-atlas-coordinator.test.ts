/**
 * Unit tests for the cross-terminal glyph-atlas coordinator (#311).
 * Verifies that a shared-atlas clear repaints the OTHER terminals, that calls
 * coalesce into one pass per frame, and that unregister/teardown is honored —
 * all without a real GPU, DOM, or animation frame.
 */
import { describe, it, expect } from 'vitest'
import { createAtlasCoordinator } from '../../../src/renderer/components/terminal/atlasCoordinator'

/** A controllable requestAnimationFrame: callbacks queue until flush() runs
 *  them, so a test can assert how many frames were scheduled. */
function makeRaf() {
  let q: Array<() => void> = []
  return {
    raf: (cb: () => void) => { q.push(cb); return q.length },
    pending: () => q.length,
    flush: () => { const due = q; q = []; due.forEach((fn) => fn()) },
  }
}

describe('atlasCoordinator', () => {
  it('refreshes other terminals on the next frame, not the source', () => {
    const { raf, flush } = makeRaf()
    const coord = createAtlasCoordinator(raf)
    let a = 0, b = 0
    const rA = () => { a++ }
    const rB = () => { b++ }
    coord.register(rA)
    coord.register(rB)

    coord.notifyCleared(rA)
    // Nothing until the frame fires.
    expect(a).toBe(0)
    expect(b).toBe(0)

    flush()
    expect(a).toBe(0) // source skipped — it already repainted itself
    expect(b).toBe(1) // the other terminal was repainted
  })

  it('coalesces many clears in one frame into a single pass', () => {
    const { raf, pending, flush } = makeRaf()
    const coord = createAtlasCoordinator(raf)
    let a = 0, b = 0, c = 0
    const rA = () => { a++ }
    const rB = () => { b++ }
    const rC = () => { c++ }
    coord.register(rA)
    coord.register(rB)
    coord.register(rC)

    coord.notifyCleared(rA)
    coord.notifyCleared(rB)
    expect(pending()).toBe(1) // ONE frame scheduled, not two

    flush()
    expect(c).toBe(1)  // idle terminal repainted once
    expect(a).toBe(0)  // both sources skipped
    expect(b).toBe(0)
  })

  it('re-arms on the following frame', () => {
    const { raf, pending, flush } = makeRaf()
    const coord = createAtlasCoordinator(raf)
    let b = 0
    const rA = () => {}
    const rB = () => { b++ }
    coord.register(rA)
    coord.register(rB)

    coord.notifyCleared(rA)
    flush()
    expect(b).toBe(1)

    coord.notifyCleared(rA)
    expect(pending()).toBe(1) // a fresh frame is scheduled
    flush()
    expect(b).toBe(2)
  })

  it('does not refresh a terminal after it unregisters', () => {
    const { raf, flush } = makeRaf()
    const coord = createAtlasCoordinator(raf)
    let a = 0, b = 0
    const rA = () => { a++ }
    const rB = () => { b++ }
    coord.register(rA)
    const unregisterB = coord.register(rB)

    unregisterB()
    coord.notifyCleared(rA)
    flush()
    expect(b).toBe(0) // gone from the live set
  })

  it('keeps refreshing the rest when one refresh throws', () => {
    const { raf, flush } = makeRaf()
    const coord = createAtlasCoordinator(raf)
    let c = 0
    const rSource = () => {}
    const rThrows = () => { throw new Error('terminal disposed mid-frame') }
    const rC = () => { c++ }
    coord.register(rSource)
    coord.register(rThrows)
    coord.register(rC)

    coord.notifyCleared(rSource)
    expect(() => flush()).not.toThrow()
    expect(c).toBe(1) // the throwing terminal did not abort the pass
  })
})
