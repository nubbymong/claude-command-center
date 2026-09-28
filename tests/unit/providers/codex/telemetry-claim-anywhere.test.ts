// P3.5 (row 38): a Codex session's status line finds its rollout wherever it
// is. Codex appends a resumed conversation to its ORIGINAL file, in its
// original date folder (P3.1 evidence, answer 2), and names a new file in
// local time; the watcher used to look only in today's UTC folder, fixed at
// the spawn, so a resumed conversation from an earlier day, or one crossing
// midnight UTC, got no status line. Real files in a temp folder; fake timers.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'
import { watchAndClaimRollout } from '../../../../src/main/providers/codex/telemetry'
import { codexFolderIdentity, __codexRolloutEntriesVisitedForTests } from '../../../../src/main/providers/codex/rollout-lookup'
import type { StatuslineData } from '../../../../src/shared/types'

const ID_A = '019dd000-0001-7000-8000-00000000000a'
const ID_B = '019dd000-0001-7000-8000-00000000000b'
const pad = (n: number) => String(n).padStart(2, '0')
const temps: string[] = []
const pickDirs: string[] = []
/** Removes a link (a junction on Windows), if still there, and never what it points at. */
function dropLink(p: string): void {
  const st = lstatSync(p, { throwIfNoEntry: false })
  if (!st) return
  if (!st.isSymbolicLink()) throw new Error('not a link: ' + p)
  try { unlinkSync(p) } catch { rmdirSync(p) }
}
const originalTz = process.env.TZ

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (originalTz === undefined) delete process.env.TZ
  else process.env.TZ = originalTz
  // Only a folder this file made (its own prefix, directly in the temp folder) is removed recursively.
  for (const t of temps.splice(0)) if (dirname(t) === tmpdir() && /^ccc-test-codex-claim-/.test(basename(t))) rmSync(t, { recursive: true, force: true })
  // A pick folder (the watcher removes it; here only if a test failed first): its pick file, then the folder, never recursively.
  for (const d of pickDirs.splice(0)) {
    if (dirname(d) !== tmpdir() || !/^ccc-codex-pick-/.test(basename(d))) continue
    try { unlinkSync(join(d, 'pick.json')) } catch { /* not there */ }
    try { rmdirSync(d) } catch { /* not empty, or gone */ }
  }
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
  const releases: number[] = []
  // The pick folder as the builder records it when made, unless a test gives one (fix round 3).
  const withFolder = opts && opts.pickFile && !('pickFolder' in opts) ? { ...opts, pickFolder: codexFolderIdentity(dirname(opts.pickFile)) ?? undefined } : opts
  const src = watchAndClaimRollout('sess-p35', cwd, Date.now(), (d) => updates.push(d), sessions, undefined,
    withFolder ? { ...withFolder, onClaim: (c) => claims.push(c), onRelease: () => releases.push(claims.length) } : undefined)
  return { updates, claims, releases, src }
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

  it('a pick that is neither a conversation id nor a new conversation is removed once and decides nothing', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const pickFile = join(sessions, '..', 'pick.json')
    const old = new Date(Date.now() - 24 * 3600 * 1000)
    const oldFile = rollout(folder(sessions, old.getUTCFullYear(), old.getUTCMonth() + 1, old.getUTCDate()), ID_A, '/p/demo', old.toISOString(), 10)
    const { claims, src } = watch(sessions, '/p/demo', { pickFile })
    for (const bad of [JSON.stringify({ id: '--config=x' }), JSON.stringify({ fresh: 'yes' }), 'not json']) {
      writeFileSync(pickFile, bad)
      await vi.advanceTimersByTimeAsync(600)
      expect(existsSync(pickFile), bad).toBe(false)
    }
    appendFileSync(oldFile, tokenLine(new Date().toISOString(), 11) + '\n')
    const now = new Date()
    rollout(folder(sessions, now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()), ID_B, '/p/demo', now.toISOString(), 2)
    await vi.advanceTimersByTimeAsync(1_500)
    src.stop()
    expect(claims).toEqual([])
  })

  it('waits for the user: no give-up at 30 s; a new conversation is claimed only once the picker says so', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sessions = realm()
    const pickFile = join(sessions, '..', 'pick.json')
    const { updates, claims, src } = watch(sessions, '/p/demo', { pickFile })
    await vi.advanceTimersByTimeAsync(45_000)
    expect(updates.some((u) => u.usageUnavailable === 'no-reading')).toBe(false)
    writeFileSync(pickFile, JSON.stringify({ fresh: true }))
    await vi.advanceTimersByTimeAsync(300)
    const now = new Date()
    rollout(folder(sessions, now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()), ID_B, '/p/demo', now.toISOString(), 4)
    await vi.advanceTimersByTimeAsync(400)
    src.stop()
    expect(claims).toEqual([{ id: ID_B, cwd: '/p/demo' }])
    expect(warn).not.toHaveBeenCalled()
  })

  it('before its pick a picker session claims nothing, not even a new rollout in its own folder', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const { claims, src } = watch(sessions, '/p/demo', { pickFile: join(sessions, '..', 'pick.json') })
    const now = new Date()
    rollout(folder(sessions, now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()), ID_B, '/p/demo', new Date(Date.now() + 200).toISOString(), 4)
    await vi.advanceTimersByTimeAsync(5_000)
    src.stop()
    expect(claims).toEqual([])
  })

  it('after a new conversation is chosen, only a rollout created from that moment is claimed', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const pickFile = join(sessions, '..', 'pick.json')
    const now = new Date()
    const today = folder(sessions, now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate())
    const { claims, src } = watch(sessions, '/p/demo', { pickFile })
    // Another session's, written after this one started but before its choice.
    rollout(today, ID_A, '/p/demo', new Date(Date.now() - 3_000).toISOString(), 1)
    writeFileSync(pickFile, JSON.stringify({ fresh: true }))
    await vi.advanceTimersByTimeAsync(600)
    expect(claims).toEqual([])
    rollout(today, ID_B, '/p/demo', new Date(Date.now() + 500).toISOString(), 2)
    await vi.advanceTimersByTimeAsync(600)
    src.stop()
    expect(claims).toEqual([{ id: ID_B, cwd: '/p/demo' }])
  })

  it('a later choice replaces an earlier one: the new conversation the picker falls back to after a failed resume is claimed', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const pickFile = join(sessions, '..', 'pick.json')
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000)
    rollout(folder(sessions, old.getUTCFullYear(), old.getUTCMonth() + 1, old.getUTCDate()), ID_A, '/p/demo', old.toISOString(), 10)
    const { claims, src } = watch(sessions, '/p/demo', { pickFile })
    writeFileSync(pickFile, JSON.stringify({ id: ID_A }))
    await vi.advanceTimersByTimeAsync(1_500)
    writeFileSync(pickFile, JSON.stringify({ fresh: true }))
    await vi.advanceTimersByTimeAsync(300)
    const now = new Date()
    rollout(folder(sessions, now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()), ID_B, '/p/demo', new Date(Date.now() + 200).toISOString(), 3)
    await vi.advanceTimersByTimeAsync(600)
    src.stop()
    expect(claims).toEqual([{ id: ID_B, cwd: '/p/demo' }])
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

