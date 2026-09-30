// P3.12 (rows 31, 32, 65): the rollout watcher tells onRollout the rollout it
// claimed (its path, as the watcher's own checks found it inside the realm, the
// realm's sessions folder, whether the conversation is known exactly and whether
// another session holds it) every time it tells onClaim or onShared, and null
// every time it lets a claim go. The Codex log binder, the name file and the
// GitHub Session Context read the session's conversation from this, never from
// a path anyone else hands them. Real files in a temp folder; fake timers.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'
import { watchAndClaimRollout } from '../../../../src/main/providers/codex/telemetry'

const ID_A = '019dd000-0001-7000-8000-00000000000a'
const ID_B = '019dd000-0001-7000-8000-00000000000b'
const pad = (n: number) => String(n).padStart(2, '0')
const temps: string[] = []
afterEach(() => {
  vi.useRealTimers()
  // TEST CLEANUP GUARD: only a folder this file made (its own prefix, directly in the temp folder).
  for (const t of temps.splice(0)) if (dirname(t) === tmpdir() && /^ccc-test-codex-report-/.test(basename(t))) rmSync(t, { recursive: true, force: true })
})
function realm(): string {
  const base = mkdtempSync(join(tmpdir(), 'ccc-test-codex-report-'))
  temps.push(base)
  return join(base, 'sessions')
}
function today(sessions: string): string {
  const d = new Date()
  const dir = join(sessions, String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate()))
  mkdirSync(dir, { recursive: true })
  return dir
}
function rollout(dir: string, id: string, cwd: string, iso: string): string {
  const file = join(dir, `rollout-${iso.slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`)
  writeFileSync(file, JSON.stringify({ timestamp: iso, type: 'session_meta', payload: { id, timestamp: iso, cwd, cli_version: '0.155.1' } }) + '\n', 'utf-8')
  return file
}
type Report = { path: string; sessionsDir: string; exact: boolean; shared: boolean } | null
function watch(sessions: string, cwd: string, opts: { resumeId?: string } = {}) {
  const reports: Report[] = []
  const events: string[] = []
  const src = watchAndClaimRollout('sess', cwd, Date.now(), () => {}, sessions, undefined, {
    ...opts,
    onClaim: () => { events.push('claim') },
    onShared: () => { events.push('shared') },
    onRelease: () => { events.push('release') },
    onRollout: (r) => { reports.push(r ? { ...r } : null); events.push(r ? 'rollout' : 'rollout:null') },
  })
  return { reports, events, src }
}

describe('the watcher reports the rollout it claimed (P3.12)', () => {
  it('an inferred claim: its path and realm, not exact; the hook confirming it: told again, exact', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const w = watch(sessions, '/p/demo')
    const file = rollout(today(sessions), ID_A, '/p/demo', new Date(Date.now() + 50).toISOString())
    await vi.advanceTimersByTimeAsync(400)
    expect(w.reports).toEqual([{ path: file, sessionsDir: sessions, exact: false, shared: false }])
    w.src.noteExactRollout!(file)
    expect(w.reports.at(-1)).toEqual({ path: file, sessionsDir: sessions, exact: true, shared: false })
    expect(w.events).toEqual(['claim', 'rollout', 'claim', 'rollout'])
    w.src.stop()
  })

  it('a claim let go (the hook names another rollout): null, then the new rollout, exact', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const dir = today(sessions)
    const w = watch(sessions, '/p/demo')
    const a = rollout(dir, ID_A, '/p/demo', new Date(Date.now() + 50).toISOString())
    await vi.advanceTimersByTimeAsync(400)
    const b = rollout(dir, ID_B, '/p/demo', new Date(Date.now() + 60).toISOString())
    w.src.noteExactRollout!(b)
    expect(w.reports).toEqual([
      { path: a, sessionsDir: sessions, exact: false, shared: false },
      null,
      { path: b, sessionsDir: sessions, exact: true, shared: false },
    ])
    expect(w.events).toEqual(['claim', 'rollout', 'release', 'rollout:null', 'claim', 'rollout'])
    w.src.stop()
  })

  it('a resume by id of a conversation another watcher holds: reported shared (and exact)', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const file = rollout(today(sessions), ID_A, '/p/demo', new Date(Date.now() - 1000).toISOString())
    const first = watch(sessions, '/p/demo', { resumeId: ID_A })
    await vi.advanceTimersByTimeAsync(1100)
    expect(first.reports).toEqual([{ path: file, sessionsDir: sessions, exact: true, shared: false }])
    const second = watch(sessions, '/p/demo', { resumeId: ID_A })
    await vi.advanceTimersByTimeAsync(1100)
    expect(second.reports).toEqual([{ path: file, sessionsDir: sessions, exact: true, shared: true }])
    expect(second.events).toEqual(['shared', 'rollout'])
    first.src.stop()
    second.src.stop()
  })

  it('a path a hook names that is not a rollout of this realm is never reported', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const w = watch(sessions, '/p/demo')
    const elsewhere = join(dirname(sessions), 'other', `rollout-2026-09-29T10-00-00-${ID_A}.jsonl`)
    mkdirSync(dirname(elsewhere), { recursive: true })
    writeFileSync(elsewhere, JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { id: ID_A, cwd: '/p/demo' } }) + '\n')
    expect(w.src.noteExactRollout!(elsewhere)).toBeNull()
    await vi.advanceTimersByTimeAsync(400)
    expect(w.reports).toEqual([])
    w.src.stop()
  })
})
