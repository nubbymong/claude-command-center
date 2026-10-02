// P3.7 (review follow-up, reworked after CI at 427807fb): a run's running
// time is kept as its status line updates and when the run is over, at once
// (no longer after its background count). Should keeping it ever throw, the
// failure is logged and goes no further: the status line still updates, and
// neither the watch nor its end throws. The store is replaced here so that
// keeping a time throws on demand. Real files in a temp folder; no Codex, no
// process.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync, promises as fsPromises } from 'fs'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'
import type { StatuslineData } from '../../../../src/shared/types'

const h = vi.hoisted(() => ({ throwOnKeep: false }))
vi.mock('../../../../src/main/conversation-running-time', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../src/main/conversation-running-time')>()
  return {
    ...real,
    noteConversationRunningTime: (...args: Parameters<typeof real.noteConversationRunningTime>) => {
      if (h.throwOnKeep) throw new Error('the store failed')
      real.noteConversationRunningTime(...args)
    },
  }
})

const { watchAndClaimRollout, __codexCountsSettledForTests, CLAIM_HEAD_BYTES, CLAIM_TAIL_BYTES } = await import('../../../../src/main/providers/codex/telemetry')

const ID = '019dd000-0001-7000-8000-0000000000e7'
const temps: string[] = []
afterEach(async () => {
  h.throwOnKeep = false
  vi.useRealTimers()
  vi.restoreAllMocks()
  await __codexCountsSettledForTests()
  // Only a folder this file made (its own prefix, directly in the temp folder) is removed.
  for (const t of temps.splice(0)) if (dirname(t) === tmpdir() && /^ccc-test-codex-settle-/.test(basename(t))) rmSync(t, { recursive: true, force: true })
})

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (t: number) => new Date(t).toISOString()
const metaLine = (t: number) => JSON.stringify({ timestamp: iso(t), type: 'session_meta', payload: { id: ID, timestamp: iso(t), cwd: '/p/demo', cli_version: '0.155.1' } })
const tokenLine = (t: number, input: number) => JSON.stringify({ timestamp: iso(t), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: input + 1 } }, rate_limits: null } })

/** A response line of about 1 KB, which nothing here counts. */
const fillerLine = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(900) }] } })

/** A rollout of conversation ID in a temp folder this file made; `large`:
 *  bigger than a head and a tail, so its middle is counted in the background. */
function rollout(large = false): { sessions: string; file: string } {
  const base = mkdtempSync(join(tmpdir(), 'ccc-test-codex-settle-'))
  temps.push(base)
  const sessions = join(base, 'sessions')
  const now = new Date()
  const day = join(sessions, String(now.getUTCFullYear()), pad(now.getUTCMonth() + 1), pad(now.getUTCDate()))
  mkdirSync(day, { recursive: true })
  const file = join(day, `rollout-x-${ID}.jsonl`)
  const middle = large ? Array.from({ length: Math.ceil((CLAIM_HEAD_BYTES + CLAIM_TAIL_BYTES + 256 * 1024) / (fillerLine.length + 1)) }, () => fillerLine).join('\n') + '\n' : ''
  writeFileSync(file, metaLine(Date.now()) + '\n' + middle + tokenLine(Date.now(), 5) + '\n')
  return { sessions, file }
}

/** Fixer 10: the background count's open is held until `done()`, so its
 *  turns stay uncounted for as long as a case needs (as in
 *  telemetry-duration.test.ts). */
function holdCountOpens() {
  const realOpen = fsPromises.open
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  let opens = 0
  const spy = vi.spyOn(fsPromises, 'open').mockImplementation((async (...args: Parameters<typeof fsPromises.open>) => {
    opens++
    await gate
    return realOpen.apply(fsPromises, args)
  }) as typeof fsPromises.open)
  return { opens: () => opens, done: () => { release(); spy.mockRestore() } }
}

