// P3.5 fix round 1, item B: what a Codex status-line watcher reads. It used
// to read the whole rollout every half second before comparing sizes, and a
// resumed conversation's rollout can be many megabytes. Now: the size first,
// only what the rollout gained, and at a claim its head and its tail. A
// conversation another session holds is not walked for every second, and no
// link is followed on the way to a new rollout (thesis 4). Real files in a
// temp folder; fake timers.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { watchAndClaimRollout, __codexRolloutBytesReadForTests, CLAIM_HEAD_BYTES, CLAIM_TAIL_BYTES } from '../../../../src/main/providers/codex/telemetry'
import { __codexRolloutLookupsForTests } from '../../../../src/main/providers/codex/rollout-lookup'
import type { StatuslineData } from '../../../../src/shared/types'

const ID = '019dd000-0001-7000-8000-0000000000b1'
const ID2 = '019dd000-0001-7000-8000-0000000000b2'
const temps: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true })
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
function watch(sessions: string, cwd: string, resumeId?: string) {
  const updates: StatuslineData[] = []
  const claims: string[] = []
  const src = watchAndClaimRollout('sess-reads', cwd, Date.now(), (d) => updates.push(d), sessions, undefined,
    { ...(resumeId ? { resumeId } : {}), onClaim: (c) => claims.push(c.id) })
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

  it('a conversation another session holds is not walked for every second; once let go it is taken', async () => {
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
    first.src.stop()
    await vi.advanceTimersByTimeAsync(300)
    second.src.stop()
    expect(second.claims).toEqual([ID2])
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
