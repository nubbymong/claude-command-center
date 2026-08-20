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

  // ---------------------------------------------------------------------------
  // The per-frame skip set must RESET. Found by mutation testing: deleting
  // `clearedThisFrame.clear()` from flush() left the whole suite green.
  //
  // Without the reset, `clearedThisFrame` becomes a permanent skip-list: any
  // terminal that has ever cleared the atlas is excluded from every future
  // coordinated refresh -- and the terminals that clear are the busy ones. The
  // existing 're-arms on the following frame' case walks past it because rA is
  // the source in BOTH frames and only rB is asserted.
  // ---------------------------------------------------------------------------

  it('forgets last frame sources, so a previous source is refreshed next frame', () => {
    const { raf, flush } = makeRaf()
    const coord = createAtlasCoordinator(raf)
    let a = 0, b = 0
    const rA = () => { a++ }
    const rB = () => { b++ }
    coord.register(rA)
    coord.register(rB)

    coord.notifyCleared(rA)
    flush()
    expect(a).toBe(0)   // A was the source this frame
    expect(b).toBe(1)

    // A DIFFERENT terminal clears next frame. A is now a victim and must repaint.
    coord.notifyCleared(rB)
    flush()
    expect(a).toBe(1)   // the assertion the old tests never made
    expect(b).toBe(1)   // B is the source now
  })

  it('does not accumulate sources across many frames', () => {
    const { raf, flush } = makeRaf()
    const coord = createAtlasCoordinator(raf)
    const hits = [0, 0, 0]
    const cbs = hits.map((_, i) => () => { hits[i]++ })
    cbs.forEach((c) => coord.register(c))

    // Round-robin: each terminal takes a turn as the source. With a leaking skip
    // set every terminal ends up permanently skipped and the counts stall.
    for (let round = 0; round < 3; round++) {
      coord.notifyCleared(cbs[round % 3])
      flush()
    }
    // 3 frames, 2 victims each = 6 refreshes spread over 3 terminals.
    expect(hits[0] + hits[1] + hits[2]).toBe(6)
    expect(Math.min(...hits)).toBeGreaterThan(0)
  })

  it('keeps working after a raf that throws', () => {
    // `armed = true` is set BEFORE raf(flush). If raf throws and armed is never
    // cleared, the process-wide singleton never schedules another refresh for
    // the life of the app.
    let throwOnce = true
    const q: Array<() => void> = []
    const raf = (cb: () => void) => {
      if (throwOnce) { throwOnce = false; throw new Error('rAF unavailable') }
      q.push(cb); return q.length
    }
    const coord = createAtlasCoordinator(raf)
    let b = 0
    const rA = () => {}
    const rB = () => { b++ }
    coord.register(rA)
    coord.register(rB)

    expect(() => coord.notifyCleared(rA)).not.toThrow()
    coord.notifyCleared(rA)
    q.splice(0).forEach((fn) => fn())
    expect(b).toBe(1)
  })
})
