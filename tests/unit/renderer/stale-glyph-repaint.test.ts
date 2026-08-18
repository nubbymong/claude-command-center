/**
 * Unit tests for the #273 stale-glyph repaint scheduler.
 *
 * Both units are pure and dependency-injected: the trigger predicate and the
 * leading-edge throttle are exercised with a fake clock + fake timers, no DOM.
 */
import { describe, it, expect } from 'vitest'
import {
  shouldRepaintOnOutput,
  shouldSoftRepaintOnOutput,
  outputRepaintIntervalMs,
  createStaleGlyphRepainter,
  REPAINT_MIN_INTERVAL_MS,
  BOTTOM_STREAM_INTERVAL_MS,
  SETTLE_QUIET_MS,
  WHEEL_ACTIVE_MS,
} from '../../../src/renderer/components/terminal/staleGlyphRepaint'

describe('shouldRepaintOnOutput', () => {
  const base = { alternateBuffer: false, scrolledUp: false, msSinceWheel: Infinity, wheelActiveMs: WHEEL_ACTIVE_MS }

  it('never repaints in the alternate buffer, even when scrolled up', () => {
    expect(shouldRepaintOnOutput({ ...base, alternateBuffer: true, scrolledUp: true })).toBe(false)
    expect(shouldRepaintOnOutput({ ...base, alternateBuffer: true, msSinceWheel: 0 })).toBe(false)
  })

  it('repaints in the normal buffer when the user is scrolled up', () => {
    expect(shouldRepaintOnOutput({ ...base, scrolledUp: true })).toBe(true)
  })

  it('repaints in the normal buffer shortly after a wheel event', () => {
    expect(shouldRepaintOnOutput({ ...base, msSinceWheel: WHEEL_ACTIVE_MS - 1 })).toBe(true)
  })

  // beta.14 regression fix. #292 made this return true for EVERY normal-buffer
  // chunk, which meant an atlas rebuild 1-4 times a second for as long as output
  // flowed. Claude Code renders in the normal buffer, so that ran for the whole
  // life of every session: continuous flashing, and frames drawn against a
  // half-rebuilt atlas. The STRONG (atlas-rebuilding) repaint is only for the
  // conditions that corrupt the atlas; at-bottom streaming takes the cheap path.
  it('does NOT force an atlas rebuild for steady at-bottom streaming', () => {
    expect(shouldRepaintOnOutput({ ...base, msSinceWheel: WHEEL_ACTIVE_MS })).toBe(false)
    expect(shouldRepaintOnOutput({ ...base, msSinceWheel: Infinity })).toBe(false)
  })
})

// #273 follow-up: the ghost also forms under steady at-bottom streaming with no
// scroll at all (a slicer's stderr) — and stayed, because nothing repainted. That
// coverage is kept, as a refresh-only repaint.
describe('shouldSoftRepaintOnOutput', () => {
  const base = { alternateBuffer: false, scrolledUp: false, msSinceWheel: Infinity, wheelActiveMs: WHEEL_ACTIVE_MS }

  it('covers steady at-bottom streaming (the case the strong repaint no longer takes)', () => {
    expect(shouldSoftRepaintOnOutput({ ...base, msSinceWheel: WHEEL_ACTIVE_MS })).toBe(true)
    expect(shouldSoftRepaintOnOutput({ ...base, msSinceWheel: Infinity })).toBe(true)
  })

  it('still leaves the alternate screen alone', () => {
    expect(shouldSoftRepaintOnOutput({ ...base, alternateBuffer: true })).toBe(false)
  })
})

