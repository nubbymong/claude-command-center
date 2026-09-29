// P3.7 (row 36): a Codex session's Duration is its conversation's running
// time, as Claude Code's is: the wall-clock time the conversation has been
// running, idle included, carried on across runs (Claude's CLI restores it
// from the transcript when it resumes). Codex's rollout does not tell its
// runs apart (P3.1: a resume adds no session_meta, and the only mark seen,
// thread_settings_applied, was seen only on `codex exec resume`), so main
// keeps each conversation's running time (conversation-running-time.ts), and
// for time the app did not see it takes what the rollout proves: the turns
// it records as completed then. Real files in a temp folder; fake timers.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync, promises as fsPromises } from 'fs'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'
import { watchAndClaimRollout, countRolloutRange, CLAIM_HEAD_BYTES, CLAIM_TAIL_BYTES, __codexEditCountBytesReadForTests, __codexCountsSettledForTests, EDIT_COUNT_MAX_MS } from '../../../../src/main/providers/codex/telemetry'
import { codexFolderIdentity } from '../../../../src/main/providers/codex/rollout-lookup'
import { conversationRunningTime, noteConversationRunningTime, __resetConversationRunningTimesForTests } from '../../../../src/main/conversation-running-time'
import type { StatuslineData } from '../../../../src/shared/types'

const ID = '019dd000-0001-7000-8000-0000000000d1'
const temps: string[] = []
beforeEach(() => { __resetConversationRunningTimesForTests() })
afterEach(async () => {
  vi.useRealTimers()
  // Every background count has let go of its rollout before its folder is removed (CI at 427807fb).
  await __codexCountsSettledForTests()
  vi.restoreAllMocks()
  // Only a folder this file made (its own prefix, directly in the temp folder) is removed.
  for (const t of temps.splice(0)) if (dirname(t) === tmpdir() && /^ccc-test-codex-duration-/.test(basename(t))) rmSync(t, { recursive: true, force: true })
})

