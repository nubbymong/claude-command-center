// P3.5 final round (quality nit): the tail re-checks it is still reading the
// claimed file against the identity recorded at the claim. When that record
// could not be made (the file's lstat failed just then), the first read's
// opened file is recorded instead, so the claim is not let go and taken again
// on every read. The failing lstat is simulated for the rollout only.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'

const failLstat = { suffix: '', times: 0 }
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const lstatSync = ((p: unknown, o?: { bigint?: boolean }) => {
    if (o && o.bigint && failLstat.times > 0 && String(p).endsWith(failLstat.suffix)) {
      failLstat.times--
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
    }
    return (actual.lstatSync as (p: unknown, o?: unknown) => unknown)(p, o)
  }) as typeof actual.lstatSync
  return { ...actual, default: { ...actual, lstatSync }, lstatSync }
})

const fs = await import('fs')
const { watchAndClaimRollout } = await import('../../../../src/main/providers/codex/telemetry')

const ID = '019dd000-0001-7000-8000-0000000000e1'
const temps: string[] = []
afterEach(() => {
  vi.useRealTimers()
  failLstat.times = 0
  // Only a folder this file made (its own prefix, directly in the temp folder) is removed.
  for (const t of temps.splice(0)) if (dirname(t) === tmpdir() && /^ccc-test-codex-ident-/.test(basename(t))) fs.rmSync(t, { recursive: true, force: true })
})

const tokenLine = (iso: string, input: number) =>
  JSON.stringify({ timestamp: iso, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0, total_tokens: input + 1 } }, rate_limits: null } })

describe('the claimed file identity, when it could not be recorded at the claim', () => {
  it('is taken from the first read: the claim is kept and followed', async () => {
    vi.useFakeTimers()
    const base = fs.mkdtempSync(join(tmpdir(), 'ccc-test-codex-ident-'))
    temps.push(base)
    const sessions = join(base, 'sessions')
    const at = new Date(Date.now() - 2 * 24 * 3600 * 1000)
    const dir = join(sessions, String(at.getUTCFullYear()), String(at.getUTCMonth() + 1).padStart(2, '0'), String(at.getUTCDate()).padStart(2, '0'))
    fs.mkdirSync(dir, { recursive: true })
    const file = join(dir, `rollout-${at.toISOString().slice(0, 19).replace(/:/g, '-')}-${ID}.jsonl`)
    const meta = JSON.stringify({ timestamp: at.toISOString(), type: 'session_meta', payload: { id: ID, timestamp: at.toISOString(), cwd: '/p/demo', cli_version: '0.155.1' } })
    fs.writeFileSync(file, [meta, tokenLine(at.toISOString(), 10)].join('\n') + '\n')
    failLstat.suffix = `${ID}.jsonl`
    failLstat.times = 1
    const updates: Array<{ inputTokens?: number }> = []
    const claims: Array<{ id: string }> = []
    const releases: number[] = []
    const src = watchAndClaimRollout('sess-ident', '/p/demo', Date.now(), (d) => updates.push(d), sessions, undefined,
      { resumeId: ID, onClaim: (c) => claims.push(c), onRelease: () => releases.push(1) })
    await vi.advanceTimersByTimeAsync(3_000)
    expect(failLstat.times).toBe(0)
    expect(claims).toHaveLength(1)
    expect(releases).toEqual([])
    fs.appendFileSync(file, tokenLine(new Date().toISOString(), 11) + '\n')
    await vi.advanceTimersByTimeAsync(600)
    src.stop()
    expect(releases).toEqual([])
    expect(updates.at(-1)?.inputTokens).toBe(11)
  })
})
