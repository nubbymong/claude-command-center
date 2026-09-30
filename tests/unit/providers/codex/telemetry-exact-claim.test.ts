// P3.10 (with P3.5 and P3.6's limits): the exact claim of a Codex conversation
// from the session's own hook, as Claude's SessionStart bind (#480). Every Codex
// hook event carries `transcript_path`, the exact rollout (P3.1 evidence, answer
// 4; the P3.10 VM probe: SessionStart comes with a conversation's first turn, a
// new one or one resumed inside the TUI). The watcher takes it only when it is a
// rollout of its own realm (real folders at every level, a plain file named
// `rollout-...-<id>.jsonl` whose session_meta names that id): untrusted input,
// refused on any doubt. It confirms an inferred claim, or lets a wrong one go
// and claims the right one; a conversation switched inside the TUI is followed.
// Another session's hook proves an inferred claim here wrong. Real files in a
// temp folder; fake timers.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'fs'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'
import { watchAndClaimRollout, __codexRolloutReadersForTests } from '../../../../src/main/providers/codex/telemetry'
import type { StatuslineData } from '../../../../src/shared/types'

const ID_A = '019dd000-0001-7000-8000-00000000000a'
const ID_B = '019dd000-0001-7000-8000-00000000000b'
const ID_C = '019dd000-0001-7000-8000-00000000000c'
const pad = (n: number) => String(n).padStart(2, '0')
const temps: string[] = []
function dropLink(p: string): void {
  const st = lstatSync(p, { throwIfNoEntry: false })
  if (!st) return
  if (!st.isSymbolicLink()) throw new Error('not a link: ' + p)
  try { unlinkSync(p) } catch { rmdirSync(p) }
}
afterEach(() => {
  vi.useRealTimers()
  // TEST CLEANUP GUARD: only a folder this file made (its own prefix, directly in the temp folder).
  for (const t of temps.splice(0)) if (dirname(t) === tmpdir() && /^ccc-test-codex-exact-/.test(basename(t))) rmSync(t, { recursive: true, force: true })
})

function realm(): string {
  const base = mkdtempSync(join(tmpdir(), 'ccc-test-codex-exact-'))
  temps.push(base)
  return join(base, 'sessions')
}
function today(sessions: string): string {
  const d = new Date()
  const dir = join(sessions, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()))
  mkdirSync(dir, { recursive: true })
  return dir
}
const metaLine = (id: string, cwd: string, iso: string) =>
  JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id, timestamp: iso, cwd, cli_version: '0.155.1' } })
const tokenLine = (iso: string, input: number) =>
  JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: input + 1 } }, rate_limits: null } })
function rollout(dir: string, id: string, cwd: string, iso: string, input?: number, metaId = id): string {
  const file = join(dir, `rollout-${iso.slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`)
  writeFileSync(file, [metaLine(metaId, cwd, iso), ...(input === undefined ? [] : [tokenLine(iso, input)])].join('\n') + '\n', 'utf-8')
  return file
}
interface Claim { id: string; cwd: string; certain?: boolean; exact?: boolean; fromHook?: boolean }
function watch(sessions: string, cwd: string, opts: { resumeId?: string } = {}) {
  const updates: StatuslineData[] = []
  const claims: Claim[] = []
  const shared: Claim[] = []
  const releases: number[] = []
  const src = watchAndClaimRollout('sess', cwd, Date.now(), (d) => updates.push(d), sessions, undefined, {
    ...opts,
    onClaim: (c) => claims.push({ ...c }),
    onShared: (c) => shared.push({ ...c }),
    onRelease: () => releases.push(claims.length),
  })
  return { updates, claims, shared, releases, src }
}