describe('outputRepaintIntervalMs', () => {
  const base = { alternateBuffer: false, scrolledUp: false, msSinceWheel: Infinity, wheelActiveMs: WHEEL_ACTIVE_MS }

  it('paces scrolled-up / wheel-active streams at the fast interval (4/sec)', () => {
    expect(outputRepaintIntervalMs({ ...base, scrolledUp: true })).toBe(REPAINT_MIN_INTERVAL_MS)
    expect(outputRepaintIntervalMs({ ...base, msSinceWheel: WHEEL_ACTIVE_MS - 1 })).toBe(REPAINT_MIN_INTERVAL_MS)
  })

  it('paces steady at-bottom streams at the gentle interval (1/sec)', () => {
    expect(outputRepaintIntervalMs({ ...base, msSinceWheel: WHEEL_ACTIVE_MS })).toBe(BOTTOM_STREAM_INTERVAL_MS)
    expect(outputRepaintIntervalMs(base)).toBe(BOTTOM_STREAM_INTERVAL_MS)
    expect(BOTTOM_STREAM_INTERVAL_MS).toBeGreaterThan(REPAINT_MIN_INTERVAL_MS)
  })
})

/** A manual clock + timer queue so throttle boundaries are exercised exactly.
 *  webglActive controls what clearAtlas() reports (true = WebGL active/atlas
 *  cleared; false = DOM-renderer fallback with nothing to clear). */
function makeHarness({ webglActive = true }: { webglActive?: boolean } = {}) {
  let time = 0
  let nextId = 1
  const timers: Array<{ id: number; cb: () => void; at: number }> = []
  let clearAtlas = 0
  let refresh = 0

  const deps = {
    clearAtlas: () => { clearAtlas++; return webglActive },
    atlasActive: () => webglActive,
    refresh: () => { refresh++ },
    now: () => time,
    setTimer: (cb: () => void, ms: number) => {
      const id = nextId++
      timers.push({ id, cb, at: time + ms })
      return id as unknown as ReturnType<typeof setTimeout>
    },
    clearTimer: (h: ReturnType<typeof setTimeout>) => {
      const i = timers.findIndex((t) => t.id === (h as unknown as number))
      if (i >= 0) timers.splice(i, 1)
    },
  }

  const advance = (ms: number) => {
    const target = time + ms
    for (;;) {
      timers.sort((a, b) => a.at - b.at)
      if (timers.length === 0 || timers[0].at > target) break
      const t = timers.shift()!
      time = t.at
      t.cb()
    }
    time = target
  }

  return {
    deps,
    advance,
    counts: () => ({ clearAtlas, refresh }),
    pendingTimers: () => timers.length,
  }
}

describe('createStaleGlyphRepainter — the cheap (soft) repaint, beta.14', () => {
  // The beta.13 regression: every chunk of normal-buffer output rebuilt the
  // glyph atlas, so a Claude Code session (normal buffer, output essentially
  // continuous) flashed nonstop and drew frames against a half-rebuilt atlas.
  // A stale painted cell only needs the viewport re-rendered from the atlas
  // already in memory.
  it('refreshes WITHOUT rebuilding the atlas when strong=false', () => {
    const h = makeHarness()
    const r = createStaleGlyphRepainter(h.deps)
    r.schedule(1000, false)
    expect(h.counts()).toEqual({ clearAtlas: 0, refresh: 1 })
  })

  it('never rebuilds the atlas across a long at-bottom stream', () => {
    const h = makeHarness()
    const r = createStaleGlyphRepainter(h.deps)
    // 30 seconds of steady output at the at-bottom pace.
    for (let i = 0; i < 300; i++) {
      r.schedule(1000, false)
      r.settle(300, 1000, false)
      h.advance(100)
    }
    h.advance(2000)
    expect(h.counts().clearAtlas).toBe(0)
  })

  it('skips even the refresh when WebGL is inactive (nothing to repaint)', () => {
    const h = makeHarness({ webglActive: false })
    const r = createStaleGlyphRepainter(h.deps)
    r.schedule(1000, false)
    expect(h.counts()).toEqual({ clearAtlas: 0, refresh: 0 })
  })

  // A wheel landing mid-stream must still get the atlas rebuild it asked for,
  // rather than being swallowed by a cheap repaint that coalesced first.
  it('upgrades a coalesced window to strong when any request in it was strong', () => {
    const h = makeHarness()
    const r = createStaleGlyphRepainter(h.deps)
    r.schedule(1000, false)            // leading edge: cheap repaint
    expect(h.counts()).toEqual({ clearAtlas: 0, refresh: 1 })
    h.advance(50)
    r.schedule(1000, false)            // coalesced, cheap
    r.schedule(1000, true)             // ...then a wheel arrives: strong
    h.advance(1000)
    expect(h.counts().clearAtlas).toBe(1)
  })

  it('defaults to a strong repaint when no flag is passed', () => {
    const h = makeHarness()
    const r = createStaleGlyphRepainter(h.deps)
    r.schedule(1000)
    expect(h.counts()).toEqual({ clearAtlas: 1, refresh: 1 })
  })
})

