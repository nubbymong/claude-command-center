import { describe, it, expect } from 'vitest'
import {
  createGeometryResync,
  RESYNC_RESTORE_DELAY_MS,
  type GeometryResyncDeps,
} from '../../src/renderer/components/terminal/geometryResync'

// #503: the hand-pulled repaint + geometry re-sync. A console-direct writer
// (ssh's host-key prompt) can leave the TUI's live region desynced from the
// real rows; the shrink→restore nudge makes the TUI re-lay-out, and the strong
// repaint clears our own stale cells. These pin the exact sequence, the
// at-fire-time geometry re-read, the decline paths, and the unmount restore.

type Timer = { cb: () => void; ms: number; cleared: boolean }

function harness(overrides: Partial<GeometryResyncDeps> = {}) {
  const timers: Timer[] = []
  const calls: string[] = []
  let geometry = { cols: 120, rows: 40 }
  const deps: GeometryResyncDeps = {
    getGeometry: () => ({ ...geometry }),
    resizePty: (c, r) => calls.push(`resize ${c}x${r}`),
    refresh: () => calls.push('refresh'),
    settleStrong: () => calls.push('settleStrong'),
    setTimer: (cb, ms) => {
      const t: Timer = { cb, ms, cleared: false }
      timers.push(t)
      return t
    },
    clearTimer: (h) => { (h as Timer).cleared = true },
    ...overrides,
  }
  return {
    resync: createGeometryResync(deps),
    calls,
    timers,
    setGeometry: (g: { cols: number; rows: number }) => { geometry = g },
    firePending: () => {
      for (const t of timers.splice(0)) if (!t.cleared) t.cb()
    },
  }
}

describe('createGeometryResync', () => {
  it('shrinks by one row, then restores, repaints, and settles — in that order', () => {
    const h = harness()
    expect(h.resync.fire()).toBe(true)
    expect(h.calls).toEqual(['resize 120x39'])
    expect(h.timers[0].ms).toBe(RESYNC_RESTORE_DELAY_MS)

    h.firePending()
    expect(h.calls).toEqual(['resize 120x39', 'resize 120x40', 'refresh', 'settleStrong'])
  })

  it('re-reads geometry at restore time — a user resize inside the window wins', () => {
    const h = harness()
    h.resync.fire()
    // The user resizes the window while the pty sits one row short.
    h.setGeometry({ cols: 200, rows: 60 })
    h.firePending()
    expect(h.calls).toContain('resize 200x60')
    expect(h.calls).not.toContain('resize 120x40')
  })

  it('reports the restored geometry through onRestore', () => {
    const restored: Array<[number, number]> = []
    const h = harness({ onRestore: (c, r) => restored.push([c, r]) })
    h.resync.fire()
    h.firePending()
    expect(restored).toEqual([[120, 40]])
  })

  it('declines while a cycle is already in flight, and can fire again after', () => {
    const h = harness()
    expect(h.resync.fire()).toBe(true)
    expect(h.resync.fire()).toBe(false)
    h.firePending()
    expect(h.resync.fire()).toBe(true)
  })

  it('declines while another jiggle is busy (the post-resume nudge)', () => {
    let busy = true
    const h = harness({ isBusy: () => busy })
    expect(h.resync.fire()).toBe(false)
    expect(h.calls).toEqual([])
    busy = false
    expect(h.resync.fire()).toBe(true)
  })

  it('declines on geometry too small to shrink', () => {
    const h = harness()
    h.setGeometry({ cols: 80, rows: 2 })
    expect(h.resync.fire()).toBe(false)
    h.setGeometry({ cols: 0, rows: 40 })
    expect(h.resync.fire()).toBe(false)
    expect(h.calls).toEqual([])
  })

  it('dispose mid-shrink restores the pty so a remount does not inherit one row short', () => {
    const h = harness()
    h.resync.fire()
    h.resync.dispose()
    expect(h.timers[0].cleared).toBe(true)
    expect(h.calls).toEqual(['resize 120x39', 'resize 120x40'])
    // And a fire after dispose is dead.
    expect(h.resync.fire()).toBe(false)
  })

  it('dispose restores LIVE geometry — a user resize inside the window survives the unmount race', () => {
    const h = harness()
    h.resync.fire()
    // The pty outlives the view; restoring the stale capture would leave it
    // at the pre-resize size.
    h.setGeometry({ cols: 200, rows: 60 })
    h.resync.dispose()
    expect(h.calls).toEqual(['resize 120x39', 'resize 200x60'])
  })

  it('dispose falls back to the fire-time capture when the term is already gone', () => {
    let fired = false
    const h = harness({
      getGeometry: () => {
        if (fired) throw new Error('disposed')
        fired = true
        return { cols: 120, rows: 40 }
      },
    })
    h.resync.fire()
    h.resync.dispose()
    expect(h.calls).toEqual(['resize 120x39', 'resize 120x40'])
  })

  it('dispose with nothing in flight touches nothing', () => {
    const h = harness()
    h.resync.dispose()
    expect(h.calls).toEqual([])
  })

  it('a restore firing after dispose does nothing', () => {
    // The timer seam let the callback survive clearTimer; the disposed flag
    // must still gate it.
    const h = harness({ clearTimer: () => { /* deliberately leaky */ } })
    h.resync.fire()
    h.resync.dispose()
    const after = h.calls.length
    h.firePending()
    expect(h.calls.length).toBe(after)
  })
})
