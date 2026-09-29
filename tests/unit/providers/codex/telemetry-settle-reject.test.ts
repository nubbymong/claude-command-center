// P3.7 (review follow-up): a run's time kept once its background count lands
// (settleRun) is a promise other claims wait on. Should keeping it ever
// throw, the failure is logged and goes no further: no unhandled rejection,
// from the settle itself or from a claim waiting on it. The store is
// replaced here so that keeping a time throws on demand. Real files in a
// temp folder; no Codex, no process.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, promises as fsPromises } from 'fs'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'

const h = vi.hoisted(() => ({ throwOnKeep: false }))
vi.mock('../../../../src/main/conversation-running-time', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../../src/main/conversation-running-time')>()
  return {
    ...real,
    noteConversationRunningTime: (id: string, ms: number, until: number) => {
      if (h.throwOnKeep) throw new Error('the store failed')
      real.noteConversationRunningTime(id, ms, until)
    },
  }
})

const { watchAndClaimRollout } = await import('../../../../src/main/providers/codex/telemetry')

const ID = '019dd000-0001-7000-8000-0000000000e7'
const temps: string[] = []
afterEach(() => {
  h.throwOnKeep = false
  vi.restoreAllMocks()
  // Only a folder this file made (its own prefix, directly in the temp folder) is removed.
  for (const t of temps.splice(0)) if (dirname(t) === tmpdir() && /^ccc-test-codex-settle-/.test(basename(t))) rmSync(t, { recursive: true, force: true })
})

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (t: number) => new Date(t).toISOString()
const metaLine = (t: number) => JSON.stringify({ timestamp: iso(t), type: 'session_meta', payload: { id: ID, timestamp: iso(t), cwd: '/p/demo', cli_version: '0.155.1' } })
const tokenLine = (t: number) => JSON.stringify({ timestamp: iso(t), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 5, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: 6 } }, rate_limits: null } })
const filler = (bytes: number) => {
  const line = JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'x'.repeat(900) }] } })
  return Array.from({ length: Math.ceil(bytes / (line.length + 1)) }, () => line).join('\n') + '\n'
}
/** A rollout too large to read whole, so a claim starts a background count. */
function largeRollout(): string {
  const base = mkdtempSync(join(tmpdir(), 'ccc-test-codex-settle-'))
  temps.push(base)
  const sessions = join(base, 'sessions')
  const t = Date.now() - 3 * 24 * 3600 * 1000
  const d = new Date(t)
  const day = join(sessions, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()))
  mkdirSync(day, { recursive: true })
  writeFileSync(join(day, `rollout-x-${ID}.jsonl`), metaLine(t) + '\n' + filler(3 * 1024 * 1024) + tokenLine(t) + '\n')
  return sessions
}

describe('a run\'s time that cannot be kept once its count lands', () => {
  it('is logged, and neither the settle nor a claim waiting on it rejects unhandled', async () => {
    const sessions = largeRollout()
    const realOpen = fsPromises.open
    let letOpen!: () => void
    const held = new Promise<void>((r) => { letOpen = r })
    let opens = 0
    vi.spyOn(fsPromises, 'open').mockImplementation((async (...args: Parameters<typeof fsPromises.open>) => {
      if (opens++ === 0) await held
      return realOpen.apply(fsPromises, args)
    }) as typeof fsPromises.open)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      // The first run's time waits on its count (held); a relaunch claims meanwhile, waiting on it too.
      const x = watchAndClaimRollout('sess-x', '/p/demo', Date.now(), () => {}, sessions, undefined, { resumeId: ID })
      x.stop()
      const y = watchAndClaimRollout('sess-y', '/p/demo', Date.now(), () => {}, sessions, undefined, { resumeId: ID })
      y.stop()
      // Keeping either time now throws.
      h.throwOnKeep = true
      letOpen()
      await vi.waitFor(() => expect(warn.mock.calls.some((c) => String(c[0]).includes('could not be kept'))).toBe(true), { timeout: 5_000, interval: 20 })
      await new Promise((r) => setTimeout(r, 300))
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      letOpen()
    }
  })
})
