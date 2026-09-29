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
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'
import { watchAndClaimRollout, countRolloutRange, CLAIM_HEAD_BYTES, CLAIM_TAIL_BYTES } from '../../../../src/main/providers/codex/telemetry'
import { codexFolderIdentity } from '../../../../src/main/providers/codex/rollout-lookup'
import { conversationRunningTime, noteConversationRunningTime, __resetConversationRunningTimesForTests } from '../../../../src/main/conversation-running-time'
import type { StatuslineData } from '../../../../src/shared/types'

const ID = '019dd000-0001-7000-8000-0000000000d1'
const temps: string[] = []
beforeEach(() => { __resetConversationRunningTimesForTests() })
afterEach(() => {
  vi.useRealTimers()
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
    expect(conversationRunningTime(ID)).toEqual({ ms: 10_500, until: t0 + 10_500 })
    // The watch ends with the process: the time is settled at that moment.
    await vi.advanceTimersByTimeAsync(4_000)
    src.stop()
    expect(conversationRunningTime(ID)).toEqual({ ms: 14_500, until: t0 + 14_500 })
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
    expect(conversationRunningTime(ID)).toEqual({ ms: releasedAt - claimedAt, until: releasedAt })
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
    const got = await countRolloutRange(file, `${st.dev}:${st.ino}`, 0, text.length, () => false, {}, { from, to })
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
    expect(await countRolloutRange(file, `${st.dev}:${st.ino}`, 0, text.length, () => false, {}, { from, to: from + 100_000 })).toEqual({ added: 0, removed: 0, turnMs: 0 })
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