describe('a run\'s time that cannot be kept', () => {
  it('is logged once; the status line still updates, and neither the watch nor its end throws', async () => {
    vi.useFakeTimers()
    const { sessions, file } = rollout()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.throwOnKeep = true
    const updates: StatuslineData[] = []
    const src = watchAndClaimRollout('sess-x', '/p/demo', Date.now(), (d) => updates.push(d), sessions, undefined, { resumeId: ID })
    expect(updates.at(-1)).toMatchObject({ inputTokens: 5, totalDurationMs: 0 })
    appendFileSync(file, tokenLine(Date.now(), 9) + '\n')
    await vi.advanceTimersByTimeAsync(500)
    expect(updates.at(-1)).toMatchObject({ inputTokens: 9, totalDurationMs: 500 })
    expect(() => src.stop()).not.toThrow()
    // Three keeps failed (the claim, the update, the end): one warning.
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('could not be kept')).length).toBe(1)
  })

  // Fixer 9 A2: one warning per run while the store keeps failing (a keep runs
  // on every status line update); a keep that works clears it, so the next
  // failure is said again. A new run starts with none said.
  it('warns once per run while it keeps failing, again after a keep that works, and again for a new run', async () => {
    vi.useFakeTimers()
    const { sessions, file } = rollout()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const warned = () => warn.mock.calls.filter((c) => String(c[0]).includes('could not be kept')).length
    h.throwOnKeep = true
    const src = watchAndClaimRollout('sess-y', '/p/demo', Date.now(), () => {}, sessions, undefined, { resumeId: ID })
    for (const n of [6, 7, 8]) {
      appendFileSync(file, tokenLine(Date.now(), n) + '\n')
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(warned()).toBe(1)
    h.throwOnKeep = false
    appendFileSync(file, tokenLine(Date.now(), 10) + '\n')
    await vi.advanceTimersByTimeAsync(500)
    expect(warned()).toBe(1)
    h.throwOnKeep = true
    appendFileSync(file, tokenLine(Date.now(), 11) + '\n')
    await vi.advanceTimersByTimeAsync(500)
    expect(warned()).toBe(2)
    src.stop()
    expect(warned()).toBe(2)
    // A new run of the conversation (another launch): its first failure is said.
    const next = watchAndClaimRollout('sess-z', '/p/demo', Date.now(), () => {}, sessions, undefined, { resumeId: ID })
    expect(warned()).toBe(3)
    next.stop()
    expect(warned()).toBe(3)
  })

  // Fixer 10 (ADR-009 D4, T1): a large rollout's run is kept without the
  // turns its background count has not landed; a keep that works there
  // clears the warning too, so the next failure is said.
  it('a large rollout while its count runs: a keep that fails, works, then fails again is warned of twice', async () => {
    vi.useFakeTimers()
    const { sessions, file } = rollout(true)
    const held = holdCountOpens()
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const warned = () => warn.mock.calls.filter((c) => String(c[0]).includes('could not be kept')).length
      h.throwOnKeep = true
      const src = watchAndClaimRollout('sess-l', '/p/demo', Date.now(), () => {}, sessions, undefined, { resumeId: ID })
      expect(held.opens()).toBe(1)
      expect(warned()).toBe(1)
      appendFileSync(file, tokenLine(Date.now(), 6) + '\n')
      await vi.advanceTimersByTimeAsync(500)
      expect(warned()).toBe(1)
      h.throwOnKeep = false
      appendFileSync(file, tokenLine(Date.now(), 7) + '\n')
      await vi.advanceTimersByTimeAsync(500)
      h.throwOnKeep = true
      appendFileSync(file, tokenLine(Date.now(), 8) + '\n')
      await vi.advanceTimersByTimeAsync(500)
      // Still uncounted all along: every keep took the large rollout's branch.
      expect(held.opens()).toBe(1)
      expect(warned()).toBe(2)
      src.stop()
      expect(warned()).toBe(2)
    } finally {
      held.done()
      await __codexCountsSettledForTests()
    }
  })

  // Fixer 10 (ADR-009 D4, T3): the warning is per run, not per watch. One
  // watch that lets its claim go and claims the conversation again starts a
  // new run, whose first failure is said.
  it('one watch that lets its claim go and claims again: the new run\'s first failure is warned of', async () => {
    vi.useFakeTimers()
    const { sessions, file } = rollout()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const warned = () => warn.mock.calls.filter((c) => String(c[0]).includes('could not be kept')).length
    h.throwOnKeep = true
    const releases: number[] = []
    const src = watchAndClaimRollout('sess-r', '/p/demo', Date.now(), () => {}, sessions, undefined, { resumeId: ID, onRelease: () => releases.push(1) })
    expect(warned()).toBe(1)
    // A copy of the conversation put at the claimed path (written aside,
    // renamed over it): the claim is let go, then the conversation is
    // claimed again by the same rules.
    const other = file + '.new'
    writeFileSync(other, metaLine(Date.now()) + '\n' + tokenLine(Date.now(), 7) + '\n')
    renameSync(other, file)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(releases).toEqual([1])
    expect(warned()).toBe(2)
    src.stop()
    expect(warned()).toBe(2)
  })
})
