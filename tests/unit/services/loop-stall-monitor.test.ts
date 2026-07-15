import { describe, it, expect } from 'vitest'
import {
  LoopStallMonitor,
  TICK_INTERVAL_MS,
  LATE_THRESHOLD_MS,
  WINDOW_MS,
} from '../../../src/main/services/loop-stall-monitor'

/** A manual scheduler + clock: the monitor schedules its next tick via setTimer;
 *  we capture that callback and fire it after advancing the clock ourselves, so a
 *  "late" tick is simulated by advancing more than the interval before firing. */
function makeHarness() {
  let now = 0
  let pending: (() => void) | null = null
  const monitor = new LoopStallMonitor({
    now: () => now,
    setTimer: (cb) => { pending = cb; return 1 as unknown as ReturnType<typeof setTimeout> },
    clearTimer: () => { pending = null },
  })
  return {
    monitor,
    at: (t: number) => { now = t },
    advance: (ms: number) => { now += ms },
    /** Fire the currently-scheduled tick (the monitor re-schedules inside). */
    fireTick: () => { const cb = pending; pending = null; cb?.() },
    hasPending: () => pending !== null,
  }
}

describe('LoopStallMonitor', () => {
  it('exposes the documented thresholds (mirrored by the hooks child)', () => {
    expect(TICK_INTERVAL_MS).toBe(500)
    expect(LATE_THRESHOLD_MS).toBe(250)
    expect(WINDOW_MS).toBe(60_000)
  })

  it('starts at zero stalls and schedules a tick', () => {
    const h = makeHarness()
    h.monitor.start()
    expect(h.monitor.stallsLastMin()).toBe(0)
    expect(h.hasPending()).toBe(true)
  })

  it('an on-time tick records no stall', () => {
    const h = makeHarness()
    h.monitor.start()                 // last = 0
    h.advance(TICK_INTERVAL_MS)       // exactly on schedule (lateness = 0)
    h.fireTick()
    expect(h.monitor.stallsLastMin()).toBe(0)
  })

  it('a tick within the late threshold records no stall', () => {
    const h = makeHarness()
    h.monitor.start()
    h.advance(TICK_INTERVAL_MS + LATE_THRESHOLD_MS) // exactly at threshold (not > )
    h.fireTick()
    expect(h.monitor.stallsLastMin()).toBe(0)
  })

  it('a tick more than 250ms late records one stall', () => {
    const h = makeHarness()
    h.monitor.start()
    h.advance(TICK_INTERVAL_MS + LATE_THRESHOLD_MS + 1) // 751ms => 251ms late
    h.fireTick()
    expect(h.monitor.stallsLastMin()).toBe(1)
  })

  it('accumulates multiple stalls across successive late ticks', () => {
    const h = makeHarness()
    h.monitor.start()
    for (let i = 0; i < 3; i++) {
      h.advance(TICK_INTERVAL_MS + 400) // each tick 400ms late => a stall
      h.fireTick()
    }
    expect(h.monitor.stallsLastMin()).toBe(3)
  })

  it('drops stalls older than the 60s rolling window', () => {
    const h = makeHarness()
    h.monitor.start()
    // One stall near t=751.
    h.advance(TICK_INTERVAL_MS + 400)
    h.fireTick()
    expect(h.monitor.stallsLastMin()).toBe(1)
    // Jump the clock well past the window so the old stall ages out.
    h.advance(WINDOW_MS + 1000)
    expect(h.monitor.stallsLastMin()).toBe(0)
  })

  it('stop() clears the pending tick and is idempotent', () => {
    const h = makeHarness()
    h.monitor.start()
    h.monitor.stop()
    expect(h.hasPending()).toBe(false)
    expect(() => h.monitor.stop()).not.toThrow()
  })

  it('start() is idempotent (does not double-schedule)', () => {
    const h = makeHarness()
    h.monitor.start()
    h.monitor.start() // no-op while already running
    h.advance(TICK_INTERVAL_MS + 400)
    h.fireTick()
    // Only one scheduler chain ran, so exactly one stall.
    expect(h.monitor.stallsLastMin()).toBe(1)
  })
})