// P3.5 fix round 1 (thesis 14): two sessions of one account in one folder never
// take each other's rollout when one of them resumes or goes through the picker.
describe('two sessions in the same folder', () => {
  const today = (sessions: string) => { const n = new Date(); return folder(sessions, n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate()) }

  it('a picker session that has not chosen yet never takes a new session\'s rollout; the new session does', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const picker = watch(sessions, '/p/demo', { pickFile: join(sessions, '..', 'pick-a.json') })
    const fresh = watch(sessions, '/p/demo', {})
    rollout(today(sessions), ID_B, '/p/demo', new Date(Date.now() + 200).toISOString(), 5)
    await vi.advanceTimersByTimeAsync(1_000)
    picker.src.stop()
    fresh.src.stop()
    expect(picker.claims).toEqual([])
    expect(fresh.claims).toEqual([{ id: ID_B, cwd: '/p/demo' }])
  })

  it('a picker session that resumes one conversation never takes the new session\'s, and takes its own once it grows', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const pickFile = join(sessions, '..', 'pick-a.json')
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000)
    const mine = rollout(folder(sessions, old.getUTCFullYear(), old.getUTCMonth() + 1, old.getUTCDate()), ID_A, '/p/demo', old.toISOString(), 10)
    const picker = watch(sessions, '/p/demo', { pickFile })
    const fresh = watch(sessions, '/p/demo', {})
    writeFileSync(pickFile, JSON.stringify({ id: ID_A }))
    await vi.advanceTimersByTimeAsync(1_500)
    rollout(today(sessions), ID_B, '/p/demo', new Date(Date.now() + 200).toISOString(), 5)
    appendFileSync(mine, tokenLine(new Date().toISOString(), 12) + '\n')
    await vi.advanceTimersByTimeAsync(1_500)
    picker.src.stop()
    fresh.src.stop()
    expect(picker.claims).toEqual([{ id: ID_A, cwd: '/p/demo' }])
    expect(fresh.claims).toEqual([{ id: ID_B, cwd: '/p/demo' }])
  })

  it('a picker session that chose a new conversation never takes one begun before its choice', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const pickFile = join(sessions, '..', 'pick-a.json')
    const picker = watch(sessions, '/p/demo', { pickFile })
    rollout(today(sessions), ID_B, '/p/demo', new Date(Date.now() - 3_000).toISOString(), 5)
    writeFileSync(pickFile, JSON.stringify({ fresh: true }))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(picker.claims).toEqual([])
    rollout(today(sessions), ID_A, '/p/demo', new Date(Date.now() + 300).toISOString(), 6)
    await vi.advanceTimersByTimeAsync(600)
    picker.src.stop()
    expect(picker.claims).toEqual([{ id: ID_A, cwd: '/p/demo' }])
  })

  it('a session resuming by id and a picker session that chose a new one each take only their own', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const pickFile = join(sessions, '..', 'pick-a.json')
    const old = new Date(Date.now() - 24 * 3600 * 1000)
    rollout(folder(sessions, old.getUTCFullYear(), old.getUTCMonth() + 1, old.getUTCDate()), ID_A, '/p/demo', old.toISOString(), 10)
    const picker = watch(sessions, '/p/demo', { pickFile })
    const resumed = watch(sessions, '/p/demo', { resumeId: ID_A })
    writeFileSync(pickFile, JSON.stringify({ fresh: true }))
    await vi.advanceTimersByTimeAsync(300)
    rollout(today(sessions), ID_B, '/p/demo', new Date(Date.now() + 300).toISOString(), 6)
    await vi.advanceTimersByTimeAsync(1_000)
    picker.src.stop()
    resumed.src.stop()
    expect(resumed.claims).toEqual([{ id: ID_A, cwd: '/p/demo' }])
    expect(picker.claims).toEqual([{ id: ID_B, cwd: '/p/demo' }])
  })
})

