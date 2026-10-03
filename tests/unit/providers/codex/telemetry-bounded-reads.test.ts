// P3.5 fix round 1, item B: what a Codex status-line watcher reads. It used
// to read the whole rollout every half second before comparing sizes, and a
// resumed conversation's rollout can be many megabytes. Now: the size first,
// only what the rollout gained, and at a claim its head and its tail. A
// conversation another session holds is not walked for every second, and no
// link is followed on the way to a new rollout (thesis 4). Real files in a
// temp folder; fake timers.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'
import { watchAndClaimRollout, __codexRolloutBytesReadForTests, __codexCountsSettledForTests, CLAIM_HEAD_BYTES, CLAIM_TAIL_BYTES } from '../../../../src/main/providers/codex/telemetry'
import { __codexRolloutLookupsForTests } from '../../../../src/main/providers/codex/rollout-lookup'
import type { StatuslineData } from '../../../../src/shared/types'

const ID = '019dd000-0001-7000-8000-0000000000b1'
const ID2 = '019dd000-0001-7000-8000-0000000000b2'
const temps: string[] = []
afterEach(async () => {
  vi.useRealTimers()
  // Every background count has let go of its rollout before its folder is removed (CI at 427807fb).
  await __codexCountsSettledForTests()
  // Only a folder this file made (its own prefix, directly in the temp folder) is removed.
  for (const t of temps.splice(0)) if (dirname(t) === tmpdir() && /^ccc-test-codex-reads-/.test(basename(t))) rmSync(t, { recursive: true, force: true })
})

const pad = (n: number) => String(n).padStart(2, '0')
function realm(): string {
  const base = mkdtempSync(join(tmpdir(), 'ccc-test-codex-reads-'))
  temps.push(base)
  return join(base, 'sessions')
}
function dayOf(sessions: string, d: Date): string {
  const dir = join(sessions, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()))
  mkdirSync(dir, { recursive: true })
  return dir
}
const metaLine = (id: string, cwd: string, iso: string) => JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id, timestamp: iso, cwd, cli_version: '0.155.1' } })
const startedLine = (iso: string, window: number) => JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type: 'task_started', model_context_window: window } })
const tokenLine = (iso: string, input: number) => JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: input + 1 } }, rate_limits: null } })
const filler = (bytes: number) => {
  const line = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(900) }] } })
  return Array.from({ length: Math.ceil(bytes / (line.length + 1)) }, () => line).join('\n') + '\n'
}
function watch(sessions: string, cwd: string, resumeId?: string, resumePath?: string) {
  const updates: StatuslineData[] = []
  const claims: string[] = []
  const src = watchAndClaimRollout('sess-reads', cwd, Date.now(), (d) => updates.push(d), sessions, undefined,
    { ...(resumeId ? { resumeId } : {}), ...(resumePath ? { resumePath } : {}), onClaim: (c) => claims.push(c.id) })
  return { updates, claims, src }
}