describe('the exact claim from the session\'s own hook (P3.10)', () => {
  it('confirms an inferred claim of the same rollout: told again as exact, from the hook; nothing let go', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const w = watch(sessions, '/p/demo')
    const file = rollout(today(sessions), ID_A, '/p/demo', new Date(Date.now() + 50).toISOString(), 5)
    await vi.advanceTimersByTimeAsync(400)
    expect(w.claims).toEqual([{ id: ID_A, cwd: '/p/demo', certain: true, exact: false, fromHook: false }])
    expect(w.src.noteExactRollout!(file)).toEqual({ id: ID_A, cwd: '/p/demo' })
    expect(w.claims.at(-1)).toEqual({ id: ID_A, cwd: '/p/demo', certain: true, exact: true, fromHook: true })
    expect(w.releases).toEqual([])
    // Said once: the same path again changes nothing.
    w.src.noteExactRollout!(file)
    expect(w.claims.length).toBe(2)
    expect(__codexRolloutReadersForTests(file)).toBe(1)
    w.src.stop()
  })

  it('an inferred claim of the wrong new rollout is let go and the one the hook names claimed (two new sessions in one folder)', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const w = watch(sessions, '/p/demo')
    const other = rollout(today(sessions), ID_B, '/p/demo', new Date(Date.now() + 20).toISOString(), 7)
    await vi.advanceTimersByTimeAsync(400)
    expect(w.claims.map((c) => c.id)).toEqual([ID_B])
    const mine = rollout(today(sessions), ID_A, '/p/demo', new Date(Date.now() + 40).toISOString(), 3)
    expect(w.src.noteExactRollout!(mine)?.id).toBe(ID_A)
    expect(w.releases).toEqual([1])
    expect(w.claims.at(-1)).toEqual({ id: ID_A, cwd: '/p/demo', certain: true, exact: true, fromHook: true })
    expect(w.updates.at(-1)?.inputTokens).toBe(3)
    expect(__codexRolloutReadersForTests(other)).toBe(0)
    expect(__codexRolloutReadersForTests(mine)).toBe(1)
    w.src.stop()
  })

  it('follows a conversation switched inside the TUI (its own resume): the old claim let go, the resumed one read', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000)
    const oldDir = join(sessions, String(old.getUTCFullYear()), pad(old.getUTCMonth() + 1), pad(old.getUTCDate()))
    mkdirSync(oldDir, { recursive: true })
    const resumed = rollout(oldDir, ID_C, '/p/elsewhere', old.toISOString(), 99)
    const w = watch(sessions, '/p/demo')
    rollout(today(sessions), ID_A, '/p/demo', new Date(Date.now() + 50).toISOString(), 5)
    await vi.advanceTimersByTimeAsync(400)
    expect(w.src.noteExactRollout!(resumed)).toEqual({ id: ID_C, cwd: '/p/elsewhere' })
    expect(w.claims.at(-1)).toEqual({ id: ID_C, cwd: '/p/elsewhere', certain: true, exact: true, fromHook: true })
    expect(w.updates.at(-1)?.inputTokens).toBe(99)
    appendFileSync(resumed, tokenLine(new Date().toISOString(), 101) + '\n')
    await vi.advanceTimersByTimeAsync(600)
    expect(w.updates.at(-1)?.inputTokens).toBe(101)
    w.src.stop()
  })

  it('refuses a path outside its realm, relative, misnamed, or whose session_meta names another id; nothing changes', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const w = watch(sessions, '/p/demo')
    const mine = rollout(today(sessions), ID_A, '/p/demo', new Date(Date.now() + 50).toISOString(), 5)
    await vi.advanceTimersByTimeAsync(400)
    const otherRealm = realm()
    const foreign = rollout(today(otherRealm), ID_B, '/p/demo', new Date().toISOString(), 1)
    const lying = rollout(today(sessions), ID_C, '/p/demo', new Date().toISOString(), 1, ID_B)
    const misnamed = join(today(sessions), 'notes.jsonl')
    writeFileSync(misnamed, metaLine(ID_B, '/p/demo', new Date().toISOString()) + '\n')
    const outsideDay = join(sessions, `rollout-2026-09-29T00-00-00-${ID_B}.jsonl`)
    writeFileSync(outsideDay, metaLine(ID_B, '/p/demo', new Date().toISOString()) + '\n')
    // Below a real rollout of this realm: the path named is not that rollout's.
    const below = join(rollout(today(sessions), ID_B, '/p/elsewhere', new Date().toISOString(), 1), 'more')
    for (const bad of [foreign, lying, misnamed, outsideDay, below, join('..', basename(mine)), `${mine}\n`, '', join(sessions, '..', '..', basename(mine))]) {
      expect(w.src.noteExactRollout!(bad), bad).toBeNull()
    }
    expect(w.src.noteExactRollout!(42 as unknown as string)).toBeNull()
    expect(w.claims.map((c) => c.id)).toEqual([ID_A])
    expect(w.releases).toEqual([])
    w.src.stop()
  })

  it('refuses a rollout reached through a day folder that is a link, and a file link', async (ctx) => {
    vi.useFakeTimers()
    const sessions = realm()
    const w = watch(sessions, '/p/demo')
    const dir = today(sessions)
    const real = join(sessions, '..', 'elsewhere')
    mkdirSync(real)
    const target = rollout(real, ID_B, '/p/demo', new Date().toISOString(), 1)
    // A day folder swapped for a junction (no privilege needed on Windows).
    const dayMoved = join(sessions, '..', 'day-moved')
    renameSync(dir, dayMoved)
    const viaJunction = rollout(dayMoved, ID_C, '/p/demo', new Date().toISOString(), 1)
    try { symlinkSync(dayMoved, dir, 'junction') } catch { w.src.stop(); ctx.skip(); return }
    try {
      expect(w.src.noteExactRollout!(join(dir, basename(viaJunction)))).toBeNull()
      expect(w.claims).toEqual([])
    } finally { dropLink(dir) }
    // A file link inside a real day folder (a privilege on Windows: skipped there without it).
    mkdirSync(dir)
    const fileLink = join(dir, basename(target))
    try { symlinkSync(target, fileLink) } catch { w.src.stop(); return }
    try {
      expect(w.src.noteExactRollout!(fileLink)).toBeNull()
      expect(w.claims).toEqual([])
    } finally { unlinkSync(fileLink) }
    w.src.stop()
  })

  it('a rollout another session reads is read beside it, reported as shared, exact, from the hook', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000)
    const oldDir = join(sessions, String(old.getUTCFullYear()), pad(old.getUTCMonth() + 1), pad(old.getUTCDate()))
    mkdirSync(oldDir, { recursive: true })
    const file = rollout(oldDir, ID_A, '/p/demo', old.toISOString(), 10)
    const holder = watch(sessions, '/p/demo', { resumeId: ID_A })
    await vi.advanceTimersByTimeAsync(300)
    const second = watch(sessions, '/p/other')
    expect(second.src.noteExactRollout!(file)?.id).toBe(ID_A)
    expect(second.claims).toEqual([])
    expect(second.shared).toEqual([{ id: ID_A, cwd: '/p/demo', exact: true, fromHook: true }])
    expect(second.updates.at(-1)?.inputTokens).toBe(10)
    expect(__codexRolloutReadersForTests(file)).toBe(2)
    holder.src.stop(); second.src.stop()
    expect(__codexRolloutReadersForTests(file)).toBe(0)
  })

  it('claims after the no-claim deadline too (a first turn sent after a long start-up)', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const w = watch(sessions, '/p/demo')
    await vi.advanceTimersByTimeAsync(31_000)
    expect(w.updates.at(-1)?.usageUnavailable).toBe('no-reading')
    const file = rollout(today(sessions), ID_A, '/p/demo', new Date().toISOString(), 8)
    expect(w.src.noteExactRollout!(file)?.id).toBe(ID_A)
    expect(w.updates.at(-1)?.inputTokens).toBe(8)
    w.src.stop()
    expect(w.src.noteExactRollout!(file)).toBeNull()
  })

  it.runIf(process.platform === 'win32')('Windows: a hook spelling the realm in another case is the same rollout (Codex wrote C:\\Users\\User for C:\\Users\\user on the VM)', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const w = watch(sessions, '/p/demo')
    const file = rollout(today(sessions), ID_A, '/p/demo', new Date(Date.now() + 50).toISOString(), 5)
    await vi.advanceTimersByTimeAsync(400)
    const upper = file.slice(0, 3) + file.slice(3, 12).toUpperCase() + file.slice(12)
    expect(w.src.noteExactRollout!(upper)?.id).toBe(ID_A)
    expect(w.releases).toEqual([])
    expect(__codexRolloutReadersForTests(file)).toBe(1)
    w.src.stop()
  })
})