const pad = (n: number) => String(n).padStart(2, '0')
function realm(): string {
  const base = mkdtempSync(join(tmpdir(), 'ccc-test-codex-duration-'))
  temps.push(base)
  return join(base, 'sessions')
}
function dayOf(sessions: string, d: Date): string {
  const dir = join(sessions, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()))
  mkdirSync(dir, { recursive: true })
  return dir
}
const iso = (t: number) => new Date(t).toISOString()
const metaLine = (id: string, cwd: string, t: number) => JSON.stringify({ timestamp: iso(t), type: 'session_meta', payload: { id, timestamp: iso(t), cwd, cli_version: '0.155.1' } })
const tokenLine = (t: number, input: number) => JSON.stringify({ timestamp: iso(t), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: input + 1 } }, rate_limits: null } })
/** A turn Codex completed at `t` after `ms` of work (the shape both versions record). */
const doneLine = (t: number, ms: number) => JSON.stringify({ timestamp: iso(t), type: 'event_msg', payload: { type: 'task_complete', turn_id: 't', last_agent_message: 'ok', started_at: Math.floor((t - ms) / 1000), completed_at: Math.floor(t / 1000), duration_ms: ms } })
const filler = (bytes: number) => {
  const line = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(900) }] } })
  return Array.from({ length: Math.ceil(bytes / (line.length + 1)) }, () => line).join('\n') + '\n'
}
function rolloutAt(sessions: string, id: string, t: number, lines: string[]): string {
  const file = join(dayOf(sessions, new Date(t)), `rollout-${iso(t).slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`)
  writeFileSync(file, lines.join('\n') + '\n')
  return file
}
function watch(sessions: string, cwd: string, opts?: Parameters<typeof watchAndClaimRollout>[6], spawn = Date.now()) {
  const updates: StatuslineData[] = []
  const src = watchAndClaimRollout('sess-duration', cwd, spawn, (d) => updates.push(d), sessions, undefined, opts)
  return { updates, src }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
/** Holds the given calls to fs.promises.open (counted from 0) until let go. */
function holdOpens(held: number[]) {
  const realOpen = fsPromises.open
  const gates = new Map<number, () => void>()
  const waits = new Map<number, Promise<void>>()
  for (const n of held) waits.set(n, new Promise<void>((r) => { gates.set(n, r) }))
  let opens = 0
  const spy = vi.spyOn(fsPromises, 'open').mockImplementation((async (...args: Parameters<typeof fsPromises.open>) => {
    const w = waits.get(opens++)
    if (w) await w
    return realOpen.apply(fsPromises, args)
  }) as typeof fsPromises.open)
  return {
    release: (n: number) => gates.get(n)?.(),
    opens: () => opens,
    done: () => { for (const g of gates.values()) g(); spy.mockRestore() },
  }
}

describe('a Codex session\'s Duration is its conversation\'s running time', () => {
  it('a new conversation: from the launch, idle included, as Claude Code counts from its start', async () => {
    vi.useFakeTimers()
    const t0 = Date.parse('2026-09-29T10:00:00.000Z')
    vi.setSystemTime(t0)
    const sessions = realm()
    const file = rolloutAt(sessions, ID, t0, [metaLine(ID, '/p/demo', t0), tokenLine(t0, 5)])
    const { updates, src } = watch(sessions, '/p/demo')
    expect(updates.at(-1)).toMatchObject({ inputTokens: 5, totalDurationMs: 0 })
    await vi.advanceTimersByTimeAsync(10_000)
    appendFileSync(file, tokenLine(Date.now(), 9) + '\n')
    await vi.advanceTimersByTimeAsync(500)
    expect(updates.at(-1)).toMatchObject({ inputTokens: 9, totalDurationMs: 10_500 })
    expect(conversationRunningTime(ID)).toEqual({ ms: 10_500, until: t0 + 10_500, gaps: [] })
    // The watch ends with the process: the time is settled at that moment.
    await vi.advanceTimersByTimeAsync(4_000)
    src.stop()
    expect(conversationRunningTime(ID)).toEqual({ ms: 14_500, until: t0 + 14_500, gaps: [] })
  })

  it('a conversation first seen here: the turns its rollout records as completed, then this launch (the real 0.155.1 rollout)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-09-29T12:00:00.000Z'))
    const sessions = realm()
    const fixtureId = '00000000-0000-7000-8000-000000000001'
    const day = dayOf(sessions, new Date('2026-09-27T19:08:23.815Z'))
    copyFileSync(join(__dirname, '../../../fixtures/codex/cli/0.155.1/rollout-exec-then-resume.jsonl'), join(day, `rollout-2026-09-27T12-08-23-${fixtureId}.jsonl`))
    const { updates, src } = watch(sessions, 'C:\\Users\\alex\\projects\\demo', { resumeId: fixtureId })
    await vi.advanceTimersByTimeAsync(2_000)
    src.stop()
    // Its two turns: 7345 ms and 6364 ms (task_complete.duration_ms); then this launch, 0 s at the claim.
    expect(updates[0]?.totalDurationMs).toBe(7_345 + 6_364)
  })

  it('a later launch carries on from where the last one ended, and never counts a turn twice', async () => {
    vi.useFakeTimers()
    const t0 = Date.parse('2026-09-29T10:00:00.000Z')
    vi.setSystemTime(t0)
    const sessions = realm()
    const file = rolloutAt(sessions, ID, t0 - 600_000, [metaLine(ID, '/p/demo', t0 - 600_000), doneLine(t0 - 590_000, 4_000), tokenLine(t0 - 590_000, 5)])
    const first = watch(sessions, '/p/demo', { resumeId: ID })
    expect(first.updates.at(-1)?.totalDurationMs).toBe(4_000)
    await vi.advanceTimersByTimeAsync(60_000)
    appendFileSync(file, doneLine(Date.now(), 2_000) + '\n' + tokenLine(Date.now(), 9) + '\n')
    await vi.advanceTimersByTimeAsync(500)
    expect(first.updates.at(-1)?.totalDurationMs).toBe(4_000 + 60_500)
    first.src.stop()
    // Nothing runs for 100 s; then the conversation is resumed again.
    await vi.advanceTimersByTimeAsync(100_000)
    const second = watch(sessions, '/p/demo', { resumeId: ID })
    second.src.stop()
    expect(second.updates[0]?.totalDurationMs).toBe(64_500)
  })

  it('turns completed outside the app since its last run count; one begun before that run ended counts from then', async () => {
    vi.useFakeTimers()
    const t0 = Date.parse('2026-09-29T10:00:00.000Z')
    vi.setSystemTime(t0)
    const until = t0 - 60_000
    noteConversationRunningTime(ID, 50_000, until)
    const sessions = realm()
    rolloutAt(sessions, ID, t0 - 3_600_000, [
      metaLine(ID, '/p/demo', t0 - 3_600_000),
      doneLine(until - 1_000, 9_000),
      doneLine(until + 2_000, 10_000),
      doneLine(until + 30_000, 5_000),
      tokenLine(until + 30_000, 5),
    ])
    const { updates, src } = watch(sessions, '/p/demo', { resumeId: ID })
    src.stop()
    expect(updates[0]?.totalDurationMs).toBe(50_000 + 2_000 + 5_000)
  })

  it('the resume picker: from the conversation picked, not while the picker waited', async () => {
    vi.useFakeTimers()
    const t0 = Date.parse('2026-09-29T10:00:00.000Z')
    vi.setSystemTime(t0)
    const sessions = realm()
    rolloutAt(sessions, ID, t0 - 600_000, [metaLine(ID, '/p/demo', t0 - 600_000), doneLine(t0 - 590_000, 3_000), tokenLine(t0 - 590_000, 5)])
    const pickFile = join(sessions, '..', 'pick.json')
    const { updates, src } = watch(sessions, '/p/demo', { pickFile, pickFolder: codexFolderIdentity(dirname(pickFile)) ?? undefined })
    await vi.advanceTimersByTimeAsync(30_000)
    writeFileSync(pickFile, JSON.stringify({ id: ID }))
    await vi.advanceTimersByTimeAsync(300)
    src.stop()
    expect(updates[0]?.totalDurationMs).toBe(3_000)
  })

  it('a New conversation from the picker: from that choice', async () => {
    vi.useFakeTimers()
    const t0 = Date.parse('2026-09-29T10:00:00.000Z')
    vi.setSystemTime(t0)
    const sessions = realm()
    const pickFile = join(sessions, '..', 'pick.json')
    const { updates, src } = watch(sessions, '/p/demo', { pickFile, pickFolder: codexFolderIdentity(dirname(pickFile)) ?? undefined })
    await vi.advanceTimersByTimeAsync(30_000)
    writeFileSync(pickFile, JSON.stringify({ fresh: true }))
    // The choice is dated by the pick file's time: here, the test's clock.
    utimesSync(pickFile, Date.now() / 1000, Date.now() / 1000)
    await vi.advanceTimersByTimeAsync(300)
    await vi.advanceTimersByTimeAsync(20_000)
    rolloutAt(sessions, ID, Date.now(), [metaLine(ID, '/p/demo', Date.now()), tokenLine(Date.now(), 5)])
    await vi.advanceTimersByTimeAsync(300)
    src.stop()
    expect(updates[0]?.totalDurationMs).toBeGreaterThanOrEqual(20_300)
    expect(updates[0]?.totalDurationMs).toBeLessThanOrEqual(20_600)
  })

  it('a claim let go: its conversation\'s time is settled then, and the figure is cleared', async () => {
    vi.useFakeTimers()
    const t0 = Date.parse('2026-09-29T10:00:00.000Z')
    vi.setSystemTime(t0)
    const sessions = realm()
    rolloutAt(sessions, ID, t0 - 600_000, [metaLine(ID, '/p/demo', t0 - 600_000), tokenLine(t0 - 590_000, 5)])
    const pickFile = join(sessions, '..', 'pick.json')
    const { updates, src } = watch(sessions, '/p/demo', { pickFile, pickFolder: codexFolderIdentity(dirname(pickFile)) ?? undefined })
    writeFileSync(pickFile, JSON.stringify({ id: ID }))
    await vi.advanceTimersByTimeAsync(250)
    expect(updates[0]?.totalDurationMs).toBe(0)
    const claimedAt = Date.now()
    await vi.advanceTimersByTimeAsync(5_000)
    writeFileSync(pickFile, JSON.stringify({ fresh: true }))
    utimesSync(pickFile, Date.now() / 1000, Date.now() / 1000)
    // The tail's next look reads the new decision (its ticks run from the claim).
    await vi.advanceTimersByTimeAsync(500)
    const releasedAt = claimedAt + 5_500
    expect(updates.at(-1)).toMatchObject({ totalDurationMs: 0 })
    // The watch then ends later: the conversation let go is not counted on.
    await vi.advanceTimersByTimeAsync(1_000)
    src.stop()
    expect(conversationRunningTime(ID)).toEqual({ ms: releasedAt - claimedAt, until: releasedAt, gaps: [] })
  })

  // Review fix 1: another tab resumed the conversation while this one held
  // it; the time they both ran it is counted once, not from the other tab's
  // own launch. P3.10 (the P3.7 VM finding): that tab shows the
  // conversation's figures too, its Duration the same as this one's; this one
  // keeps the time, and once it lets go the other keeps it on from there.
  it('two tabs on one conversation: both show its Duration, and the time they both ran it is counted once', async () => {
    vi.useFakeTimers()
    const t0 = Date.parse('2026-09-29T10:00:00.000Z')
    vi.setSystemTime(t0)
    const sessions = realm()
    const file = rolloutAt(sessions, ID, t0 - 600_000, [metaLine(ID, '/p/demo', t0 - 600_000), tokenLine(t0 - 590_000, 5)])
    const x = watch(sessions, '/p/demo', { resumeId: ID })
    await vi.advanceTimersByTimeAsync(10_000)
    const y = watch(sessions, '/p/demo', { resumeId: ID })
    await vi.advanceTimersByTimeAsync(0)
    // Beside x: what main keeps (x's run from its launch), counted on to now.
    expect(y.updates.at(-1)?.totalDurationMs).toBe(10_000)
    expect(y.updates.at(-1)?.inputTokens).toBe(5)
    await vi.advanceTimersByTimeAsync(20_000)
    x.src.stop()
    // y kept nothing of its own meanwhile: the shared 20 s are counted once.
    expect(conversationRunningTime(ID)).toEqual({ ms: 30_000, until: t0 + 30_000, gaps: [] })
    await vi.advanceTimersByTimeAsync(250)
    appendFileSync(file, tokenLine(t0 + 30_250, 6) + '\n')
    await vi.advanceTimersByTimeAsync(500)
    // x has let go: y keeps the time on from x's end (its tail reads at
    // 30.5 s, a poll every 500 ms from its claim at 10 s).
    expect(y.updates.at(-1)?.totalDurationMs).toBe(30_500)
    y.src.stop()
    expect(conversationRunningTime(ID)?.ms).toBe(30_750)
  })

  // A large rollout's run whose background count has not landed when it
  // ends (CI at 427807fb: the count no longer reads on for it, so the
  // rollout is let go at once): its time is kept at once without the turns
  // the count had yet to confirm, and the spans holding them are kept as
  // gaps, which the next run counts.
  function largeWithTurns(sessions: string): void {
    const t = Date.now() - 3 * 24 * 3600 * 1000
    let body = metaLine(ID, '/p/demo', t) + '\n' + filler(1024 * 1024)
    for (let i = 0; i < 3; i++) body += doneLine(t + 1_000 * (i + 1), 1_000) + '\n' + filler(1024 * 1024)
    body += filler(512 * 1024) + doneLine(t + 10_000, 500) + '\n' + tokenLine(t + 10_000, 777) + '\n'
    writeFileSync(join(dayOf(sessions, new Date(t)), `rollout-x-${ID}.jsonl`), body)
  }

  it('a large rollout\'s run ending before its count lands: kept at once, the turns not yet counted kept as a gap', async () => {
    vi.useFakeTimers()
    const t0 = Date.parse('2026-09-29T10:00:00.000Z')
    vi.setSystemTime(t0)
    const sessions = realm()
    largeWithTurns(sessions)
    const h = holdOpens([0])
    try {
      const x = watch(sessions, '/p/demo', { resumeId: ID })
      // Shown with what the head and tail prove (the tail's turn).
      expect(x.updates.at(-1)?.totalDurationMs).toBe(500)
      // Kept as it goes without them, the span they are in a gap.
      expect(conversationRunningTime(ID)).toEqual({ ms: 0, until: t0, gaps: [{ from: 0, to: t0 }] })
      await vi.advanceTimersByTimeAsync(5_000)
      x.src.stop()
      expect(conversationRunningTime(ID)).toEqual({ ms: 5_000, until: t0 + 5_000, gaps: [{ from: 0, to: t0 }] })
    } finally {
      h.done()
      await __codexCountsSettledForTests()
    }
  })

  it('a background count held up past its limit gives none: the run is kept without the turns it would have found, their span a gap', async () => {
    vi.useFakeTimers()
    const t0 = Date.parse('2026-09-29T10:00:00.000Z')
    vi.setSystemTime(t0)
    const sessions = realm()
    largeWithTurns(sessions)
    const h = holdOpens([0])
    try {
      const x = watch(sessions, '/p/demo', { resumeId: ID })
      await vi.advanceTimersByTimeAsync(EDIT_COUNT_MAX_MS)
      x.src.stop()
      expect(conversationRunningTime(ID)).toEqual({ ms: EDIT_COUNT_MAX_MS, until: t0 + EDIT_COUNT_MAX_MS, gaps: [{ from: 0, to: t0 }] })
    } finally {
      h.done()
      await __codexCountsSettledForTests()
    }
  })

  it('the next run counts the turns the last one had not reached, and each run\'s own time once', async () => {
    const sessions = realm()
    largeWithTurns(sessions)
    const h = holdOpens([0])
    try {
      const xSpawn = Date.now()
      const x = watch(sessions, '/p/demo', { resumeId: ID }, xSpawn)
      await sleep(200)
      x.src.stop()
      const xKept = conversationRunningTime(ID)!
      expect(xKept.gaps).toEqual([{ from: 0, to: xSpawn }])
      h.release(0)
      await __codexCountsSettledForTests()
      const ySpawn = Date.now()
      const y = watch(sessions, '/p/demo', { resumeId: ID }, ySpawn)
      await vi.waitFor(() => expect(y.updates.at(-1)?.totalDurationMs).toBeGreaterThanOrEqual(3_500 + xKept.ms), { timeout: 5_000, interval: 20 })
      const yStop = Date.now()
      y.src.stop()
      const kept = conversationRunningTime(ID)!
      expect(kept.gaps).toEqual([])
      expect(Math.abs(kept.ms - (3_500 + xKept.ms + (yStop - ySpawn)))).toBeLessThanOrEqual(15)
    } finally {
      h.done()
      await __codexCountsSettledForTests()
    }
  })

  it('runs ending mid-count one after another: each run\'s time is kept, and the run whose count completes counts every gap once', async () => {
    const sessions = realm()
    largeWithTurns(sessions)
    const h = holdOpens([0, 1])
    try {
      const xSpawn = Date.now()
      const x = watch(sessions, '/p/demo', { resumeId: ID }, xSpawn)
      await sleep(200)
      x.src.stop()
      const xKept = conversationRunningTime(ID)!
      // Nothing runs for a moment between the two.
      await sleep(20)
      const ySpawn = Date.now()
      const y = watch(sessions, '/p/demo', { resumeId: ID }, ySpawn)
      await sleep(200)
      y.src.stop()
      const yKept = conversationRunningTime(ID)!
      expect(yKept.gaps).toEqual([{ from: 0, to: xSpawn }, { from: xKept.until, to: ySpawn }])
      expect(Math.abs(yKept.ms - (xKept.ms + (yKept.until - ySpawn)))).toBeLessThanOrEqual(2)
      h.release(0)
      h.release(1)
      await __codexCountsSettledForTests()
      const zSpawn = Date.now()
      const z = watch(sessions, '/p/demo', { resumeId: ID }, zSpawn)
      await vi.waitFor(() => expect(z.updates.at(-1)?.totalDurationMs).toBeGreaterThanOrEqual(3_500 + yKept.ms), { timeout: 5_000, interval: 20 })
      const zStop = Date.now()
      z.src.stop()
      const kept = conversationRunningTime(ID)!
      expect(kept.gaps).toEqual([])
      expect(Math.abs(kept.ms - (3_500 + yKept.ms + (zStop - zSpawn)))).toBeLessThanOrEqual(15)
    } finally {
      h.done()
      await __codexCountsSettledForTests()
    }
  })

  it('a watch ending after its background count landed: its time is kept at once, turns included', async () => {
    const sessions = realm()
    largeWithTurns(sessions)
    const x = watch(sessions, '/p/demo', { resumeId: ID })
    await vi.waitFor(() => expect(x.updates.at(-1)?.totalDurationMs).toBeGreaterThanOrEqual(3_500), { timeout: 5_000, interval: 20 })
    await sleep(50)
    const before = Date.now()
    x.src.stop()
    const kept = conversationRunningTime(ID)!
    expect(kept.until).toBeGreaterThanOrEqual(before)
    expect(kept.ms).toBeGreaterThanOrEqual(3_500)
    expect(kept.gaps).toEqual([])
  })

  it('a relaunch after the last run\'s time is kept: read once, not again', async () => {
    const sessions = realm()
    largeWithTurns(sessions)
    const x = watch(sessions, '/p/demo', { resumeId: ID })
    await vi.waitFor(() => expect(x.updates.at(-1)?.totalDurationMs).toBeGreaterThanOrEqual(3_500), { timeout: 5_000, interval: 20 })
    x.src.stop()
    const before = __codexEditCountBytesReadForTests()
    const y = watch(sessions, '/p/demo', { resumeId: ID })
    try {
      await vi.waitFor(() => expect(__codexEditCountBytesReadForTests()).toBeGreaterThan(before), { timeout: 5_000, interval: 20 })
      await sleep(900)
      // One background count of the part between the head and the tail (about 3.3 MiB), not two.
      expect(__codexEditCountBytesReadForTests() - before).toBeLessThan(5 * 1024 * 1024)
    } finally {
      y.src.stop()
    }
  })

  it('a launch dated ahead of the clock (the clock moved back): no time below nothing', async () => {
    vi.useFakeTimers()
    const t0 = Date.parse('2026-09-29T10:00:00.000Z')
    vi.setSystemTime(t0)
    const sessions = realm()
    rolloutAt(sessions, ID, t0 - 600_000, [metaLine(ID, '/p/demo', t0 - 600_000), doneLine(t0 - 590_000, 3_000), tokenLine(t0 - 590_000, 5)])
    const { updates, src } = watch(sessions, '/p/demo', { resumeId: ID }, t0 + 60_000)
    src.stop()
    expect(updates[0]?.totalDurationMs).toBe(3_000)
  })

  it('a conversation whose id is not a conversation id: no Duration, and nothing kept', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    rolloutAt(sessions, 'not-a-conversation', Date.now(), [metaLine('not-a-conversation', '/p/demo', Date.now()), tokenLine(Date.now(), 5)])
    const { updates, src } = watch(sessions, '/p/demo')
    await vi.advanceTimersByTimeAsync(300)
    src.stop()
    expect(updates.at(-1)?.inputTokens).toBe(5)
    expect(updates.at(-1)?.totalDurationMs).toBeUndefined()
  })

  it('a large rollout: the turns between its head and its tail count too, once the background count is done', async () => {
    const sessions = realm()
    const t = Date.now() - 3 * 24 * 3600 * 1000
    let body = metaLine(ID, '/p/demo', t) + '\n' + filler(1024 * 1024)
    for (let i = 0; i < 3; i++) body += doneLine(t + 1_000 * (i + 1), 1_000) + '\n' + filler(1024 * 1024)
    body += filler(512 * 1024) + doneLine(t + 10_000, 500) + '\n' + tokenLine(t + 10_000, 777) + '\n'
    writeFileSync(join(dayOf(sessions, new Date(t)), `rollout-x-${ID}.jsonl`), body)
    expect(body.length).toBeGreaterThan(CLAIM_HEAD_BYTES + CLAIM_TAIL_BYTES)
    const { updates, src } = watch(sessions, '/p/demo', { resumeId: ID })
    try {
      expect(updates[0]?.totalDurationMs).toBeGreaterThanOrEqual(500)
      expect(updates[0]?.totalDurationMs).toBeLessThan(3_500)
      await vi.waitFor(() => expect(updates.at(-1)?.totalDurationMs).toBeGreaterThanOrEqual(3_500), { timeout: 10_000, interval: 20 })
      expect(updates.at(-1)?.totalDurationMs).toBeLessThan(3_500 + 10_000)
    } finally {
      src.stop()
    }
  })
})

