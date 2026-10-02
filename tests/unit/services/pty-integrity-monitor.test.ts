import { describe, it, expect, vi } from 'vitest'
import { PtyIntegrityMonitor, ENDED_SESSIONS_MAX } from '../../../src/main/services/pty-integrity-monitor'
import type { PtyIntegrityReport } from '../../../src/shared/service-health'

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

// P3.16a (N8): each report names the renderer mount its counts are from
// (TerminalView makes a new generation each time its terminal effect starts,
// and counts the bytes it receives from 0). A Restart pressed from the partner
// view kills only the partner PTY and re-keys the MAIN view: the main view's
// count starts again from 0 while main's PTY runs on, with no respawn.
describe('PtyIntegrityMonitor: a new renderer mount restarts the count (N8)', () => {
  const S = 'clmain000000000000000001'
  const rep = (m: PtyIntegrityMonitor, generation: unknown, bytesReceived: unknown): void =>
    m.recordRendererReport({
      sessionId: S, bytesReceived, bytesWritten: 0, strippedBytes: 0, cols: 120, rows: 30, resizeCount: 0, generation,
    } as unknown as PtyIntegrityReport)
  const row = (m: PtyIntegrityMonitor) => m.snapshot().sessions.find((s) => s.sessionId === S)!
  const gapLogs = (m: PtyIntegrityMonitor) => m.diagnostics().logs.filter((l) => l.code === 'pty-byte-gap')

  it('B-M5-1: a re-key without a respawn (a partner view Restart) shows no gap and is not flagged, quietly', () => {
    const { m } = makeMonitor({ eventCap: 100 })
    m.recordPtyData(S, 10_000); rep(m, 'mountA', 10_000)
    expect(row(m).byteGap).toBe(0)
    // The main view remounts (its count from 0); main's PTY runs on.
    m.recordPtyData(S, 500); rep(m, 'mountB', 500)
    expect(row(m).byteGap).toBe(0)
    expect(row(m).bytesFromPty).toBe(500)
    expect(m.snapshot().recentEvents).toEqual([])
    expect(m.diagnostics().logs).toEqual([])
    // The new mount's later reports are compared from there.
    m.recordPtyData(S, 300); rep(m, 'mountB', 800)
    expect(row(m).byteGap).toBe(0)
  })

  it('a real gap within one mount still shows and is flagged, after a new mount too', () => {
    const { m } = makeMonitor({ eventCap: 100 })
    m.recordPtyData(S, 10_000); rep(m, 'mountA', 10_000)
    m.recordPtyData(S, 500); rep(m, 'mountB', 500)
    m.recordPtyData(S, 10_000); rep(m, 'mountB', 2_500)
    expect(row(m).byteGap).toBe(8_000)
    expect(m.snapshot().recentEvents.filter((e) => e.kind === 'byte-gap')).toHaveLength(1)
    expect(gapLogs(m)).toHaveLength(1)
  })

  it('a late report of the previous mount, after the new mount\'s first report, is ignored (round 2, Q5): no gap, and the new mount goes on from there', () => {
    const { m } = makeMonitor({ eventCap: 100 })
    m.recordPtyData(S, 10_000); rep(m, 'mountA', 10_000)
    m.recordPtyData(S, 500); rep(m, 'mountB', 500)
    // A late report of mount A: a mount that was replaced counts no more.
    rep(m, 'mountA', 10_200)
    expect(row(m).bytesReceived).toBe(500)
    expect(row(m).byteGap).toBe(0)
    m.recordPtyData(S, 200); rep(m, 'mountB', 700)
    expect(row(m).byteGap).toBe(0)
    expect(m.snapshot().recentEvents).toEqual([])
    expect(gapLogs(m)).toEqual([])
    // A real gap of the live mount after that still shows.
    m.recordPtyData(S, 9_000); rep(m, 'mountB', 900)
    expect(row(m).byteGap).toBe(8_800)
    expect(gapLogs(m)).toHaveLength(1)
  })

  it('round 2 (Q5): reports of a replaced mount that keep coming do not re-base the count, so the live mount\'s real gap still shows', () => {
    const { m } = makeMonitor({ eventCap: 100 })
    m.recordPtyData(S, 10_000); rep(m, 'mountA', 10_000)
    m.recordPtyData(S, 500); rep(m, 'mountB', 500)
    // Mount B misses 8,600 bytes while mount A's reports keep arriving between B's.
    m.recordPtyData(S, 9_000)
    rep(m, 'mountA', 19_000)
    rep(m, 'mountB', 900)
    rep(m, 'mountA', 19_000)
    expect(row(m).bytesFromPty).toBe(9_500)
    expect(row(m).byteGap).toBe(8_600)
    expect(gapLogs(m)).toHaveLength(1)
    // A reset (a respawn) keeps them replaced: mount A's late report still counts no more.
    m.resetSession(S)
    rep(m, 'mountA', 19_000)
    expect(row(m)).toMatchObject({ bytesReceived: 0, bytesFromPty: 0 })
  })

  it('round 2 (Q5): the replaced mounts a record keeps are bounded; the newest are kept', () => {
    const { m } = makeMonitor({ eventCap: 100 })
    for (let i = 0; i < 40; i++) { m.recordPtyData(S, 10); rep(m, `mount${i}`, 10) }
    // The one just replaced is still known as replaced.
    rep(m, 'mount38', 99_999)
    expect(row(m).bytesReceived).toBe(10)
    // The oldest is forgotten: its report is a mount again (compared from itself, no gap).
    rep(m, 'mount0', 5)
    expect(row(m).bytesReceived).toBe(5)
    expect(row(m).byteGap).toBe(0)
  })

  it('a quiet reset (a respawn) zeroes the counts and the mount with no event and no log; the session\'s end still logs one', () => {
    const { m } = makeMonitor({ eventCap: 100 })
    m.recordPtyData(S, 10_000); rep(m, 'mountA', 1_000)
    expect(gapLogs(m)).toHaveLength(1)
    const eventsBefore = m.snapshot().recentEvents.length
    m.resetSession(S)
    expect(m.snapshot().recentEvents).toHaveLength(eventsBefore)
    expect(m.snapshot().recentEvents.some((e) => e.kind === 'end')).toBe(false)
    expect(m.diagnostics().logs).toHaveLength(1)
    expect(row(m)).toMatchObject({ bytesFromPty: 0, bytesReceived: 0, byteGap: 0, chunksFromPty: 0 })
    // The next process and the next mount start from 0 together: the mount's
    // first report is compared as it is (the reset left no mount to restart
    // from), so a gap in it shows and is flagged again.
    m.recordPtyData(S, 10_000); rep(m, 'mountB', 2_000)
    expect(row(m).byteGap).toBe(8_000)
    expect(gapLogs(m)).toHaveLength(2)
    m.endSession(S)
    expect(m.snapshot().recentEvents.filter((e) => e.kind === 'end')).toHaveLength(1)
    expect(m.snapshot().sessions).toEqual([])
  })

  it('a reset of a session with no record makes none', () => {
    const { m } = makeMonitor()
    m.resetSession(S)
    expect(m.snapshot().sessions).toEqual([])
    expect(m.snapshot().recentEvents).toEqual([])
  })

  it('reports without a generation count as they did: no restart of the count', () => {
    const { m } = makeMonitor({ eventCap: 100 })
    m.recordPtyData(S, 10_000); rep(m, undefined, 10_000)
    m.recordPtyData(S, 500); rep(m, undefined, 500)
    expect(row(m).byteGap).toBe(10_000)
    expect(gapLogs(m)).toHaveLength(1)
  })

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a number', 7],
    ['an object', { id: 'mountB' }],
    ['an array', ['mountB']],
    ['an empty string', ''],
    ['a string past the bound', 'b'.repeat(65)],
    ['a huge string', 'b'.repeat(1_000_000)],
    ['a string with other characters', 'mount B/..'],
  ])('a generation that is %s is ignored: the report counts against the mount main has', (_label, bad) => {
    const { m } = makeMonitor({ eventCap: 100 })
    m.recordPtyData(S, 10_000); rep(m, 'mountA', 10_000)
    m.recordPtyData(S, 10_000); rep(m, bad, 12_000)
    expect(row(m).byteGap).toBe(8_000)
    expect(gapLogs(m)).toHaveLength(1)
    // It did not become the mount either: mount A's next report is no new mount.
    rep(m, 'mountA', 12_000)
    expect(row(m).byteGap).toBe(8_000)
  })

  it('a generation at the bound is a new mount', () => {
    const { m } = makeMonitor({ eventCap: 100 })
    m.recordPtyData(S, 10_000); rep(m, 'mountA', 10_000)
    m.recordPtyData(S, 500); rep(m, 'b'.repeat(64), 500)
    expect(row(m).byteGap).toBe(0)
  })

  it.each([
    ['a string', '500'],
    ['negative', -1],
    ['fractional', 0.5],
    ['not finite', Infinity],
    ['NaN', NaN],
    ['past the safe range', 2 ** 53],
  ])('a new mount whose count is %s does not set main\'s count from it, and is not taken as the mount', (_label, bad) => {
    const { m } = makeMonitor({ eventCap: 100 })
    m.recordPtyData(S, 10_000); rep(m, 'mountA', 10_000)
    m.recordPtyData(S, 500); rep(m, 'mountB', bad)
    expect(row(m).bytesFromPty).toBe(10_500)
    // Its next valid report is the new mount.
    rep(m, 'mountB', 500)
    expect(row(m).bytesFromPty).toBe(500)
    expect(row(m).byteGap).toBe(0)
  })
})