describe('another session\'s hook proves an inferred claim here wrong (P3.10)', () => {
  it('an inferred claim of that rollout is let go, never taken by inference again, and this session claims its own', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const a = watch(sessions, '/p/demo')
    const b = watch(sessions, '/p/demo')
    const xa = rollout(today(sessions), ID_A, '/p/demo', new Date(Date.now() + 10).toISOString(), 1)
    await vi.advanceTimersByTimeAsync(300)
    // One of the two took A's rollout by inference.
    const taker = a.claims.length > 0 ? a : b
    const other = taker === a ? b : a
    expect(taker.claims.map((c) => c.id)).toEqual([ID_A])
    const xb = rollout(today(sessions), ID_B, '/p/demo', new Date(Date.now() + 20).toISOString(), 2)
    await vi.advanceTimersByTimeAsync(300)
    expect(other.claims.map((c) => c.id)).toEqual([ID_B])
    // The OTHER session's hook says A's rollout is its own: the taker's claim was wrong.
    expect(other.src.noteExactRollout!(xa)?.id).toBe(ID_A)
    expect(taker.src.refuteInferredClaim!(xa)).toBe(true)
    await vi.advanceTimersByTimeAsync(600)
    expect(taker.releases).toEqual([1])
    expect(taker.claims.map((c) => c.id)).toEqual([ID_A, ID_B])
    expect(__codexRolloutReadersForTests(xa)).toBe(1)
    expect(__codexRolloutReadersForTests(xb)).toBe(1)
    a.src.stop(); b.src.stop()
  })

  it('a refuted rollout is never taken by inference again, even once the session its hook named lets it go', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const taker = watch(sessions, '/p/demo')
    const xa = rollout(today(sessions), ID_A, '/p/demo', new Date(Date.now() + 10).toISOString(), 1)
    await vi.advanceTimersByTimeAsync(300)
    expect(taker.claims.map((c) => c.id)).toEqual([ID_A])
    const owner = watch(sessions, '/p/other')
    expect(owner.src.noteExactRollout!(xa)?.id).toBe(ID_A)
    expect(taker.src.refuteInferredClaim!(xa)).toBe(true)
    owner.src.stop()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(taker.claims.map((c) => c.id)).toEqual([ID_A])
    expect(__codexRolloutReadersForTests(xa)).toBe(0)
    taker.src.stop()
  })

  it('an exact claim is never refuted (two tabs can be on one conversation), nor one of another rollout', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000)
    const oldDir = join(sessions, String(old.getUTCFullYear()), pad(old.getUTCMonth() + 1), pad(old.getUTCDate()))
    mkdirSync(oldDir, { recursive: true })
    const file = rollout(oldDir, ID_A, '/p/demo', old.toISOString(), 10)
    const resumed = watch(sessions, '/p/demo', { resumeId: ID_A })
    await vi.advanceTimersByTimeAsync(300)
    expect(resumed.src.refuteInferredClaim!(file)).toBe(false)
    const fresh = watch(sessions, '/p/demo')
    const mine = rollout(today(sessions), ID_B, '/p/demo', new Date(Date.now() + 50).toISOString(), 5)
    await vi.advanceTimersByTimeAsync(400)
    expect(fresh.claims.map((c) => c.id)).toEqual([ID_B])
    expect(fresh.src.refuteInferredClaim!(file)).toBe(false)
    expect(fresh.releases).toEqual([])
    expect(__codexRolloutReadersForTests(mine)).toBe(1)
    resumed.src.stop(); fresh.src.stop()
  })
})

