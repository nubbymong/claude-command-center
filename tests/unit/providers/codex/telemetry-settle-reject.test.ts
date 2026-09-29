// P3.7 (review follow-up, reworked after CI at 427807fb): a run's running
// time is kept as its status line updates and when the run is over, at once
// (no longer after its background count). Should keeping it ever throw, the
// failure is logged and goes no further: the status line still updates, and
// neither the watch nor its end throws. The store is replaced here so that
// keeping a time throws on demand. Real files in a temp folder; no Codex, no
// process.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
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

const { watchAndClaimRollout, __codexCountsSettledForTests } = await import('../../../../src/main/providers/codex/telemetry')

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

describe('a run\'s time that cannot be kept', () => {
  it('is logged; the status line still updates, and neither the watch nor its end throws', async () => {
    vi.useFakeTimers()
    const base = mkdtempSync(join(tmpdir(), 'ccc-test-codex-settle-'))
    temps.push(base)
    const sessions = join(base, 'sessions')
    const now = new Date()
    const day = join(sessions, String(now.getUTCFullYear()), pad(now.getUTCMonth() + 1), pad(now.getUTCDate()))
    mkdirSync(day, { recursive: true })
    const file = join(day, `rollout-x-${ID}.jsonl`)
    writeFileSync(file, metaLine(Date.now()) + '\n' + tokenLine(Date.now(), 5) + '\n')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.throwOnKeep = true
    const updates: StatuslineData[] = []
    const src = watchAndClaimRollout('sess-x', '/p/demo', Date.now(), (d) => updates.push(d), sessions, undefined, { resumeId: ID })
    expect(updates.at(-1)).toMatchObject({ inputTokens: 5, totalDurationMs: 0 })
    appendFileSync(file, tokenLine(Date.now(), 9) + '\n')
    await vi.advanceTimersByTimeAsync(500)
    expect(updates.at(-1)).toMatchObject({ inputTokens: 9, totalDurationMs: 500 })
    expect(() => src.stop()).not.toThrow()
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('could not be kept')).length).toBeGreaterThanOrEqual(3)
  })
})
