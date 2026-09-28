// P3.5 (row 38): a Codex session's status line finds its rollout wherever it
// is. Codex appends a resumed conversation to its ORIGINAL file, in its
// original date folder (P3.1 evidence, answer 2), and names a new file in
// local time; the watcher used to look only in today's UTC folder, fixed at
// the spawn, so a resumed conversation from an earlier day, or one crossing
// midnight UTC, got no status line. Real files in a temp folder; fake timers.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { watchAndClaimRollout } from '../../../../src/main/providers/codex/telemetry'
import type { StatuslineData } from '../../../../src/shared/types'

const ID_A = '019dd000-0001-7000-8000-00000000000a'
const ID_B = '019dd000-0001-7000-8000-00000000000b'
const pad = (n: number) => String(n).padStart(2, '0')
const temps: string[] = []
const originalTz = process.env.TZ

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true })
})

function realm(): string {
  const base = mkdtempSync(join(tmpdir(), 'ccc-test-codex-claim-'))
  temps.push(base)
  return join(base, 'sessions')
}
function folder(sessions: string, y: number, m: number, d: number): string {
  const dir = join(sessions, String(y), pad(m), pad(d))
  mkdirSync(dir, { recursive: true })
  return dir
}
const metaLine = (id: string, cwd: string, iso: string) =>
  JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id, timestamp: iso, cwd, cli_version: '0.155.1' } })
const tokenLine = (iso: string, input: number) =>
  JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: input + 1 } }, rate_limits: null } })
function rollout(dir: string, id: string, cwd: string, iso: string, input?: number): string {
  const file = join(dir, `rollout-${iso.slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`)
  writeFileSync(file, [metaLine(id, cwd, iso), ...(input === undefined ? [] : [tokenLine(iso, input)])].join('\n') + '\n', 'utf-8')
  return file
}
function watch(sessions: string, cwd: string, opts?: Parameters<typeof watchAndClaimRollout>[6]) {
  const updates: StatuslineData[] = []
  const claims: Array<{ id: string; cwd: string }> = []
  const src = watchAndClaimRollout('sess-p35', cwd, Date.now(), (d) => updates.push(d), sessions, undefined,
    opts ? { ...opts, onClaim: (c) => claims.push(c) } : undefined)
  return { updates, claims, src }
}

describe('a new conversation is found in the day folder it lands in (row 38)', () => {
  it('after midnight UTC: the session started at 23:59:58, its rollout lands in the next day\'s folder', async () => {
    process.env.TZ = 'UTC'
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-27T23:59:58.000Z'))
    const sessions = realm()
    const { updates, src } = watch(sessions, '/p/demo')
    await vi.advanceTimersByTimeAsync(10_000)
    rollout(folder(sessions, 2026, 9, 28), ID_A, '/p/demo', new Date().toISOString(), 42)
    await vi.advanceTimersByTimeAsync(400)
    src.stop()
    expect(updates.at(-1)?.inputTokens).toBe(42)
  })

  it('by the local date: 05:00 in Tokyo is still the day before in UTC', async () => {
    process.env.TZ = 'Asia/Tokyo'
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-27T20:00:00.000Z'))
    const sessions = realm()
    const { updates, src } = watch(sessions, '/p/demo')
    rollout(folder(sessions, 2026, 9, 28), ID_A, '/p/demo', new Date(Date.now() + 1000).toISOString(), 7)
    await vi.advanceTimersByTimeAsync(400)
    src.stop()
    expect(updates.at(-1)?.inputTokens).toBe(7)
  })

  it('says which conversation it claimed; one whose id is not a conversation id feeds the status line but is never reported', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const now = new Date()
    const dir = folder(sessions, now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate())
    rollout(dir, ID_A, '/p/demo', new Date(Date.now() + 100).toISOString(), 5)
    const first = watch(sessions, '/p/demo', {})
    await vi.advanceTimersByTimeAsync(300)
    first.src.stop()
    expect(first.claims).toEqual([{ id: ID_A, cwd: '/p/demo' }])
    rollout(dir, '--resume', '/p/other', new Date(Date.now() + 100).toISOString(), 6)
    const second = watch(sessions, '/p/other', {})
    await vi.advanceTimersByTimeAsync(300)
    second.src.stop()
    expect(second.updates.at(-1)?.inputTokens).toBe(6)
    expect(second.claims).toEqual([])
  })

  it('a first line still being written is read again, not given up on', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const now = new Date()
    const dir = folder(sessions, now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate())
    const file = join(dir, `rollout-x-${ID_A}.jsonl`)
    const line = metaLine(ID_A, '/p/demo', new Date(Date.now() + 500).toISOString())
    writeFileSync(file, line.slice(0, 20), 'utf-8')
    const { updates, src } = watch(sessions, '/p/demo')
    await vi.advanceTimersByTimeAsync(600)
    writeFileSync(file, line + '\n' + tokenLine(new Date().toISOString(), 3) + '\n', 'utf-8')
    await vi.advanceTimersByTimeAsync(400)
    src.stop()
    expect(updates.at(-1)?.inputTokens).toBe(3)
  })
})

