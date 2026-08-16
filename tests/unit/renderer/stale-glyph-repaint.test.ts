/**
 * Unit tests for the #273 stale-glyph repaint scheduler.
 *
 * Both units are pure and dependency-injected: the trigger predicate and the
 * leading-edge throttle are exercised with a fake clock + fake timers, no DOM.
 */
import { describe, it, expect } from 'vitest'
import {
  shouldRepaintOnOutput,
  createStaleGlyphRepainter,
  REPAINT_MIN_INTERVAL_MS,
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

  it('does NOT repaint at the bottom with no recent scroll', () => {
    expect(shouldRepaintOnOutput({ ...base, msSinceWheel: WHEEL_ACTIVE_MS })).toBe(false)
    expect(shouldRepaintOnOutput({ ...base, msSinceWheel: Infinity })).toBe(false)
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