// P3.5 fix round 1 (thesis 11): the pick file is read only when it is a small
// regular file, never through a link, and a bad one is dealt with once.
describe('what main reads as the pick', () => {
  const todayDir = (sessions: string) => { const n = new Date(); return folder(sessions, n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate()) }

  it('a file link at the pick path is not followed: it decides nothing, is removed, and what it pointed at is left alone', async (ctx) => {
    vi.useFakeTimers()
    const sessions = realm()
    mkdirSync(sessions, { recursive: true })
    const pickFile = join(sessions, '..', 'pick.json')
    const target = join(sessions, '..', 'elsewhere.json')
    writeFileSync(target, JSON.stringify({ fresh: true }))
    try { symlinkSync(target, pickFile, 'file') } catch { ctx.skip(); return }
    const { claims, src } = watch(sessions, '/p/demo', { pickFile })
    await vi.advanceTimersByTimeAsync(300)
    rollout(todayDir(sessions), ID_B, '/p/demo', new Date(Date.now() + 200).toISOString(), 2)
    await vi.advanceTimersByTimeAsync(600)
    src.stop()
    expect(claims).toEqual([])
    expect(existsSync(target)).toBe(true)
    expect(() => lstatSync(pickFile)).toThrow()
  })

  it('a folder or a folder link at the pick path decides nothing, and the watch carries on', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    mkdirSync(sessions, { recursive: true })
    const pickFile = join(sessions, '..', 'pick.json')
    const inside = join(sessions, '..', 'real-folder')
    mkdirSync(inside)
    writeFileSync(join(inside, 'keep.txt'), 'x')
    symlinkSync(inside, pickFile, 'junction')
    const { claims, src } = watch(sessions, '/p/demo', { pickFile })
    await vi.advanceTimersByTimeAsync(600)
    expect(existsSync(join(inside, 'keep.txt'))).toBe(true)
    dropLink(pickFile)
    mkdirSync(pickFile)
    await vi.advanceTimersByTimeAsync(600)
    rmdirSync(pickFile)
    writeFileSync(pickFile, JSON.stringify({ fresh: true }))
    await vi.advanceTimersByTimeAsync(300)
    rollout(todayDir(sessions), ID_B, '/p/demo', new Date(Date.now() + 200).toISOString(), 2)
    await vi.advanceTimersByTimeAsync(600)
    src.stop()
    expect(claims).toEqual([{ id: ID_B, cwd: '/p/demo' }])
  })

  it('a pick file larger than the bound is removed unread', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    mkdirSync(sessions, { recursive: true })
    const pickFile = join(sessions, '..', 'pick.json')
    writeFileSync(pickFile, JSON.stringify({ fresh: true, pad: 'x'.repeat(4096) }))
    const { claims, src } = watch(sessions, '/p/demo', { pickFile })
    await vi.advanceTimersByTimeAsync(300)
    expect(existsSync(pickFile)).toBe(false)
    rollout(todayDir(sessions), ID_B, '/p/demo', new Date(Date.now() + 200).toISOString(), 2)
    await vi.advanceTimersByTimeAsync(600)
    src.stop()
    expect(claims).toEqual([])
  })
})

