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
})
