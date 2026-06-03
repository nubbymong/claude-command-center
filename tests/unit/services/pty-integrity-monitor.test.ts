import { describe, it, expect, vi } from 'vitest'
import { PtyIntegrityMonitor } from '../../../src/main/services/pty-integrity-monitor'

function makeMonitor(over = {}) {
  let t = 1000
  const emit = vi.fn()
  const m = new PtyIntegrityMonitor({ emit, now: () => t, emitDebounceMs: 0, eventCap: 3, ...over })
  return { m, emit, tick: (n: number) => { t += n } }
}

describe('PtyIntegrityMonitor', () => {
  it('accumulates pty bytes/chunks per session and reports totals', () => {
    const { m } = makeMonitor()
    m.recordPtyData('s1', 100)
    m.recordPtyData('s1', 50)
    m.recordPtyData('s2', 10)
    const snap = m.snapshot()
    expect(snap.totals.activeSessions).toBe(2)
    expect(snap.totals.bytesFromPty).toBe(160)
    expect(snap.sessions.find(s => s.sessionId === 's1')!.chunksFromPty).toBe(2)
  })

  it('flags a width desync when applied cols differ from the renderer cols', () => {
    const { m } = makeMonitor()
    m.recordResizeApplied('s1', 120, 30)
    m.recordRendererReport({ sessionId: 's1', bytesReceived: 0, bytesWritten: 0, strippedBytes: 0, cols: 100, rows: 30, resizeCount: 1 })
    const s = m.snapshot().sessions.find(x => x.sessionId === 's1')!
    expect(s.widthDesyncCount).toBe(1)
    expect(m.snapshot().recentEvents.some(e => e.kind === 'desync')).toBe(true)
  })

  it('counts a desync once per episode (hysteresis), not once per persistent report', () => {
    const { m } = makeMonitor({ eventCap: 100 })
    m.recordResizeApplied('s1', 120, 30)
    // Three reports with the SAME mismatch -> ONE desync episode.
    for (let i = 0; i < 3; i++) {
      m.recordRendererReport({ sessionId: 's1', bytesReceived: 0, bytesWritten: 0, strippedBytes: 0, cols: 100, rows: 30, resizeCount: 1 })
    }
    expect(m.snapshot().sessions.find(x => x.sessionId === 's1')!.widthDesyncCount).toBe(1)
    expect(m.snapshot().recentEvents.filter(e => e.kind === 'desync').length).toBe(1)
    // Re-sync (renderer matches main) clears the flag; a fresh mismatch is a NEW episode.
    m.recordRendererReport({ sessionId: 's1', bytesReceived: 0, bytesWritten: 0, strippedBytes: 0, cols: 120, rows: 30, resizeCount: 2 })
    m.recordRendererReport({ sessionId: 's1', bytesReceived: 0, bytesWritten: 0, strippedBytes: 0, cols: 90, rows: 30, resizeCount: 3 })
    expect(m.snapshot().sessions.find(x => x.sessionId === 's1')!.widthDesyncCount).toBe(2)
  })

  it('computes byteGap and emits a byte-gap event once past the threshold', () => {
    const { m } = makeMonitor({ byteGapThreshold: 4096 })
    m.recordPtyData('s1', 10000)
    m.recordRendererReport({ sessionId: 's1', bytesReceived: 5000, bytesWritten: 4800, strippedBytes: 200, cols: 120, rows: 30, resizeCount: 0 })
    const s = m.snapshot().sessions.find(x => x.sessionId === 's1')!
    expect(s.byteGap).toBe(5000)
    expect(m.diagnostics().logs.some(l => l.code === 'pty-byte-gap')).toBe(true)
  })

  it('caps the recent-events ring', () => {
    const { m } = makeMonitor() // eventCap: 3
    for (let i = 0; i < 5; i++) m.recordResizeApplied('s1', 100 + i, 30)
    expect(m.snapshot().recentEvents.length).toBe(3)
  })

  it('removes a session on endSession', () => {
    const { m } = makeMonitor()
    m.recordPtyData('s1', 5)
    m.endSession('s1')
    expect(m.snapshot().totals.activeSessions).toBe(0)
  })

  it('debounces emit (one emit per quiet window)', () => {
    vi.useFakeTimers()
    const emit = vi.fn()
    const m = new PtyIntegrityMonitor({ emit, now: () => 0, emitDebounceMs: 250 })
    m.recordPtyData('s1', 1)
    m.recordPtyData('s1', 1)
    expect(emit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(250)
    expect(emit).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
})
