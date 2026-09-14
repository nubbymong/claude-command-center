// tests/unit/pty-chunked-write.test.ts
//
// R-010 regression: the chunked large-paste loop must (1) re-check liveness
// before EVERY chunk and stop when the session is gone / its PTY was replaced,
// and (2) never let a write to a dead PTY throw out of the timer callback (which
// the global uncaughtException handler re-throws → main crash).
import { describe, it, expect } from 'vitest'
import { runChunkedWrite } from '../../src/main/pty-chunked-write'

/** A synchronous scheduler so the whole loop runs in one tick (no fake timers). */
function syncSchedule(fn: () => void): void {
  fn()
}

describe('runChunkedWrite (R-010)', () => {
  it('writes every chunk in order while the session stays alive', () => {
    const data = 'x'.repeat(1000) // > one chunk
    const written: string[] = []
    runChunkedWrite(data, {
      write: (s) => written.push(s),
      isAlive: () => true,
      schedule: syncSchedule,
      chunkSize: 256,
    })
    expect(written.join('')).toBe(data)
    // 1000 / 256 = ceil → 4 chunks.
    expect(written).toHaveLength(4)
    expect(written.slice(0, 3).every((c) => c.length === 256)).toBe(true)
    expect(written[3].length).toBe(1000 - 256 * 3)
  })

  it('stops mid-paste (drops the rest) when the session dies — no further writes', () => {
    const data = 'y'.repeat(1000)
    const written: string[] = []
    let alive = true
    runChunkedWrite(data, {
      // Kill the session after the first chunk lands.
      write: (s) => { written.push(s); if (written.length === 1) alive = false },
      isAlive: () => alive,
      schedule: syncSchedule,
      chunkSize: 256,
    })
    // First chunk written; liveness check before chunk 2 bails → only 1 chunk.
    expect(written).toHaveLength(1)
    expect(written[0].length).toBe(256)
  })

  it('never re-enters write() after the PTY is replaced (isAlive false from the start)', () => {
    const written: string[] = []
    runChunkedWrite('z'.repeat(1000), {
      write: (s) => written.push(s),
      isAlive: () => false, // PTY already replaced before the first chunk
      schedule: syncSchedule,
    })
    expect(written).toHaveLength(0)
  })

  it('a throwing write (dead/destroyed PTY) is swallowed and stops the loop — does not propagate', () => {
    const data = 'w'.repeat(1000)
    const written: string[] = []
    expect(() =>
      runChunkedWrite(data, {
        write: (s) => {
          written.push(s)
          if (written.length === 2) throw new Error('ERR_STREAM_DESTROYED')
        },
        isAlive: () => true,
        schedule: syncSchedule,
        chunkSize: 256,
      }),
    ).not.toThrow()
    // Wrote chunk 1, then chunk 2 threw → loop stopped; no chunk 3/4.
    expect(written).toHaveLength(2)
  })

  it('a short write (single chunk) completes without scheduling', () => {
    const written: string[] = []
    let scheduled = 0
    runChunkedWrite('short', {
      write: (s) => written.push(s),
      isAlive: () => true,
      schedule: () => { scheduled++ },
      chunkSize: 256,
    })
    expect(written).toEqual(['short'])
    expect(scheduled).toBe(0) // nothing left to schedule
  })

  // onDone (Unit 5 P1.5): fires exactly once at every terminal outcome so the
  // envelope writer's Promise can resolve and the PasteQueue won't stall.
  it('calls onDone once when all bytes are written', () => {
    let dones = 0
    runChunkedWrite('x'.repeat(600), {
      write: () => {}, isAlive: () => true, schedule: syncSchedule, chunkSize: 256,
      onDone: () => { dones++ },
    })
    expect(dones).toBe(1)
  })
  it('calls onDone when the session bails mid-paste', () => {
    let dones = 0; let alive = true
    runChunkedWrite('y'.repeat(600), {
      write: () => { alive = false }, isAlive: () => alive, schedule: syncSchedule, chunkSize: 256,
      onDone: () => { dones++ },
    })
    expect(dones).toBe(1)
  })
  it('calls onDone when a write throws', () => {
    let dones = 0
    runChunkedWrite('w'.repeat(600), {
      write: () => { throw new Error('dead') }, isAlive: () => true, schedule: syncSchedule, chunkSize: 256,
      onDone: () => { dones++ },
    })
    expect(dones).toBe(1)
  })

  // #242 tier 4: onProgress is how pty-manager surfaces the ~1.27 MB
  // tmux-push transfer's progress via emitSshFlowState('running-setup',
  // 'staging tmux NN%') with zero new IPC channels. Mutation to prove this
  // can fail: comment out the `hooks.onProgress?.(offset, total)` call in
  // runChunkedWrite — progressCalls.length stays 0 and this test fails,
  // without touching any of the liveness/crash-safety cases above.
  it('calls onProgress with monotonically non-decreasing byte counts ending at data.length', () => {
    const data = 'p'.repeat(1000)
    const progressCalls: Array<[number, number]> = []
    runChunkedWrite(data, {
      write: () => {},
      isAlive: () => true,
      schedule: syncSchedule,
      chunkSize: 256,
      onProgress: (sent, total) => progressCalls.push([sent, total]),
    })
    // 1000 / 256 = ceil → 4 chunks → 4 progress calls, one per chunk.
    expect(progressCalls).toHaveLength(4)
    expect(progressCalls.every(([, total]) => total === data.length)).toBe(true)
    const sentCounts = progressCalls.map(([sent]) => sent)
    for (let i = 1; i < sentCounts.length; i++) {
      expect(sentCounts[i]).toBeGreaterThanOrEqual(sentCounts[i - 1])
    }
    expect(sentCounts[sentCounts.length - 1]).toBe(data.length)
  })

  // onProgress must reflect only bytes that ACTUALLY landed — a caller
  // computing a percentage from it must never see a total that outruns
  // reality when the session dies mid-transfer.
  it('stops calling onProgress once the session dies mid-write (never reports past the last real chunk)', () => {
    const data = 'q'.repeat(1000)
    const progressCalls: number[] = []
    let alive = true
    runChunkedWrite(data, {
      write: () => {},
      isAlive: () => alive,
      schedule: syncSchedule,
      chunkSize: 256,
      // Kill the session right after chunk 1's progress is reported —
      // chunk 2's liveness check (which runs BEFORE its write/onProgress)
      // then bails, so exactly one progress call total.
      onProgress: (sent) => { progressCalls.push(sent); alive = false },
    })
    expect(progressCalls).toEqual([256])
  })

  // #242 round-3 MINOR fix: onProgress is a NEW un-absorbed call on this
  // setTimeout-driven path (module doc comment: nothing may throw out of the
  // timer callback, because the global uncaughtException handler re-throws
  // and kills main). Mutation to prove this can fail: remove the try/catch
  // around `hooks.onProgress?.(offset, total)` in runChunkedWrite -- the
  // throw then propagates out of writeNext() and this test's `.not.toThrow()`
  // fails, without touching any of the liveness/crash-safety cases above.
  it('a throwing onProgress hook is swallowed and does not abort the write', () => {
    const written: string[] = []
    expect(() =>
      runChunkedWrite('r'.repeat(600), {
        write: (s) => written.push(s),
        isAlive: () => true,
        schedule: syncSchedule,
        chunkSize: 256,
        onProgress: () => { throw new Error('progress hook boom') },
      }),
    ).not.toThrow()
    // All 3 chunks (600 / 256 → ceil = 3) still landed -- the throwing hook
    // degraded progress reporting only, not the write itself.
    expect(written.join('')).toBe('r'.repeat(600))
    expect(written).toHaveLength(3)
  })
})