// P3.10 round 1 (A4): a hook's path naming an alternate data stream (a `:` after
// the drive: `rollout-x:y-<id>.jsonl` is a stream of the file `rollout-x` on
// Windows, not a file of the day folder) is refused; a name spelled in another
// case (the id in capitals) is the day folder's own entry where the file system
// ignores case, read and counted under that one key, and nothing where it does
// not.
describe('the exact claim refuses a stream name and keys one rollout once (P3.10 round 1, A4)', () => {
  it('a `:` in the file name is never a rollout: nothing claimed, nothing read', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const day = today(sessions)
    const w = watch(sessions, '/p/other')
    writeFileSync(join(day, 'rollout-x'), '')
    const stream = join(day, `rollout-x:y-${ID_B}.jsonl`)
    writeFileSync(stream, metaLine(ID_B, '/p/x', new Date(Date.now() - 3600_000).toISOString()) + '\n')
    expect(w.src.noteExactRollout!(stream)).toBeNull()
    expect(w.claims).toEqual([])
    expect(__codexRolloutReadersForTests(stream)).toBe(0)
    w.src.stop()
  })

  it('an id in capitals is the same rollout where case is ignored (one key, the folder\'s own spelling); nothing where it is not', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const day = today(sessions)
    const w = watch(sessions, '/p/other')
    const good = rollout(day, ID_A, '/p/x', new Date(Date.now() - 3600_000).toISOString(), 3)
    const upper = join(day, basename(good).replace(ID_A, ID_A.toUpperCase()))
    const caseBlind = (() => { try { lstatSync(upper); return true } catch { return false } })()
    const took = w.src.noteExactRollout!(upper)
    expect(__codexRolloutReadersForTests(upper)).toBe(0)
    if (caseBlind) {
      expect(took).toEqual({ id: ID_A, cwd: '/p/x' })
      expect(__codexRolloutReadersForTests(good)).toBe(1)
      // The same rollout by its own spelling is the claim already held.
      expect(w.src.noteExactRollout!(good)).toEqual({ id: ID_A, cwd: '/p/x' })
      expect(__codexRolloutReadersForTests(good)).toBe(1)
    } else {
      expect(took).toBeNull()
    }
    w.src.stop()
    expect(__codexRolloutReadersForTests(good)).toBe(0)
  })
})