describe('what a watcher reads of a rollout', () => {
  it('a claim of a large resumed rollout reads its head and tail only, and shows the newest figures', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const old = new Date(Date.now() - 3 * 24 * 3600 * 1000)
    const file = join(dayOf(sessions, old), `rollout-x-${ID}.jsonl`)
    const iso = old.toISOString()
    writeFileSync(file, metaLine(ID, '/p/demo', iso) + '\n' + startedLine(iso, 200_000) + '\n' + filler(5 * 1024 * 1024) + tokenLine(iso, 777) + '\n')
    const before = __codexRolloutBytesReadForTests()
    const { updates, src } = watch(sessions, '/p/demo', ID)
    await vi.advanceTimersByTimeAsync(300)
    src.stop()
    expect(__codexRolloutBytesReadForTests() - before).toBeLessThanOrEqual(CLAIM_HEAD_BYTES + CLAIM_TAIL_BYTES)
    expect(updates.at(-1)).toMatchObject({ inputTokens: 777, contextWindowSize: 200_000 })
  })

  it('after the claim it reads only what the rollout gained, and nothing while it is quiet', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const now = new Date()
    const file = join(dayOf(sessions, now), `rollout-x-${ID}.jsonl`)
    writeFileSync(file, metaLine(ID, '/p/demo', now.toISOString()) + '\n' + tokenLine(now.toISOString(), 5) + '\n')
    const { updates, src } = watch(sessions, '/p/demo', ID)
    await vi.advanceTimersByTimeAsync(600)
    const quiet = __codexRolloutBytesReadForTests()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(__codexRolloutBytesReadForTests()).toBe(quiet)
    const added = tokenLine(new Date().toISOString(), 6) + '\n'
    appendFileSync(file, added)
    await vi.advanceTimersByTimeAsync(600)
    src.stop()
    expect(__codexRolloutBytesReadForTests() - quiet).toBe(Buffer.byteLength(added))
    expect(updates.at(-1)?.inputTokens).toBe(6)
  })

  it('a gain larger than one step is read from the start again, still bounded', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const now = new Date()
    const file = join(dayOf(sessions, now), `rollout-x-${ID}.jsonl`)
    writeFileSync(file, metaLine(ID, '/p/demo', now.toISOString()) + '\n' + tokenLine(now.toISOString(), 5) + '\n')
    const { updates, src } = watch(sessions, '/p/demo', ID)
    await vi.advanceTimersByTimeAsync(600)
    const before = __codexRolloutBytesReadForTests()
    appendFileSync(file, filler(3 * 1024 * 1024) + tokenLine(new Date().toISOString(), 9) + '\n')
    await vi.advanceTimersByTimeAsync(600)
    src.stop()
    expect(__codexRolloutBytesReadForTests() - before).toBeLessThanOrEqual(CLAIM_HEAD_BYTES + CLAIM_TAIL_BYTES)
    expect(updates.at(-1)?.inputTokens).toBe(9)
  })

  // P3.10: a conversation another session holds is read beside it (the P3.7
  // VM finding: both tabs show its figures), so it is found by one walk and
  // never walked for again, held or let go.
  it('a conversation another session holds is not walked for every second; it is read beside the holder, found by one walk', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const old = new Date(Date.now() - 24 * 3600 * 1000)
    writeFileSync(join(dayOf(sessions, old), `rollout-x-${ID2}.jsonl`), metaLine(ID2, '/p/demo', old.toISOString()) + '\n' + tokenLine(old.toISOString(), 3) + '\n')
    const first = watch(sessions, '/p/demo', ID2)
    await vi.advanceTimersByTimeAsync(300)
    expect(first.claims).toEqual([ID2])
    const second = watch(sessions, '/p/demo', ID2)
    await vi.advanceTimersByTimeAsync(300)
    const walks = __codexRolloutLookupsForTests()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(__codexRolloutLookupsForTests()).toBe(walks)
    expect(second.claims).toEqual([])
    expect(second.updates.at(-1)?.inputTokens).toBe(3)
    first.src.stop()
    await vi.advanceTimersByTimeAsync(3_000)
    second.src.stop()
    expect(__codexRolloutLookupsForTests()).toBe(walks)
  })
})

describe('the way to a new rollout (thesis 4)', () => {
  it('a day folder that is a link or junction is not entered', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const now = new Date()
    const outside = join(sessions, '..', 'outside')
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, `rollout-x-${ID}.jsonl`), metaLine(ID, '/p/demo', new Date(Date.now() + 200).toISOString()) + '\n' + tokenLine(now.toISOString(), 4) + '\n')
    const month = join(sessions, String(now.getUTCFullYear()), pad(now.getUTCMonth() + 1))
    mkdirSync(month, { recursive: true })
    symlinkSync(outside, join(month, pad(now.getUTCDate())), 'junction')
    if (now.getDate() !== now.getUTCDate()) symlinkSync(outside, join(month, pad(now.getDate())), 'junction')
    const { claims, src } = watch(sessions, '/p/demo')
    await vi.advanceTimersByTimeAsync(1_000)
    src.stop()
    expect(claims).toEqual([])
  })

  it('a rollout that is a file link is not read', async (ctx) => {
    vi.useFakeTimers()
    const sessions = realm()
    const now = new Date()
    const outside = join(sessions, '..', 'outside.jsonl')
    writeFileSync(outside, metaLine(ID, '/p/demo', new Date(Date.now() + 200).toISOString()) + '\n' + tokenLine(now.toISOString(), 4) + '\n')
    try { symlinkSync(outside, join(dayOf(sessions, now), `rollout-x-${ID}.jsonl`), 'file') } catch { ctx.skip(); return }
    const { claims, src } = watch(sessions, '/p/demo')
    await vi.advanceTimersByTimeAsync(1_000)
    src.stop()
    expect(claims).toEqual([])
  })
})