// P3.5 fix round 2 (quality minor 2): the picker can decide again after a
// claim: its picked resume wrote to its rollout, then failed, and it falls
// back to a new conversation. The watcher keeps reading the pick file; a new
// decision lets the claim go (the session no longer keeps that conversation)
// and claims by the protocol again.
describe('a decision after a claim', () => {
  it('lets the claimed conversation go and follows the new one the picker falls back to', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const pickFile = join(sessions, '..', 'pick.json')
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000)
    const picked = rollout(folder(sessions, old.getUTCFullYear(), old.getUTCMonth() + 1, old.getUTCDate()), ID_A, '/p/demo', old.toISOString(), 10)
    const { claims, releases, updates, src } = watch(sessions, '/p/demo', { pickFile })
    writeFileSync(pickFile, JSON.stringify({ id: ID_A }))
    await vi.advanceTimersByTimeAsync(1_500)
    appendFileSync(picked, tokenLine(new Date().toISOString(), 11) + '\n')
    await vi.advanceTimersByTimeAsync(1_500)
    expect(claims).toEqual([{ id: ID_A, cwd: '/p/demo' }])
    writeFileSync(pickFile, JSON.stringify({ fresh: true }))
    await vi.advanceTimersByTimeAsync(600)
    expect(releases).toEqual([1])
    // Fix round 3: the status line no longer shows the conversation let go.
    expect(updates.at(-1)).toEqual({ sessionId: 'sess-p35', inputTokens: 0, outputTokens: 0, costUsd: 0, contextUsedPercent: 0 })
    const now = new Date()
    rollout(folder(sessions, now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()), ID_B, '/p/demo', new Date(Date.now() + 200).toISOString(), 3)
    await vi.advanceTimersByTimeAsync(600)
    // The old rollout growing again is no longer followed.
    appendFileSync(picked, tokenLine(new Date().toISOString(), 99) + '\n')
    await vi.advanceTimersByTimeAsync(1_000)
    src.stop()
    expect(claims).toEqual([{ id: ID_A, cwd: '/p/demo' }, { id: ID_B, cwd: '/p/demo' }])
    expect(updates.at(-1)?.inputTokens).toBe(3)
  })

  it('a launch that resumes by id reads no pick file after its claim', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const pickFile = join(sessions, '..', 'pick.json')
    const old = new Date(Date.now() - 24 * 3600 * 1000)
    rollout(folder(sessions, old.getUTCFullYear(), old.getUTCMonth() + 1, old.getUTCDate()), ID_A, '/p/demo', old.toISOString(), 10)
    const { claims, releases, src } = watch(sessions, '/p/demo', { resumeId: ID_A, pickFile })
    await vi.advanceTimersByTimeAsync(300)
    writeFileSync(pickFile, JSON.stringify({ fresh: true }))
    await vi.advanceTimersByTimeAsync(1_000)
    // Not read: still there until the watch stops and clears it.
    expect(existsSync(pickFile)).toBe(true)
    src.stop()
    expect(claims).toEqual([{ id: ID_A, cwd: '/p/demo' }])
    expect(releases).toEqual([])
  })
})