describe('createStaleGlyphRepainter', () => {
  it('exposes the documented throttle interval default', () => {
    expect(REPAINT_MIN_INTERVAL_MS).toBe(250)
  })

  it('repaints immediately on the leading edge (atlas THEN refresh)', () => {
    const h = makeHarness()
    const r = createStaleGlyphRepainter(h.deps)
    r.schedule()
    expect(h.counts()).toEqual({ clearAtlas: 1, refresh: 1 })
  })

  // #273 adversarial review: a DOM-renderer session (no WebGL) has no atlas
  // ghost, so clearAtlas() returns false and the expensive full-viewport
  // refresh must be skipped — otherwise those sessions pay ~4/sec forced
  // reflows for a bug they don't have.
  it('skips the refresh when WebGL is inactive (clearAtlas returns false)', () => {
    const h = makeHarness({ webglActive: false })
    const r = createStaleGlyphRepainter(h.deps)
    r.schedule()                 // leading edge: atlas is probed...
    expect(h.counts()).toEqual({ clearAtlas: 1, refresh: 0 })  // ...but no refresh
    // And under a firehose it stays refresh-free (still throttled to ~4 probes/sec).
    for (let i = 0; i < 63; i++) { r.schedule(); h.advance(16) }
    expect(h.counts().refresh).toBe(0)
  })

  it('coalesces a burst inside the window into a single trailing repaint', () => {
    const h = makeHarness()
    const r = createStaleGlyphRepainter(h.deps)

    r.schedule()               // leading paint at t=0
    expect(h.counts().clearAtlas).toBe(1)

    h.advance(50)
    r.schedule()               // within window → arms one trailing timer
    r.schedule()               // still within window, timer armed → no-op
    r.schedule()
    expect(h.counts().clearAtlas).toBe(1) // no extra immediate paints
    expect(h.pendingTimers()).toBe(1)

    h.advance(200)             // reaches t=250, trailing fires
    expect(h.counts().clearAtlas).toBe(2)
    expect(h.pendingTimers()).toBe(0)
  })

  it('leads again once a full interval has elapsed', () => {
    const h = makeHarness()
    const r = createStaleGlyphRepainter(h.deps)
    r.schedule()               // t=0 → paint 1
    h.advance(REPAINT_MIN_INTERVAL_MS)
    r.schedule()               // t=250, since>=interval → immediate paint 2
    expect(h.counts().clearAtlas).toBe(2)
  })

  it('holds a continuous per-frame firehose to one repaint per interval', () => {
    const h = makeHarness()
    const r = createStaleGlyphRepainter(h.deps)
    // 1000ms of output scheduled every 16ms.
    for (let i = 0; i < 63; i++) { r.schedule(); h.advance(16) }
    // Leading paint at 0, then trailing at 250/500/750/1000 → 4-5 total, never 63.
    expect(h.counts().clearAtlas).toBeLessThanOrEqual(6)
    expect(h.counts().clearAtlas).toBeGreaterThanOrEqual(4)
  })

  it('honours a per-call interval: an at-bottom stream repaints once per second, not 4x', () => {
    const h = makeHarness()
    const r = createStaleGlyphRepainter(h.deps)
    // 3000ms of at-bottom output every 16ms at the gentle pace.
    for (let i = 0; i < 188; i++) { r.schedule(BOTTOM_STREAM_INTERVAL_MS); h.advance(16) }
    // Leading paint at 0, then trailing at ~1000/2000/3000 → 3-4 total, never 12+.
    expect(h.counts().clearAtlas).toBeGreaterThanOrEqual(3)
    expect(h.counts().clearAtlas).toBeLessThanOrEqual(5)
  })

  it('a wheel (fast pace) arriving mid at-bottom stream paints as soon as ITS window allows', () => {
    const h = makeHarness()
    const r = createStaleGlyphRepainter(h.deps)
    r.schedule(BOTTOM_STREAM_INTERVAL_MS)      // t=0 paint 1
    h.advance(100)
    r.schedule(BOTTOM_STREAM_INTERVAL_MS)      // arms the slow trailing timer at t=1000
    h.advance(200)                             // t=300: ≥ fast interval since paint 1
    r.schedule(REPAINT_MIN_INTERVAL_MS)        // fast request → immediate paint 2 (timer replaced)
    expect(h.counts().clearAtlas).toBe(2)
    expect(h.pendingTimers()).toBe(0)
  })

  // #292 review: a fast request INSIDE its own window while a slow timer is
  // armed must bring the repaint forward to the fast edge, not wait ~1s.
  it('a wheel inside the fast window brings an armed slow trailing timer forward to the fast edge', () => {
    const h = makeHarness()
    const r = createStaleGlyphRepainter(h.deps)
    r.schedule(BOTTOM_STREAM_INTERVAL_MS)      // t=0 paint 1
    h.advance(100)
    r.schedule(BOTTOM_STREAM_INTERVAL_MS)      // slow trailing timer due at t=1000
    h.advance(50)                              // t=150: inside the fast window too
    r.schedule(REPAINT_MIN_INTERVAL_MS)        // fast request → timer re-armed for t=250
    expect(h.counts().clearAtlas).toBe(1)
    expect(h.pendingTimers()).toBe(1)
    h.advance(100)                             // t=250
    expect(h.counts().clearAtlas).toBe(2)      // NOT still waiting on t=1000
    expect(h.pendingTimers()).toBe(0)
  })

  it('a slower request never pushes an armed faster timer later', () => {
    const h = makeHarness()
    const r = createStaleGlyphRepainter(h.deps)
    r.schedule()                               // t=0 paint 1 (fast pace)
    h.advance(100)
    r.schedule()                               // fast trailing timer due at t=250
    r.schedule(BOTTOM_STREAM_INTERVAL_MS)      // slow request: due t=1000 ≥ 250 → let the fast one stand
    expect(h.pendingTimers()).toBe(1)
    h.advance(150)                             // t=250
    expect(h.counts().clearAtlas).toBe(2)
  })

  it('settle(): one repaint after output goes quiet, re-armed by every chunk', () => {
    const h = makeHarness()
    const r = createStaleGlyphRepainter(h.deps)
    r.schedule(BOTTOM_STREAM_INTERVAL_MS); r.settle()   // t=0 leading paint 1
    // A stream that keeps arriving inside the quiet window never lets it fire...
    for (let i = 1; i <= 10; i++) { h.advance(100); r.settle() }   // t=1000
    expect(h.counts().clearAtlas).toBe(1)
    // ...then output stops: the settle repaint lands one quiet window later —
    // through the throttle, so it is a normal (fast-pace) leading paint.
    h.advance(SETTLE_QUIET_MS)                        // t=1300
    expect(h.counts().clearAtlas).toBe(2)
    expect(h.pendingTimers()).toBe(0)
    // And it does not keep firing on its own.
    h.advance(5000)
    expect(h.counts().clearAtlas).toBe(2)
  })

  // #292 cross-check (MAJOR): SETTLE_QUIET_MS (300ms) is below typical log-line
  // cadence, so a steady at-bottom stream leaves a >quiet gap between chunks and
  // the settle fires between them every time. If the settle repaints at the FAST
  // pace it drags the stream up to ~chunk rate, defeating BOTTOM_STREAM_INTERVAL.
  // Routed at the stream's own pace it stays ~1/sec.
  it('a steady at-bottom stream whose gaps exceed the quiet window still holds ~1/sec (settle at stream pace)', () => {
    const h = makeHarness()
    const r = createStaleGlyphRepainter(h.deps)
    // 30 chunks, 350ms apart (>SETTLE_QUIET_MS): the TerminalView wiring for an
    // at-bottom stream — schedule(1000) + settle(_, 1000) per chunk.
    for (let i = 0; i < 30; i++) {
      r.schedule(BOTTOM_STREAM_INTERVAL_MS)
      r.settle(undefined, BOTTOM_STREAM_INTERVAL_MS)
      h.advance(350)
    }
    // ~10.5s of output → about 1/sec, NOT ~3/sec. Generous upper bound catches
    // the regression (which produced ~31) while tolerating boundary paints.
    expect(h.counts().clearAtlas).toBeLessThanOrEqual(13)
    expect(h.counts().clearAtlas).toBeGreaterThanOrEqual(10)
  })

  it('the settle still clears the final ghost within one interval once output stops', () => {
    const h = makeHarness()
    const r = createStaleGlyphRepainter(h.deps)
    r.schedule(BOTTOM_STREAM_INTERVAL_MS)                 // t=0 paint 1
    r.settle(undefined, BOTTOM_STREAM_INTERVAL_MS)
    h.advance(350)                                        // one more chunk...
    r.schedule(BOTTOM_STREAM_INTERVAL_MS)                 // t=350: trailing armed for t=1000
    r.settle(undefined, BOTTOM_STREAM_INTERVAL_MS)        // settle armed for t=650
    const before = h.counts().clearAtlas
    // ...then output STOPS. Within one BOTTOM_STREAM_INTERVAL the ghost clears.
    h.advance(BOTTOM_STREAM_INTERVAL_MS)                  // to t=1350
    expect(h.counts().clearAtlas).toBeGreaterThan(before)
    expect(h.pendingTimers()).toBe(0)
  })

  it('settle() never doubles up on a repaint that just happened', () => {
    const h = makeHarness()
    const r = createStaleGlyphRepainter(h.deps)
    r.schedule(); r.settle()          // t=0 paint 1, settle armed for t=300
    h.advance(200)
    r.schedule()                      // t=200: inside the fast window → trailing at t=250
    h.advance(50)                     // t=250: trailing paint 2
    expect(h.counts().clearAtlas).toBe(2)
    h.advance(50)                     // t=300: settle fires; 50ms since paint 2 → coalesces
    expect(h.counts().clearAtlas).toBe(2)
    expect(h.pendingTimers()).toBe(1) // one trailing repaint at t=500, not an extra now
    h.advance(250)
    expect(h.counts().clearAtlas).toBe(3)
    expect(h.pendingTimers()).toBe(0)
  })

  it('dispose() cancels a pending settle repaint too', () => {
    const h = makeHarness()
    const r = createStaleGlyphRepainter(h.deps)
    r.settle()
    expect(h.pendingTimers()).toBe(1)
    r.dispose()
    expect(h.pendingTimers()).toBe(0)
    h.advance(5000)
    r.settle()                        // disposed → ignored
    expect(h.pendingTimers()).toBe(0)
    expect(h.counts().clearAtlas).toBe(0)
  })

  it('dispose() cancels a pending repaint and refuses further ones', () => {
    const h = makeHarness()
    const r = createStaleGlyphRepainter(h.deps)
    r.schedule()               // paint 1
    h.advance(50)
    r.schedule()               // arms trailing timer
    expect(h.pendingTimers()).toBe(1)
    r.dispose()
    expect(h.pendingTimers()).toBe(0)
    h.advance(1000)
    r.schedule()               // disposed → ignored
    expect(h.counts().clearAtlas).toBe(1)
  })
})
