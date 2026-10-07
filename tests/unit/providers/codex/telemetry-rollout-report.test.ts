// P3.12 (rows 31, 32, 65): the rollout watcher tells onRollout the rollout it
// claimed (its path, as the watcher's own checks found it inside the realm, the
// realm's sessions folder, whether the conversation is known exactly and whether
// another session holds it) every time it tells onClaim or onShared, and null
// every time it lets a claim go. The Codex log binder, the name file and the
// GitHub Session Context read the session's conversation from this, never from
// a path anyone else hands them. Real files in a temp folder; fake timers.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join, dirname, basename } from 'path'
import { tmpdir } from 'os'
import { watchAndClaimRollout } from '../../../../src/main/providers/codex/telemetry'
import { makeCodexLogBinder } from '../../../../src/main/logging/codex-log-binder'

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
type Report = { path: string; sessionsDir: string; exact: boolean; shared: boolean; identity?: string } | null
// Round 1 (A1): each report names the claimed file's identity (dev:ino).
const idOf = (f: string) => { const st = lstatSync(f, { bigint: true }); return `${st.dev}:${st.ino}` }
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
    expect(w.reports).toEqual([{ path: file, sessionsDir: sessions, exact: false, shared: false, identity: idOf(file) }])
    w.src.noteExactRollout!(file)
    expect(w.reports.at(-1)).toEqual({ path: file, sessionsDir: sessions, exact: true, shared: false, identity: idOf(file) })
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
      { path: a, sessionsDir: sessions, exact: false, shared: false, identity: idOf(a) },
      null,
      { path: b, sessionsDir: sessions, exact: true, shared: false, identity: idOf(b) },
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
    expect(first.reports).toEqual([{ path: file, sessionsDir: sessions, exact: true, shared: false, identity: idOf(file) }])
    const second = watch(sessions, '/p/demo', { resumeId: ID_A })
    await vi.advanceTimersByTimeAsync(1100)
    expect(second.reports).toEqual([{ path: file, sessionsDir: sessions, exact: true, shared: true, identity: idOf(file) }])
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

  it('round 1 (B1): a tab whose own hook named a conversation another tab only inferred is its holder once that claim is refuted: told again, not shared', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const a = watch(sessions, '/p/demo')
    const b = watch(sessions, '/p/demo')
    const x = rollout(today(sessions), ID_A, '/p/demo', new Date(Date.now() + 50).toISOString())
    await vi.advanceTimersByTimeAsync(400)
    // One of the two inferred it; the other names it from its own hook.
    const [inferred, own] = a.reports.length ? [a, b] : [b, a]
    expect(own.src.noteExactRollout!(x)).not.toBeNull()
    expect(own.reports.at(-1)).toEqual({ path: x, sessionsDir: sessions, exact: true, shared: true, identity: idOf(x) })
    // Nothing to re-check while the other still holds it.
    expect(own.src.recheckShared!()).toBe(false)
    expect(inferred.src.refuteInferredClaim!(x)).toBe(true)
    expect(own.src.recheckShared!()).toBe(true)
    expect(own.reports.at(-1)).toEqual({ path: x, sessionsDir: sessions, exact: true, shared: false, identity: idOf(x) })
    expect(own.src.recheckShared!()).toBe(false)
    a.src.stop(); b.src.stop()
  })

  it('round 1 (B1): with the real binder, the tab whose own Codex started the conversation is indexed once the other tab\x27s inferred claim is refuted', async () => {
    vi.useFakeTimers()
    const sessions = realm()
    const calls: unknown[][] = []
    const binder = makeCodexLogBinder({
      supervisor: { bindTranscript: (...x: unknown[]) => { calls.push(['bind', ...x]) }, unbindTranscript: (...x: unknown[]) => { calls.push(['unbind', ...x]) } },
      writeName: () => {}, rememberedName: () => null, forgetName: () => {},
    })
    const start = (sid: string) => {
      binder.beginLaunch(sid)
      const src = watchAndClaimRollout(sid, '/p/demo', Date.now(), () => {}, sessions, undefined, { onRollout: (r) => binder.noteRollout(sid, r) })
      binder.startRun(sid, true)
      return src
    }
    const A = start('A')
    const B = start('B')
    const x = rollout(today(sessions), ID_A, '/p/demo', new Date(Date.now() + 50).toISOString())
    await vi.advanceTimersByTimeAsync(300)
    const [inferredSid, own, other] = calls.some((c) => c[1] === 'A') ? ['A', B, A] : ['B', A, B]
    expect(own.noteExactRollout!(x)).not.toBeNull()
    expect(other.refuteInferredClaim!(x)).toBe(true)
    // What pty-manager does next (noteCodexHookEvent): the named session's watcher is re-checked.
    expect(own.recheckShared!()).toBe(true)
    const ownSid = inferredSid === 'A' ? 'B' : 'A'
    expect(calls.filter((c) => c[1] === ownSid)).toEqual([['bind', ownSid, x, 'exact', undefined, 'codex-rollout', idOf(x)]])
    expect(binder.exactRollout(ownSid)).toEqual({ path: x, sessionsDir: sessions })
    A.stop(); B.stop()
  })
})