// P3.5 fix round 2 (lens A minor): the pick file lives in its own private
// folder, which the watcher removes with it when it stops.
describe('the pick file\'s folder', () => {
  it('is removed with the pick file when the watch stops; any other folder is left', () => {
    const sessions = realm()
    mkdirSync(sessions, { recursive: true })
    const own = mkdtempSync(join(tmpdir(), 'ccc-codex-pick-'))
    pickDirs.push(own)
    const pickFile = join(own, 'pick.json')
    writeFileSync(pickFile, JSON.stringify({ fresh: true }))
    watch(sessions, '/p/demo', { pickFile }).src.stop()
    expect(existsSync(own)).toBe(false)
    const shared = join(sessions, '..', 'shared')
    mkdirSync(shared)
    watch(sessions, '/p/demo', { pickFile: join(shared, 'pick.json') }).src.stop()
    expect(existsSync(shared)).toBe(true)
  })
})

// P3.5 fix round 3 (lens A): the pick folder is used only while it is the
// folder the builder made for the launch (its identity recorded then): one
// swapped for a link or junction to another folder, or for another folder,
// is never read, written through or emptied. Links are never followed at the
// folder level.
describe('the pick folder is the one made for the launch (fix round 3)', () => {
  const todayDir = (sessions: string) => { const n = new Date(); return folder(sessions, n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate()) }

  it('a pick folder swapped for a link to another folder: nothing there is read or removed', async (ctx) => {
    vi.useFakeTimers()
    const sessions = realm()
    mkdirSync(sessions, { recursive: true })
    const victim = mkdtempSync(join(tmpdir(), 'ccc-test-codex-claim-'))
    temps.push(victim)
    writeFileSync(join(victim, 'pick.json'), JSON.stringify({ fresh: true }))
    writeFileSync(join(victim, 'keep.txt'), 'x')
    const own = mkdtempSync(join(tmpdir(), 'ccc-codex-pick-'))
    const made = codexFolderIdentity(own)!
    expect(made).toBeTruthy()
    rmdirSync(own)
    // A junction on Windows; a folder link elsewhere.
    try { symlinkSync(victim, own, 'junction') } catch { ctx.skip(); return }
    try {
      expect(codexFolderIdentity(own)).toBeNull()
      const { claims, src } = watch(sessions, '/p/demo', { pickFile: join(own, 'pick.json'), pickFolder: made })
      rollout(todayDir(sessions), ID_B, '/p/demo', new Date(Date.now() + 200).toISOString(), 2)
      await vi.advanceTimersByTimeAsync(1_500)
      src.stop()
      expect(claims).toEqual([])
      expect(readFileSync(join(victim, 'pick.json'), 'utf8')).toBe(JSON.stringify({ fresh: true }))
      expect(readdirSync(victim).sort()).toEqual(['keep.txt', 'pick.json'])
      expect(lstatSync(own).isSymbolicLink()).toBe(true)
    } finally {
      dropLink(own)
    }
  })

  it('a pick folder replaced by another folder: its pick is not read, and nothing there is removed', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    mkdirSync(sessions, { recursive: true })
    const own = mkdtempSync(join(tmpdir(), 'ccc-codex-pick-'))
    const made = codexFolderIdentity(own)!
    // The folder made is moved aside (so its file id stays taken) and another put in its place.
    const aside = own + '-aside'
    renameSync(own, aside)
    pickDirs.push(aside, own)
    mkdirSync(own)
    expect(codexFolderIdentity(own)?.id).not.toBe(made.id)
    writeFileSync(join(own, 'pick.json'), JSON.stringify({ fresh: true }))
    const { claims, src } = watch(sessions, '/p/demo', { pickFile: join(own, 'pick.json'), pickFolder: made })
    rollout(todayDir(sessions), ID_B, '/p/demo', new Date(Date.now() + 200).toISOString(), 2)
    await vi.advanceTimersByTimeAsync(1_500)
    src.stop()
    expect(claims).toEqual([])
    expect(readdirSync(own)).toEqual(['pick.json'])
  })

  it('a folder whose real path is not the one recorded: no pick is read', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    mkdirSync(sessions, { recursive: true })
    const pickFile = join(sessions, '..', 'pick.json')
    writeFileSync(pickFile, JSON.stringify({ fresh: true }))
    const made = codexFolderIdentity(dirname(pickFile))!
    const { claims, src } = watch(sessions, '/p/demo', { pickFile, pickFolder: { id: made.id, real: join(made.real, 'elsewhere') } })
    rollout(todayDir(sessions), ID_B, '/p/demo', new Date(Date.now() + 200).toISOString(), 2)
    await vi.advanceTimersByTimeAsync(1_500)
    src.stop()
    expect(claims).toEqual([])
    expect(existsSync(pickFile)).toBe(true)
  })

  it('with no folder identity recorded, no pick is read and nothing removed', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    mkdirSync(sessions, { recursive: true })
    const pickFile = join(sessions, '..', 'pick.json')
    writeFileSync(pickFile, JSON.stringify({ fresh: true }))
    const { claims, src } = watch(sessions, '/p/demo', { pickFile, pickFolder: undefined })
    rollout(todayDir(sessions), ID_B, '/p/demo', new Date(Date.now() + 200).toISOString(), 2)
    await vi.advanceTimersByTimeAsync(1_500)
    src.stop()
    expect(claims).toEqual([])
    expect(existsSync(pickFile)).toBe(true)
  })

  it('the folder made for the launch: its pick is read, and at stop a half-written pick is removed with the folder; any other file stays', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    mkdirSync(sessions, { recursive: true })
    const own = mkdtempSync(join(tmpdir(), 'ccc-codex-pick-'))
    pickDirs.push(own)
    const pickFile = join(own, 'pick.json')
    writeFileSync(pickFile, JSON.stringify({ fresh: true }))
    const { claims, src } = watch(sessions, '/p/demo', { pickFile })
    await vi.advanceTimersByTimeAsync(300)
    rollout(todayDir(sessions), ID_B, '/p/demo', new Date(Date.now() + 200).toISOString(), 2)
    await vi.advanceTimersByTimeAsync(600)
    expect(claims).toEqual([{ id: ID_B, cwd: '/p/demo' }])
    // What a picker stopped between its write and its rename leaves behind.
    writeFileSync(join(own, 'pick.json.0123456789abcdef.tmp'), JSON.stringify({ fresh: true }))
    src.stop()
    expect(existsSync(own)).toBe(false)

    const other = mkdtempSync(join(tmpdir(), 'ccc-codex-pick-'))
    pickDirs.push(other)
    writeFileSync(join(other, 'pick.json.fedcba9876543210.tmp'), '{}')
    writeFileSync(join(other, 'pick.json.not-hex.tmp'), '{}')
    watch(sessions, '/p/demo', { pickFile: join(other, 'pick.json') }).src.stop()
    expect(readdirSync(other)).toEqual(['pick.json.not-hex.tmp'])
    unlinkSync(join(other, 'pick.json.not-hex.tmp'))
  })
})

