import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeCapture } from '../../../src/main/logging/log-capture'
import type { CaptureSupervisor } from '../../../src/main/logging/log-capture'

// ---------------------------------------------------------------------------
// Minimal fake supervisor
// ---------------------------------------------------------------------------

function makeFakeSup() {
  const posted: unknown[] = []
  const started: unknown[] = []
  const ended: unknown[] = []
  const sup: CaptureSupervisor = {
    postBatch: (b) => posted.push(b),
    startSession: (meta) => started.push(meta),
    endSession: (sessionId, ts, status) => ended.push({ sessionId, ts, status }),
  }
  return { sup, posted, started, ended }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('makeCapture / LogCapture', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // --- The plan's acceptance test (verbatim) ---
  it('coalesces a tick into one batch and respects the cap', () => {
    const posted: unknown[] = []
    const sup = {
      postBatch: (b: unknown) => posted.push(b),
      startSession() {},
      endSession() {},
    }
    const cap = makeCapture(sup, { capBytes: 4, flushMs: 250, now: () => 1 })
    cap.start('s1', { configLabel: 'A', provider: 'claude' })
    cap.record('s1', Buffer.from('ab'))   // 2 bytes, fits
    cap.record('s1', Buffer.from('cdef')) // +4 = 6 > cap 4 -> this chunk dropped
    cap.flushNow()
    expect(posted.length).toBe(1)
    expect((posted[0] as { sessions: { dropped?: number }[] }).sessions[0].dropped).toBeGreaterThan(0)
  })

  // --- start() forwards to sup.startSession ---
  it('start() calls sup.startSession with sessionId + meta + startedAt from now()', () => {
    const { sup, started } = makeFakeSup()
    const cap = makeCapture(sup, { now: () => 42 })
    cap.start('sess-a', { configLabel: 'MyConfig', provider: 'claude', accountEmail: 'x@y.com' })
    expect(started).toHaveLength(1)
    const meta = started[0] as Record<string, unknown>
    expect(meta.sessionId).toBe('sess-a')
    expect(meta.configLabel).toBe('MyConfig')
    expect(meta.provider).toBe('claude')
    expect(meta.accountEmail).toBe('x@y.com')
    expect(meta.startedAt).toBe(42)
    cap.stop()
  })

  // --- empty flushNow posts nothing ---
  it('flushNow with no pending data calls postBatch zero times', () => {
    const { sup, posted } = makeFakeSup()
    const cap = makeCapture(sup)
    cap.flushNow()
    expect(posted).toHaveLength(0)
    cap.stop()
  })

  // --- single session, single flushNow produces one batch with the chunks ---
  it('record() then flushNow() produces one batch with the recorded chunk', () => {
    const { sup, posted } = makeFakeSup()
    const cap = makeCapture(sup, { now: () => 100 })
    cap.start('s1', { configLabel: 'C', provider: 'claude' })
    cap.record('s1', Buffer.from('hello'))
    cap.flushNow()
    expect(posted).toHaveLength(1)
    const batch = posted[0] as { sessions: { sessionId: string; chunks: { ts: number; type: string; raw: Uint8Array }[] }[] }
    expect(batch.sessions).toHaveLength(1)
    expect(batch.sessions[0].sessionId).toBe('s1')
    expect(batch.sessions[0].chunks).toHaveLength(1)
    expect(batch.sessions[0].chunks[0].ts).toBe(100)
    expect(batch.sessions[0].chunks[0].type).toBe('data')
    cap.stop()
  })

  // --- multi-session single batch ---
  it('records on two sessions then flushNow() produces ONE batch with two sessions entries', () => {
    const { sup, posted } = makeFakeSup()
    const cap = makeCapture(sup, { now: () => 1 })
    cap.start('s1', { configLabel: 'A', provider: 'claude' })
    cap.start('s2', { configLabel: 'B', provider: 'claude' })
    cap.record('s1', Buffer.from('aaa'))
    cap.record('s2', Buffer.from('bbb'))
    cap.flushNow()
    // ONE call to postBatch, not two
    expect(posted).toHaveLength(1)
    const batch = posted[0] as { sessions: { sessionId: string }[] }
    const ids = batch.sessions.map((s) => s.sessionId)
    expect(ids).toContain('s1')
    expect(ids).toContain('s2')
    expect(batch.sessions).toHaveLength(2)
    cap.stop()
  })

  // --- zero-copy: chunk.raw bytes are the right bytes ---
  it('zero-copy: chunk.raw carries the bytes passed to record() (string)', () => {
    const { sup, posted } = makeFakeSup()
    const cap = makeCapture(sup, { now: () => 1 })
    cap.start('s1', { configLabel: 'C', provider: 'claude' })
    cap.record('s1', 'hello')
    cap.flushNow()
    const batch = posted[0] as { sessions: { chunks: { raw: Uint8Array }[] }[] }
    const raw = batch.sessions[0].chunks[0].raw
    expect(Buffer.from(raw).toString('utf8')).toBe('hello')
    cap.stop()
  })

  it('zero-copy: chunk.raw carries the bytes passed to record() (Buffer)', () => {
    const { sup, posted } = makeFakeSup()
    const cap = makeCapture(sup, { now: () => 1 })
    cap.start('s1', { configLabel: 'C', provider: 'claude' })
    const buf = Buffer.from([0x01, 0x02, 0x03])
    cap.record('s1', buf)
    cap.flushNow()
    const batch = posted[0] as { sessions: { chunks: { raw: Uint8Array }[] }[] }
    const raw = batch.sessions[0].chunks[0].raw
    expect(Array.from(raw)).toEqual([0x01, 0x02, 0x03])
    cap.stop()
  })

  it('zero-copy: chunk.raw carries the bytes passed to record() (Uint8Array)', () => {
    const { sup, posted } = makeFakeSup()
    const cap = makeCapture(sup, { now: () => 1 })
    cap.start('s1', { configLabel: 'C', provider: 'claude' })
    const arr = new Uint8Array([0xaa, 0xbb])
    cap.record('s1', arr)
    cap.flushNow()
    const batch = posted[0] as { sessions: { chunks: { raw: Uint8Array }[] }[] }
    const raw = batch.sessions[0].chunks[0].raw
    expect(Array.from(raw)).toEqual([0xaa, 0xbb])
    cap.stop()
  })

  // --- pending buffers are cleared after flushNow so a second flushNow is empty ---
  it('flushNow clears pending buffers; a second flushNow posts nothing', () => {
    const { sup, posted } = makeFakeSup()
    const cap = makeCapture(sup, { now: () => 1 })
    cap.start('s1', { configLabel: 'C', provider: 'claude' })
    cap.record('s1', Buffer.from('x'))
    cap.flushNow()
    cap.flushNow()
    expect(posted).toHaveLength(1)
    cap.stop()
  })

  // --- end() flushes then calls endSession ---
  it('end() flushes pending chunks then calls sup.endSession', () => {
    const { sup, posted, ended } = makeFakeSup()
    const cap = makeCapture(sup, { now: () => 99 })
    cap.start('s1', { configLabel: 'C', provider: 'claude' })
    cap.record('s1', Buffer.from('data'))
    cap.end('s1', 'done')
    // flush happened: one batch with the pending chunk
    expect(posted).toHaveLength(1)
    const batch = posted[0] as { sessions: { sessionId: string }[] }
    expect(batch.sessions[0].sessionId).toBe('s1')
    // endSession was called
    expect(ended).toHaveLength(1)
    const e = ended[0] as { sessionId: string; ts: number; status: string }
    expect(e.sessionId).toBe('s1')
    expect(e.ts).toBe(99)
    expect(e.status).toBe('done')
    cap.stop()
  })

  it('end() with no pending data still calls endSession (no empty batch posted)', () => {
    const { sup, posted, ended } = makeFakeSup()
    const cap = makeCapture(sup, { now: () => 1 })
    cap.start('s1', { configLabel: 'C', provider: 'claude' })
    // no record
    cap.end('s1', 'clean')
    expect(posted).toHaveLength(0)   // nothing pending -> no batch
    expect(ended).toHaveLength(1)
    cap.stop()
  })

  it('end() removes the session state; a subsequent flushNow does not include it', () => {
    const { sup, posted } = makeFakeSup()
    const cap = makeCapture(sup, { now: () => 1 })
    cap.start('s1', { configLabel: 'C', provider: 'claude' })
    cap.record('s1', Buffer.from('x'))
    cap.end('s1', 'done')   // flush + end + remove state
    posted.length = 0       // clear
    cap.flushNow()
    expect(posted).toHaveLength(0)
    cap.stop()
  })

  // --- size-trigger flush (64 KB) ---
  it('record() triggers an immediate flush when global pending bytes >= 64 KB', () => {
    const { sup, posted } = makeFakeSup()
    // capBytes large so cap is not hit, only size-trigger
    const cap = makeCapture(sup, { capBytes: 128 * 1024, now: () => 1 })
    cap.start('s1', { configLabel: 'C', provider: 'claude' })
    // 64 * 1024 bytes in one record should trigger the flush immediately
    const big = Buffer.alloc(64 * 1024)
    cap.record('s1', big)
    // flush was triggered synchronously inside record()
    expect(posted).toHaveLength(1)
    cap.stop()
  })

  // --- cap: global drop-newest, dropped accumulates on the session ---
  it('cap drop-newest: dropped bytes accumulate on the session and ride the batch', () => {
    const { sup, posted } = makeFakeSup()
    // cap = 5 bytes
    const cap = makeCapture(sup, { capBytes: 5, now: () => 1 })
    cap.start('s1', { configLabel: 'C', provider: 'claude' })
    cap.record('s1', Buffer.from('abc'))   // 3 bytes, fits (pending=3)
    cap.record('s1', Buffer.from('defg'))  // 4 bytes, 3+4=7 > 5: dropped
    cap.flushNow()
    expect(posted).toHaveLength(1)
    const batch = posted[0] as { sessions: { dropped?: number; chunks: unknown[] }[] }
    expect(batch.sessions[0].dropped).toBeGreaterThan(0)
    // only the first chunk survived
    expect(batch.sessions[0].chunks).toHaveLength(1)
    cap.stop()
  })

  it('cap is global across sessions: filling s1 drops new chunks on s2', () => {
    const { sup, posted } = makeFakeSup()
    // cap = 6 bytes
    const cap = makeCapture(sup, { capBytes: 6, now: () => 1 })
    cap.start('s1', { configLabel: 'A', provider: 'claude' })
    cap.start('s2', { configLabel: 'B', provider: 'claude' })
    cap.record('s1', Buffer.from('abcdef')) // 6 bytes, exactly fills
    cap.record('s2', Buffer.from('x'))      // +1 = 7 > 6: dropped on s2
    cap.flushNow()
    const batch = posted[0] as { sessions: { sessionId: string; dropped?: number }[] }
    const s2 = batch.sessions.find((s) => s.sessionId === 's2')
    expect(s2).toBeDefined()
    expect(s2!.dropped).toBeGreaterThan(0)
    cap.stop()
  })

  // --- dropped counter resets after each flush ---
  it('dropped counter resets after a flush (no carry-over to next batch)', () => {
    const { sup, posted } = makeFakeSup()
    const cap = makeCapture(sup, { capBytes: 3, now: () => 1 })
    cap.start('s1', { configLabel: 'C', provider: 'claude' })
    cap.record('s1', Buffer.from('ab'))   // 2 fits
    cap.record('s1', Buffer.from('cdef'))  // 4 > 3-2=1 remaining: dropped
    cap.flushNow()   // batch 1 has dropped > 0 and pending byte counter reset

    // Now record more within a fresh cap
    cap.record('s1', Buffer.from('z'))   // fits (pending=1)
    cap.flushNow()   // batch 2: dropped should be 0 (or absent)
    expect(posted).toHaveLength(2)
    const batch2 = posted[1] as { sessions: { dropped?: number }[] }
    // dropped should be 0 or undefined after reset
    expect(batch2.sessions[0].dropped ?? 0).toBe(0)
    cap.stop()
  })

  // --- 100% dropped: session with dropped > 0 and zero surviving chunks ---
  it('flushNow includes a session entry when ALL chunks were dropped (dropped > 0, chunks: [])', () => {
    const { sup, posted } = makeFakeSup()
    // cap = 2 bytes so every record() of 3+ bytes overflows immediately.
    // First record (3 bytes): globalPendingBytes(0) + 3 > 2 -> dropped.
    // Second record (4 bytes): still dropped.
    const cap = makeCapture(sup, { capBytes: 2, now: () => 1 })
    cap.start('s1', { configLabel: 'C', provider: 'claude' })
    cap.record('s1', Buffer.from('abc'))   // 3 bytes > cap 2: dropped
    cap.record('s1', Buffer.from('defg'))  // 4 bytes > cap 2: dropped
    cap.flushNow()
    // A batch must still be posted so the worker knows bytes were lost.
    expect(posted).toHaveLength(1)
    const batch = posted[0] as { sessions: { sessionId: string; dropped?: number; chunks: unknown[] }[] }
    expect(batch.sessions).toHaveLength(1)
    expect(batch.sessions[0].sessionId).toBe('s1')
    expect(batch.sessions[0].dropped).toBeGreaterThan(0)
    // No surviving chunks — the session entry must still carry chunks: [].
    expect(batch.sessions[0].chunks).toHaveLength(0)
    cap.stop()
  })

  // --- timer-driven flush ---
  it('timer fires every flushMs and calls flushNow when pending', () => {
    vi.useFakeTimers()
    const { sup, posted } = makeFakeSup()
    const cap = makeCapture(sup, { flushMs: 250, now: () => 1 })
    cap.start('s1', { configLabel: 'C', provider: 'claude' })
    cap.record('s1', Buffer.from('x'))
    expect(posted).toHaveLength(0)
    vi.advanceTimersByTime(250)
    expect(posted).toHaveLength(1)
    cap.stop()
  })

  it('stop() clears the flush timer so it does not fire after shutdown', () => {
    vi.useFakeTimers()
    const { sup, posted } = makeFakeSup()
    const cap = makeCapture(sup, { flushMs: 250, now: () => 1 })
    cap.start('s1', { configLabel: 'C', provider: 'claude' })
    cap.record('s1', Buffer.from('x'))
    cap.stop()
    vi.advanceTimersByTime(1000)
    // timer was cleared, so no additional flush happens after stop()
    // (the stop()-time flush is the only postBatch call)
    expect(posted).toHaveLength(1)
  })

  // --- stop() flushes pending data before clearing the timer ---
  it('stop() flushes buffered data before clearing the timer (no data loss on quit)', () => {
    // Use real timers so the periodic interval never fires — only stop() can flush.
    vi.useRealTimers()
    const { sup, posted } = makeFakeSup()
    // Large flushMs so the interval does not auto-fire during the test.
    const cap = makeCapture(sup, { flushMs: 60_000, now: () => 1 })
    cap.start('s1', { configLabel: 'C', provider: 'claude' })
    // Record below the 64 KB size-trigger so no auto-flush happens.
    cap.record('s1', Buffer.from('buffered-on-quit'))
    // No flush yet — only the periodic timer would fire (far future).
    expect(posted).toHaveLength(0)
    // stop() must flush first, then clear the timer.
    cap.stop()
    expect(posted).toHaveLength(1)
    const batch = posted[0] as { sessions: { sessionId: string; chunks: { raw: Uint8Array }[] }[] }
    expect(batch.sessions[0].sessionId).toBe('s1')
    expect(Buffer.from(batch.sessions[0].chunks[0].raw).toString('utf8')).toBe('buffered-on-quit')
  })

  // --- guard: record on inactive session buffers nothing ---
  it('record() before start() does not throw and buffers nothing (ghost-session guard)', () => {
    const { sup, posted } = makeFakeSup()
    const cap = makeCapture(sup, { now: () => 1 })
    // No start() call — session is inactive.
    expect(() => cap.record('unknown', Buffer.from('x'))).not.toThrow()
    cap.flushNow()
    // No ghost session entry in the batch.
    expect(posted).toHaveLength(0)
    cap.stop()
  })

  it('record() after end() buffers nothing (late-chunk guard)', () => {
    const { sup, posted } = makeFakeSup()
    const cap = makeCapture(sup, { now: () => 1 })
    cap.start('s1', { configLabel: 'C', provider: 'claude' })
    cap.end('s1', 'done')
    posted.length = 0   // clear the flush that end() triggered
    // Session is now inactive — record() must drop silently.
    cap.record('s1', Buffer.from('late'))
    cap.flushNow()
    expect(posted).toHaveLength(0)
    cap.stop()
  })

  // --- second flushNow after end does not include the ended session ---
  it('postBatch for s1 and s2; ending s1 removes it from subsequent flushes', () => {
    const { sup, posted } = makeFakeSup()
    const cap = makeCapture(sup, { now: () => 1 })
    cap.start('s1', { configLabel: 'A', provider: 'claude' })
    cap.start('s2', { configLabel: 'B', provider: 'claude' })
    cap.record('s1', Buffer.from('aaa'))
    cap.record('s2', Buffer.from('bbb'))
    cap.end('s1', 'done')   // flushes s1; removes s1 state
    posted.length = 0

    cap.record('s2', Buffer.from('ccc'))
    cap.flushNow()
    const batch = posted[0] as { sessions: { sessionId: string }[] }
    const ids = batch.sessions.map((s) => s.sessionId)
    expect(ids).not.toContain('s1')
    expect(ids).toContain('s2')
    cap.stop()
  })
})
