/**
 * P3.12 (rows 31 and 32): the Codex log binder turns what a Codex session's own
 * rollout watcher claims into the run's transcript binds, as Claude's binder
 * turns its exact sources into binds:
 *  - held from the launch until the run is recorded (a resume claims before
 *    runStart; a Restart reuses the session id), then bound;
 *  - exact (resume by id, a pick, the session's own hook) or heuristic (folder
 *    and time); a hook confirming an inferred claim re-binds as exact, never
 *    the other way;
 *  - a claim let go retires its tail; a conversation another tab holds is not
 *    indexed here (as Claude refuses a conversation another live session holds);
 *  - no run recorded (logging off for the session): nothing bound;
 *  - the name file: an exact claim writes a name remembered for the session and
 *    forgets it (Claude's onExactBind); exactRollout is what a rename writes
 *    against, never an inferred or shared claim.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { makeCodexLogBinder } from '../../../src/main/logging/codex-log-binder'

type Call = [string, ...unknown[]]
let calls: Call[]
let names: Map<string, string>
let written: Array<[string, string, string]>
let binder: ReturnType<typeof makeCodexLogBinder>
const P1 = '/realm/sessions/2026/09/29/rollout-2026-09-29T10-00-00-019dd000-0001-7000-8000-00000000000a.jsonl'
const SD = '/realm/sessions'
const P2 = '/realm/sessions/2026/09/29/rollout-2026-09-29T10-05-00-019dd000-0001-7000-8000-00000000000b.jsonl'

beforeEach(() => {
  calls = []
  names = new Map()
  written = []
  binder = makeCodexLogBinder({
    supervisor: {
      bindTranscript: (...a: unknown[]) => { calls.push(['bind', ...a]) },
      unbindTranscript: (...a: unknown[]) => { calls.push(['unbind', ...a]) },
    },
    writeName: (p, d, n) => { written.push([p, d, n]) },
    rememberedName: (sid) => names.get(sid) ?? null,
    forgetName: (sid) => { names.delete(sid) },
  })
})

describe('the Codex log binder (P3.12)', () => {
  it('a claim before the run is recorded is held, and bound once it is (a resume claims before runStart)', () => {
    binder.beginLaunch('s')
    binder.noteRollout('s', { path: P1, sessionsDir: SD, exact: true, shared: false })
    expect(calls).toEqual([])
    binder.startRun('s', true)
    expect(calls).toEqual([['bind', 's', P1, 'exact', undefined, 'codex-rollout']])
  })

  it('an inferred claim binds heuristic; the hook confirming it re-binds exact; the same claim again binds nothing more', () => {
    binder.beginLaunch('s')
    binder.startRun('s', true)
    binder.noteRollout('s', { path: P1, sessionsDir: SD, exact: false, shared: false })
    binder.noteRollout('s', { path: P1, sessionsDir: SD, exact: false, shared: false })
    binder.noteRollout('s', { path: P1, sessionsDir: SD, exact: true, shared: false })
    binder.noteRollout('s', { path: P1, sessionsDir: SD, exact: true, shared: false })
    // Never downgraded.
    binder.noteRollout('s', { path: P1, sessionsDir: SD, exact: false, shared: false })
    expect(calls).toEqual([
      ['bind', 's', P1, 'heuristic', undefined, 'codex-rollout'],
      ['bind', 's', P1, 'exact', undefined, 'codex-rollout'],
    ])
  })

  it('a claim let go retires its tail; the next claim binds (the worker rotates to it)', () => {
    binder.beginLaunch('s')
    binder.startRun('s', true)
    binder.noteRollout('s', { path: P1, sessionsDir: SD, exact: false, shared: false })
    binder.noteRollout('s', null)
    binder.noteRollout('s', null)
    binder.noteRollout('s', { path: P2, sessionsDir: SD, exact: true, shared: false })
    expect(calls).toEqual([
      ['bind', 's', P1, 'heuristic', undefined, 'codex-rollout'],
      ['unbind', 's', P1],
      ['bind', 's', P2, 'exact', undefined, 'codex-rollout'],
    ])
  })

  it('a conversation another tab holds is not indexed here, and is not what a rename names', () => {
    binder.beginLaunch('s')
    binder.startRun('s', true)
    binder.noteRollout('s', { path: P1, sessionsDir: SD, exact: true, shared: true })
    expect(calls).toEqual([])
    expect(binder.exactRollout('s')).toBeNull()
  })

  it('logging off for the session (no run recorded): nothing is bound, the claim is still known for the name file', () => {
    binder.beginLaunch('s')
    binder.startRun('s', false)
    binder.noteRollout('s', { path: P1, sessionsDir: SD, exact: true, shared: false })
    binder.noteRollout('s', null)
    expect(calls).toEqual([])
    binder.noteRollout('s', { path: P2, sessionsDir: SD, exact: true, shared: false })
    expect(binder.exactRollout('s')).toEqual({ path: P2, sessionsDir: SD })
  })

  it('a new launch of the session (Restart, Switch) starts clean: the old claim is not bound into the new run', () => {
    binder.beginLaunch('s')
    binder.startRun('s', true)
    binder.noteRollout('s', { path: P1, sessionsDir: SD, exact: true, shared: false })
    binder.beginLaunch('s')
    expect(binder.exactRollout('s')).toBeNull()
    binder.startRun('s', true)
    expect(calls).toEqual([['bind', 's', P1, 'exact', undefined, 'codex-rollout']])
    binder.noteRollout('s', { path: P1, sessionsDir: SD, exact: true, shared: false })
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(['bind', 's', P1, 'exact', undefined, 'codex-rollout'])
  })

  it('endRun forgets the session', () => {
    binder.beginLaunch('s')
    binder.startRun('s', true)
    binder.noteRollout('s', { path: P1, sessionsDir: SD, exact: true, shared: false })
    expect(binder.knows('s')).toBe(true)
    binder.endRun('s')
    expect(binder.knows('s')).toBe(false)
    expect(binder.exactRollout('s')).toBeNull()
  })

  it('the name file (row 32): an exact claim writes a name remembered for the session, once, and forgets it; an inferred one does not', () => {
    names.set('s', 'My work')
    binder.beginLaunch('s')
    binder.noteRollout('s', { path: P1, sessionsDir: SD, exact: false, shared: false })
    expect(written).toEqual([])
    expect(binder.exactRollout('s')).toBeNull()
    binder.noteRollout('s', { path: P1, sessionsDir: SD, exact: true, shared: false })
    expect(written).toEqual([[P1, SD, 'My work']])
    expect(names.has('s')).toBe(false)
    expect(binder.exactRollout('s')).toEqual({ path: P1, sessionsDir: SD })
    // A later conversation is not given that name (Claude's #536 rule).
    binder.noteRollout('s', null)
    binder.noteRollout('s', { path: P2, sessionsDir: SD, exact: true, shared: false })
    expect(written).toEqual([[P1, SD, 'My work']])
  })

  it('a claim for a session it never saw launch is held until its run is recorded', () => {
    binder.noteRollout('x', { path: P1, sessionsDir: SD, exact: true, shared: false })
    expect(calls).toEqual([])
    binder.startRun('x', true)
    expect(calls).toEqual([['bind', 'x', P1, 'exact', undefined, 'codex-rollout']])
  })

  it('stays bounded: the oldest session is let go past the cap', () => {
    for (let i = 0; i < 600; i++) binder.beginLaunch(`s${i}`)
    expect(binder.knows('s0')).toBe(false)
    expect(binder.knows('s599')).toBe(true)
  })

  it('a listener that throws never breaks a claim', () => {
    const b = makeCodexLogBinder({
      supervisor: { bindTranscript: () => { throw new Error('down') }, unbindTranscript: () => { throw new Error('down') } },
      writeName: () => { throw new Error('disk') },
      rememberedName: () => 'n',
      forgetName: () => {},
    })
    b.beginLaunch('s')
    b.startRun('s', true)
    expect(() => b.noteRollout('s', { path: P1, sessionsDir: SD, exact: true, shared: false })).not.toThrow()
    expect(() => b.noteRollout('s', null)).not.toThrow()
  })
})

describe('the Codex log binder, P3.12 round 1', () => {
  it('A1: the claim\'s file identity rides on the bind; the same path with another file binds again', () => {
    binder.beginLaunch('s')
    binder.startRun('s', true)
    binder.noteRollout('s', { path: P1, sessionsDir: SD, exact: true, shared: false, identity: '7:1' })
    binder.noteRollout('s', { path: P1, sessionsDir: SD, exact: true, shared: false, identity: '7:1' })
    binder.noteRollout('s', { path: P1, sessionsDir: SD, exact: true, shared: false, identity: '7:2' })
    expect(calls).toEqual([
      ['bind', 's', P1, 'exact', undefined, 'codex-rollout', '7:1'],
      ['bind', 's', P1, 'exact', undefined, 'codex-rollout', '7:2'],
    ])
  })

  it('V1: indexing stopped for a running session (the logging switch turned off): later claims bind nothing; the name file still follows an exact claim', () => {
    names.set('s', 'Kept name')
    binder.beginLaunch('s')
    binder.startRun('s', true)
    binder.noteRollout('s', { path: P1, sessionsDir: SD, exact: false, shared: false })
    binder.stopIndexing('s')
    binder.noteRollout('s', { path: P2, sessionsDir: SD, exact: true, shared: false })
    expect(calls).toEqual([['bind', 's', P1, 'heuristic', undefined, 'codex-rollout']])
    expect(written).toEqual([[P2, SD, 'Kept name']])
    // A session it never saw: nothing happens.
    expect(() => binder.stopIndexing('nobody')).not.toThrow()
  })
})

describe('P3.12 (X1): a conversation written while not indexed rides on its bind, and is cleared once bound', () => {
  it('a bind carries what is known of the conversation; a bound one is cleared; a bind without the file identity clears nothing', () => {
    const calls: unknown[][] = []
    const marks = new Map<string, { since?: number; ifBegunBefore?: number }>([['/r/s.jsonl', { since: 1234 }], ['/r/u.jsonl', { since: 9 }]])
    const cleared: string[] = []
    const b = makeCodexLogBinder({
      supervisor: { bindTranscript: (...a: unknown[]) => { calls.push(['bind', ...a]) }, unbindTranscript: () => {} },
      writeName: () => {}, rememberedName: () => null, forgetName: () => {},
      notIndexed: { lookup: (p) => marks.get(p) ?? null, bound: (p) => { cleared.push(p); marks.delete(p) } },
    })
    for (const sid of ['s', 't']) {
      b.beginLaunch(sid)
      b.startRun(sid, true)
      b.noteRollout(sid, { path: `/r/${sid}.jsonl`, sessionsDir: '/r', exact: true, shared: false, identity: '7:1' })
    }
    b.beginLaunch('u')
    b.startRun('u', true)
    b.noteRollout('u', { path: '/r/u.jsonl', sessionsDir: '/r', exact: true, shared: false })
    expect(calls).toEqual([
      ['bind', 's', '/r/s.jsonl', 'exact', undefined, 'codex-rollout', '7:1', { since: 1234 }],
      ['bind', 't', '/r/t.jsonl', 'exact', undefined, 'codex-rollout', '7:1'],
      ['bind', 'u', '/r/u.jsonl', 'exact', undefined, 'codex-rollout'],
    ])
    expect(cleared).toEqual(['/r/s.jsonl', '/r/t.jsonl'])
    expect(marks.get('/r/u.jsonl')).toEqual({ since: 9 })
  })
})