describe('countRolloutRange: the turns completed in a window', () => {
  it('counts each completed turn inside the window, and of one begun before it only the part inside', async () => {
    const dir = realm()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'r.jsonl')
    const from = Date.parse('2026-09-29T10:00:00.000Z')
    const to = from + 100_000
    const text = [doneLine(from - 1, 7_000), doneLine(from + 3_000, 5_000), doneLine(from + 50_000, 4_000), doneLine(to, 6_000), doneLine(to + 1, 1_000)].join('\n') + '\n'
    writeFileSync(file, text)
    const { lstatSync } = await import('fs')
    const st = lstatSync(file, { bigint: true })
    const got = await countRolloutRange(file, `${st.dev}:${st.ino}`, 0, text.length, () => false, {}, [{ from, to }])
    expect(got).toEqual({ added: 0, removed: 0, turnMs: 3_000 + 4_000 })
    // With no window, no turn is counted.
    expect(await countRolloutRange(file, `${st.dev}:${st.ino}`, 0, text.length)).toEqual({ added: 0, removed: 0, turnMs: 0 })
  })

  it('a turn record with no usable duration or time counts nothing', async () => {
    const dir = realm()
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'r.jsonl')
    const from = Date.parse('2026-09-29T10:00:00.000Z')
    const bad = (payload: Record<string, unknown>, ts: unknown = iso(from + 10)) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type: 'task_complete', ...payload } })
    // 1e400 is read as Infinity (JSON.stringify would write null).
    const text = [bad({ duration_ms: '5' }), bad({ duration_ms: -5 }), bad({ duration_ms: 12_345 }).replace('12345', '1e400'), bad({}), bad({ duration_ms: 5 }, 'not a time'), JSON.stringify({ timestamp: iso(from + 10), type: 'response_item', payload: { type: 'task_complete', duration_ms: 5 } })].join('\n') + '\n'
    writeFileSync(file, text)
    const { lstatSync } = await import('fs')
    const st = lstatSync(file, { bigint: true })
    expect(await countRolloutRange(file, `${st.dev}:${st.ino}`, 0, text.length, () => false, {}, [{ from, to: from + 100_000 }])).toEqual({ added: 0, removed: 0, turnMs: 0 })
  })
})

// The fixture's own file stays untouched.
describe('fixtures', () => {
  it('the 0.155.1 rollout records its two turns\' durations', () => {
    const text = readFileSync(join(__dirname, '../../../fixtures/codex/cli/0.155.1/rollout-exec-then-resume.jsonl'), 'utf-8')
    const ms = text.split('\n').filter((l) => l.includes('"task_complete"')).map((l) => JSON.parse(l).payload.duration_ms)
    expect(ms).toEqual([7_345, 6_364])
  })
})