// P3.5 fix round 2 (quality major 1): the launch hands the watcher the rollout
// it chose, so a resume walks the realm once, not twice.
describe('the rollout the launch chose', () => {
  it('is claimed at once, without walking the realm again', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000)
    const file = join(dayOf(sessions, old), `rollout-x-${ID}.jsonl`)
    writeFileSync(file, metaLine(ID, '/p/demo', old.toISOString()) + '\n' + tokenLine(old.toISOString(), 8) + '\n')
    const walks = __codexRolloutLookupsForTests()
    const { claims, updates, src } = watch(sessions, '/p/demo', ID, file)
    await vi.advanceTimersByTimeAsync(300)
    src.stop()
    expect(claims).toEqual([ID])
    expect(updates.at(-1)?.inputTokens).toBe(8)
    expect(__codexRolloutLookupsForTests()).toBe(walks)
  })

  it('a path that is not in this realm, or names another conversation, is not taken: the watcher looks it up instead', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000)
    const mine = join(dayOf(sessions, old), `rollout-x-${ID}.jsonl`)
    writeFileSync(mine, metaLine(ID, '/p/demo', old.toISOString()) + '\n' + tokenLine(old.toISOString(), 8) + '\n')
    const elsewhere = join(sessions, '..', `rollout-x-${ID}.jsonl`)
    writeFileSync(elsewhere, metaLine(ID, '/p/demo', old.toISOString()) + '\n' + tokenLine(old.toISOString(), 99) + '\n')
    const other = join(dayOf(sessions, old), `rollout-x-${ID2}.jsonl`)
    writeFileSync(other, metaLine(ID2, '/p/demo', old.toISOString()) + '\n' + tokenLine(old.toISOString(), 77) + '\n')
    for (const given of [elsewhere, other]) {
      const walks = __codexRolloutLookupsForTests()
      const { updates, src } = watch(sessions, '/p/demo', ID, given)
      await vi.advanceTimersByTimeAsync(300)
      src.stop()
      expect(updates.at(-1)?.inputTokens).toBe(8)
      expect(__codexRolloutLookupsForTests()).toBe(walks + 1)
    }
  })
})

// P3.5 fix round 2 (quality nit 5): a line that arrives in two reads.
describe('a line split across two reads', () => {
  it('waits for the rest of the line, even inside a multi-byte character, then reads it whole', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const now = new Date()
    const file = join(dayOf(sessions, now), `rollout-x-${ID}.jsonl`)
    writeFileSync(file, metaLine(ID, '/p/demo', now.toISOString()) + '\n' + tokenLine(now.toISOString(), 5) + '\n')
    const { updates, src } = watch(sessions, '/p/demo', ID)
    await vi.advanceTimersByTimeAsync(600)
    const model = 'gpt-5.5-' + String.fromCodePoint(0xfc) + String.fromCodePoint(0x1f600)
    const line = Buffer.from(JSON.stringify({ type: 'turn_context', payload: { model, effort: 'low' } }) + '\n' + tokenLine(new Date().toISOString(), 6) + '\n', 'utf-8')
    // Cut inside the four-byte character.
    const cut = line.indexOf(Buffer.from(String.fromCodePoint(0x1f600), 'utf-8')) + 2
    appendFileSync(file, line.subarray(0, cut))
    await vi.advanceTimersByTimeAsync(600)
    const seen = updates.length
    expect(updates.at(-1)?.inputTokens).toBe(5)
    appendFileSync(file, line.subarray(cut))
    await vi.advanceTimersByTimeAsync(600)
    src.stop()
    expect(updates.length).toBeGreaterThan(seen)
    expect(updates.at(-1)).toMatchObject({ inputTokens: 6, model })
  })
})
