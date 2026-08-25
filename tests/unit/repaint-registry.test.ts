import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  registerRepainter,
  requestSettleRepaint,
  requestResync,
  scheduleBleedRepaints,
  __clearRepaintRegistry,
  BLEED_REPAINT_DELAYS_MS,
} from '../../src/renderer/components/terminal/repaintRegistry'

// #379 fix E. When a GUI-subsystem tool writes into the console screen buffer,
// those bytes never reach xterm, so xterm's model and the screen disagree and
// xterm has no way to know. The only repair is an unconditional repaint, and the
// only trigger available is "we just typed a line we expect to bleed".

describe('repaintRegistry', () => {
  beforeEach(() => __clearRepaintRegistry())

  it('routes a repaint request to the registered terminal', () => {
    const settleStrong = vi.fn()
    registerRepainter('s1', { settleStrong })
    expect(requestSettleRepaint('s1')).toBe(true)
    expect(settleStrong).toHaveBeenCalledTimes(1)
  })

  it('is a no-op for a session with no terminal', () => {
    expect(requestSettleRepaint('nobody')).toBe(false)
  })

  it('unregisters on cleanup', () => {
    const settleStrong = vi.fn()
    const off = registerRepainter('s1', { settleStrong })
    off()
    expect(requestSettleRepaint('s1')).toBe(false)
    expect(settleStrong).not.toHaveBeenCalled()
  })

  it('a stale cleanup does not clobber a newer registration for the same session', () => {
    // A remount registers before the old effect's cleanup runs. If the old
    // cleanup deleted by key alone, the live terminal would go unreachable.
    const oldOne = vi.fn()
    const newOne = vi.fn()
    const offOld = registerRepainter('s1', { settleStrong: oldOne })
    registerRepainter('s1', { settleStrong: newOne })
    offOld()
    expect(requestSettleRepaint('s1')).toBe(true)
    expect(newOne).toHaveBeenCalledTimes(1)
    expect(oldOne).not.toHaveBeenCalled()
  })

  it('survives a terminal disposed between lookup and call', () => {
    registerRepainter('s1', { settleStrong: () => { throw new Error('disposed') } })
    expect(() => requestSettleRepaint('s1')).not.toThrow()
    expect(requestSettleRepaint('s1')).toBe(false)
  })
})

// #503: the resync request — the geometry-nudge repaint for console-direct
// splice damage, routed the same way.
describe('requestResync', () => {
  beforeEach(() => __clearRepaintRegistry())

  it('routes to the registered resync, not the plain repaint', () => {
    const settleStrong = vi.fn()
    const resync = vi.fn()
    registerRepainter('s1', { settleStrong, resync })
    expect(requestResync('s1')).toBe(true)
    expect(resync).toHaveBeenCalledTimes(1)
    expect(settleStrong).not.toHaveBeenCalled()
  })

  it('falls back to the plain repaint on a stub without resync', () => {
    const settleStrong = vi.fn()
    registerRepainter('s1', { settleStrong })
    expect(requestResync('s1')).toBe(true)
    expect(settleStrong).toHaveBeenCalledTimes(1)
  })

  it('is a no-op for a session with no terminal', () => {
    expect(requestResync('nobody')).toBe(false)
  })

  it('survives a terminal disposed between lookup and call', () => {
    registerRepainter('s1', { settleStrong: vi.fn(), resync: () => { throw new Error('disposed') } })
    expect(() => requestResync('s1')).not.toThrow()
    expect(requestResync('s1')).toBe(false)
  })
})

describe('scheduleBleedRepaints', () => {
  beforeEach(() => __clearRepaintRegistry())

  it('repaints immediately and schedules the later sweeps', () => {
    const settleStrong = vi.fn()
    registerRepainter('s1', { settleStrong })
    const timers: Array<{ cb: () => void; ms: number }> = []

    const armed = scheduleBleedRepaints('s1', { setTimer: (cb, ms) => { timers.push({ cb, ms }); return 0 } })

    expect(armed).toBe(BLEED_REPAINT_DELAYS_MS.length)
    // The t=0 one already fired; the rest are pending.
    expect(settleStrong).toHaveBeenCalledTimes(1)
    expect(timers.map((t) => t.ms)).toEqual(BLEED_REPAINT_DELAYS_MS.filter((d) => d > 0))

    // A bleed that lands seconds later is caught by a later sweep -- a single
    // arm at t=0 would have fired long before the tool finished writing.
    for (const t of timers) t.cb()
    expect(settleStrong).toHaveBeenCalledTimes(BLEED_REPAINT_DELAYS_MS.length)
  })

  it('schedules nothing when the session has no terminal', () => {
    const setTimer = vi.fn()
    expect(scheduleBleedRepaints('nobody', { setTimer })).toBe(0)
    expect(setTimer).not.toHaveBeenCalled()
  })

  it('a terminal that goes away mid-sweep does not throw on the later timers', () => {
    const settleStrong = vi.fn()
    const off = registerRepainter('s1', { settleStrong })
    const timers: Array<() => void> = []
    scheduleBleedRepaints('s1', { setTimer: (cb) => { timers.push(cb); return 0 } })
    off()
    expect(() => { for (const cb of timers) cb() }).not.toThrow()
    expect(settleStrong).toHaveBeenCalledTimes(1) // only the immediate one
  })
})