describe('a resumed conversation is found by its id, wherever it is (rows 34, 38)', () => {
  it('claims a two-day-old conversation\'s rollout at once, whatever its age, and says which it claimed', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000)
    rollout(folder(sessions, old.getUTCFullYear(), old.getUTCMonth() + 1, old.getUTCDate()), ID_A, 'C:\\p\\demo', old.toISOString(), 1234)
    const { updates, claims, src } = watch(sessions, '/elsewhere', { resumeId: ID_A })
    await vi.advanceTimersByTimeAsync(300)
    src.stop()
    expect(updates.at(-1)?.inputTokens).toBe(1234)
    expect(claims).toEqual([{ id: ID_A, cwd: 'C:\\p\\demo' }])
  })

  it('never a file that only has the id in its name: its session_meta must say the same id', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000)
    const dir = folder(sessions, old.getUTCFullYear(), old.getUTCMonth() + 1, old.getUTCDate())
    writeFileSync(join(dir, `rollout-old-${ID_A}.jsonl`), metaLine(ID_B, '/p/demo', old.toISOString()) + '\n' + tokenLine(old.toISOString(), 5) + '\n')
    const { updates, claims, src } = watch(sessions, '/p/demo', { resumeId: ID_A })
    await vi.advanceTimersByTimeAsync(2_500)
    src.stop()
    expect(updates).toEqual([])
    expect(claims).toEqual([])
  })

  it('a launch that resumes by id never claims another session\'s new rollout in its folder', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const now = new Date()
    rollout(folder(sessions, now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()), ID_B, '/p/demo', new Date(Date.now() + 200).toISOString(), 9)
    const { updates, claims, src } = watch(sessions, '/p/demo', { resumeId: ID_A })
    await vi.advanceTimersByTimeAsync(2_500)
    src.stop()
    expect(updates).toEqual([])
    expect(claims).toEqual([])
  })
})

describe('the conversation the resume picker opened (rows 32, 38)', () => {
  it('is claimed once its rollout grows after the pick, and the pick file is removed', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const pickFile = join(sessions, '..', 'pick.json')
    const old = new Date(Date.now() - 5 * 24 * 3600 * 1000)
    const file = rollout(folder(sessions, old.getUTCFullYear(), old.getUTCMonth() + 1, old.getUTCDate()), ID_A, '/p/wt', old.toISOString(), 10)
    const { updates, claims, src } = watch(sessions, '/p/demo', { pickFile })
    await vi.advanceTimersByTimeAsync(20_000)
    writeFileSync(pickFile, JSON.stringify({ id: ID_A }))
    await vi.advanceTimersByTimeAsync(1_500)
    expect(existsSync(pickFile)).toBe(false)
    // Not yet: the picked conversation has not been written to since the pick.
    expect(claims).toEqual([])
    appendFileSync(file, tokenLine(new Date().toISOString(), 11) + '\n')
    await vi.advanceTimersByTimeAsync(1_500)
    src.stop()
    expect(claims).toEqual([{ id: ID_A, cwd: '/p/wt' }])
    expect(updates.at(-1)?.inputTokens).toBe(11)
  })

  it('once the picker has named a conversation, another session\'s new rollout in the same folder is never claimed', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const pickFile = join(sessions, '..', 'pick.json')
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000)
    rollout(folder(sessions, old.getUTCFullYear(), old.getUTCMonth() + 1, old.getUTCDate()), ID_A, '/p/demo', old.toISOString(), 10)
    const { claims, src } = watch(sessions, '/p/demo', { pickFile })
    writeFileSync(pickFile, JSON.stringify({ id: ID_A }))
    await vi.advanceTimersByTimeAsync(1_500)
    const now = new Date()
    rollout(folder(sessions, now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()), ID_B, '/p/demo', now.toISOString(), 2)
    await vi.advanceTimersByTimeAsync(1_500)
    src.stop()
    expect(claims).toEqual([])
  })

  it('a pick that is not a conversation id claims nothing old; a new conversation is still claimed', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const pickFile = join(sessions, '..', 'pick.json')
    const old = new Date(Date.now() - 24 * 3600 * 1000)
    const oldFile = rollout(folder(sessions, old.getUTCFullYear(), old.getUTCMonth() + 1, old.getUTCDate()), ID_A, '/p/demo', old.toISOString(), 10)
    const { claims, src } = watch(sessions, '/p/demo', { pickFile })
    writeFileSync(pickFile, JSON.stringify({ id: '--config=x' }))
    await vi.advanceTimersByTimeAsync(1_500)
    appendFileSync(oldFile, tokenLine(new Date().toISOString(), 11) + '\n')
    await vi.advanceTimersByTimeAsync(1_500)
    expect(existsSync(pickFile)).toBe(false)
    expect(claims).toEqual([])
    const now = new Date()
    rollout(folder(sessions, now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()), ID_B, '/p/demo', now.toISOString(), 2)
    await vi.advanceTimersByTimeAsync(400)
    src.stop()
    expect(claims).toEqual([{ id: ID_B, cwd: '/p/demo' }])
  })

  it('waits for the user: no give-up at 30 s, and a conversation started later is still claimed', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sessions = realm()
    const { updates, claims, src } = watch(sessions, '/p/demo', { pickFile: join(sessions, '..', 'pick.json') })
    await vi.advanceTimersByTimeAsync(45_000)
    expect(updates.some((u) => u.usageUnavailable === 'no-reading')).toBe(false)
    const now = new Date()
    rollout(folder(sessions, now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()), ID_B, '/p/demo', now.toISOString(), 4)
    await vi.advanceTimersByTimeAsync(400)
    src.stop()
    expect(claims).toEqual([{ id: ID_B, cwd: '/p/demo' }])
    expect(warn).not.toHaveBeenCalled()
  })

  it('stop removes a pick file still waiting to be read', () => {
    const sessions = realm()
    mkdirSync(sessions, { recursive: true })
    const pickFile = join(sessions, '..', 'pick-late.json')
    const { src } = watch(sessions, '/p/demo', { pickFile })
    writeFileSync(pickFile, JSON.stringify({ id: ID_A }))
    src.stop()
    expect(existsSync(pickFile)).toBe(false)
  })
})