// P3.16 final-head VM finding D3: the renderer reports about 1 s after a
// terminal's last bytes, and a resize of its view is recorded with or without
// a PTY, so both reach main after the session's end for a tab left open. They
// made a new record (main's count 0, the renderer's N: "gap -N"), and the
// close then logged a second end. An ended session's late reports and resizes
// are ignored until its next process's first output.
describe('PtyIntegrityMonitor: an ended session is not listed again by a late report or resize (P3.16 final-head VM finding D3)', () => {
  const S = 'clended00000000000000001'
  const rep = (m: PtyIntegrityMonitor, generation: string, bytesReceived: number, sessionId = S): void =>
    m.recordRendererReport({
      sessionId, bytesReceived, bytesWritten: 0, strippedBytes: 0, cols: 100, rows: 30, resizeCount: 0, generation,
    } as unknown as PtyIntegrityReport)
  const row = (m: PtyIntegrityMonitor, id = S) => m.snapshot().sessions.find((s) => s.sessionId === id)
  const kinds = (m: PtyIntegrityMonitor) => m.snapshot().recentEvents.filter((e) => e.sessionId === S).map((e) => e.kind)

  it('a late report and a resize after the end make no row and no event; a close then logs no second end', () => {
    const { m } = makeMonitor({ eventCap: 100 })
    m.recordPtyData(S, 6_553); rep(m, 'mountA', 6_553)
    m.endSession(S)
    rep(m, 'mountA', 6_553)
    m.recordResizeApplied(S, 100, 30)
    expect(m.snapshot().sessions).toEqual([])
    expect(kinds(m)).toEqual(['end'])
    m.endSession(S)
    expect(kinds(m)).toEqual(['end'])
    expect(m.diagnostics().logs).toEqual([])
  })

  it('the next process\'s first output lists the session again, counted from 0; its reports and resizes count again', () => {
    const { m } = makeMonitor({ eventCap: 100 })
    m.recordPtyData(S, 6_553); rep(m, 'mountA', 6_553)
    m.endSession(S)
    rep(m, 'mountA', 6_553)
    m.recordPtyData(S, 40); rep(m, 'mountB', 40)
    expect(row(m)).toMatchObject({ bytesFromPty: 40, bytesReceived: 40, byteGap: 0 })
    m.recordResizeApplied(S, 100, 30)
    expect(row(m)).toMatchObject({ resizeCount: 1, appliedCols: 100 })
    expect(kinds(m)).toEqual(['end', 'resize'])
    // Its own end is the session's end again: one more event.
    m.endSession(S)
    expect(kinds(m)).toEqual(['end', 'resize', 'end'])
  })

  it('another session is not affected by one that ended', () => {
    const { m } = makeMonitor({ eventCap: 100 })
    m.endSession(S)
    rep(m, 'mountX', 10, 'clother00000000000000001')
    expect(row(m, 'clother00000000000000001')).toMatchObject({ bytesReceived: 10 })
  })

  it('the ended sessions it keeps are bounded (ENDED_SESSIONS_MAX, the oldest dropped first); a dropped one\'s late report makes a row again', () => {
    const { m } = makeMonitor({ eventCap: 10 })
    expect(ENDED_SESSIONS_MAX).toBe(256)
    for (let i = 0; i <= ENDED_SESSIONS_MAX; i++) m.endSession(`ended-${i}`)
    rep(m, 'mountA', 5, 'ended-0')
    expect(row(m, 'ended-0')).toMatchObject({ bytesReceived: 5 })
    rep(m, 'mountA', 5, 'ended-1')
    expect(row(m, 'ended-1')).toBeUndefined()
    rep(m, 'mountA', 5, `ended-${ENDED_SESSIONS_MAX}`)
    expect(row(m, `ended-${ENDED_SESSIONS_MAX}`)).toBeUndefined()
  })

  it('a session that ends again is kept as the newest ended one', () => {
    const { m } = makeMonitor({ eventCap: 10 })
    for (let i = 0; i < ENDED_SESSIONS_MAX; i++) m.endSession(`ended-${i}`)
    m.endSession('ended-0')
    m.endSession('ended-new')
    rep(m, 'mountA', 5, 'ended-0')
    expect(row(m, 'ended-0')).toBeUndefined()
    rep(m, 'mountA', 5, 'ended-1')
    expect(row(m, 'ended-1')).toMatchObject({ bytesReceived: 5 })
  })
})