// P3.10 round 1 (Q4): claiming by inference starts again after a refuted claim
// (another session's hook proved it wrong), and stops again at the same 30 s
// no-claim deadline a launch has, as it would have at the launch.
describe('a refuted claim claims again, until the no-claim deadline (P3.10 round 1, Q4)', () => {
  it('after 30 s with nothing claimed, the watch stops looking and says there is no reading; the session\'s own hook can still claim', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const taker = watch(sessions, '/p/demo')
    const xa = rollout(today(sessions), ID_A, '/p/demo', new Date(Date.now() + 10).toISOString(), 1)
    await vi.advanceTimersByTimeAsync(300)
    expect(taker.claims.map((c) => c.id)).toEqual([ID_A])
    // Long after the launch's own deadline (it passed while the claim held).
    await vi.advanceTimersByTimeAsync(40_000)
    const noReading = () => taker.updates.filter((u) => (u as { usageUnavailable?: string }).usageUnavailable === 'no-reading').length
    expect(noReading()).toBe(0)
    const owner = watch(sessions, '/p/other')
    expect(owner.src.noteExactRollout!(xa)?.id).toBe(ID_A)
    expect(taker.src.refuteInferredClaim!(xa)).toBe(true)
    await vi.advanceTimersByTimeAsync(29_000)
    expect(noReading()).toBe(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(noReading()).toBe(1)
    // A new conversation in the folder now is not taken by inference.
    const later = rollout(today(sessions), ID_C, '/p/demo', new Date(Date.now() + 10).toISOString(), 4)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(taker.claims.map((c) => c.id)).toEqual([ID_A])
    // Its own hook still claims exactly.
    expect(taker.src.noteExactRollout!(later)?.id).toBe(ID_C)
    expect(taker.claims.map((c) => c.id)).toEqual([ID_A, ID_C])
    taker.src.stop(); owner.src.stop()
  })
})