// P3.5 fix round 3 (quality minor): a pick names a conversation, not a folder.
// A conversation picked from another worktree records that worktree, never
// the session's own folder, so its lookup is made with no kept folder: the
// walk ends with the day folder of its own rollout instead of running on to
// the walk's bounds on every such pick. A resume by id still prefers the
// session's folder.
describe('a pick from another worktree is looked up without the session\'s folder', () => {
  it('visits only what lies before its rollout, and claims it once it grows', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const OTHER = (n: number) => `019dd000-0001-7000-8000-${String(n).padStart(12, '0')}`
    let n = 0
    for (let month = 7; month <= 9; month++) {
      for (let day = 1; day <= 20; day++) {
        const dir = folder(sessions, 2026, month, day)
        for (let k = 0; k < 3; k++) rollout(dir, OTHER(++n), '/p/demo', `2026-${pad(month)}-${pad(day)}T10:00:0${k}.000Z`)
      }
    }
    const picked = rollout(folder(sessions, 2026, 9, 20), ID_A, '/wt/other', '2026-09-20T12:00:00.000Z', 5)
    const pickFile = join(sessions, '..', 'pick.json')
    const { claims, src } = watch(sessions, '/p/demo', { pickFile })
    const before = __codexRolloutEntriesVisitedForTests()
    writeFileSync(pickFile, JSON.stringify({ id: ID_A }))
    await vi.advanceTimersByTimeAsync(300)
    const visited = __codexRolloutEntriesVisitedForTests() - before
    // The year, its three months, the twenty days of September, and that day's four files.
    expect(visited).toBeGreaterThan(0)
    expect(visited).toBeLessThanOrEqual(1 + 3 + 20 + 4)
    appendFileSync(picked, tokenLine(new Date().toISOString(), 6) + '\n')
    await vi.advanceTimersByTimeAsync(600)
    src.stop()
    expect(claims).toEqual([{ id: ID_A, cwd: '/wt/other' }])
  })

  it("a resume by id still prefers the session's folder: a newer copy recording another folder is not claimed", async () => {
    vi.useFakeTimers()
    const sessions = realm()
    rollout(folder(sessions, 2026, 9, 27), ID_A, '/p/other', '2026-09-27T10:00:00.000Z', 7)
    rollout(folder(sessions, 2026, 9, 20), ID_A, '/p/demo', '2026-09-20T10:00:00.000Z', 5)
    const { claims, src } = watch(sessions, '/p/demo', { resumeId: ID_A })
    await vi.advanceTimersByTimeAsync(300)
    src.stop()
    expect(claims).toEqual([{ id: ID_A, cwd: '/p/demo' }])
  })
})
