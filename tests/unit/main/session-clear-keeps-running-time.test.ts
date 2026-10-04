// P3.7 (row 36), fixer 9 A1 (the VM gate 6 FAIL): a Codex conversation's
// running time (idle included) is main's (conversation-running-time.ts) and
// was saved only inside session-state.json, which a clear deletes ("Close
// sessions", "Don't open", the window closed with no tabs). A later resume of
// the conversation then showed only the turns its rollout records ("2m 29s"
// became "2s"). Claude Code keeps its Duration in the conversation's own
// transcript (a cost-state entry its CLI restores when it resumes), which no
// choice about the app's tabs removes. So a clear discards the session set,
// never main's records kept with it: they are written back on their own (a
// state with no sessions), at the clear and at every exit flush until the next
// save. The core is tested with a stand-in save; the round trip uses the real
// session file in a temp folder this file makes. No process is started.
// Fixer 10 (ADR-009 C2): a clear that could not remove the discarded set's
// .bak keeps nothing until the next save, so no current file sits in front of
// that copy (a damaged one would bring the set back); session:hasSaved
// answers true only for a saved session. Fixer 11 (ADR-009 round 2): the
// session:clear path is the core's clear, which drops the cache whatever the
// clear did; a save whose copy over the .bak fails removes the older .bak.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import type { SessionState } from '../../../src/main/session-state'

const h = vi.hoisted(() => ({ resourcesDir: '', logs: [] as string[] }))

// Fixer 10 (ADR-009 C2): a .bak held by another program (a scanner, a sync
// tool) cannot be removed or written over while `bakLocked` is on; with
// `bakGone`, it is gone by the time it is removed (ENOENT); otherwise the
// real fs. Fixer 11: `bakUnlink` fails its removal with that code (EPERM and
// EACCES are what Windows gives for a held file); `bakCopy` fails only the
// copy over it (held for writing, but removable); `mainUnlink` fails the
// session file's own removal; `readBusy` fails reading the session file.
const fault = vi.hoisted(() => ({ bakLocked: false, bakGone: false, bakUnlink: null as null | string, bakCopy: false, mainUnlink: false, readBusy: false }))
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  const failing = (code: string) => Object.assign(new Error(`${code}: the file is held`), { code })
  const busy = () => failing('EBUSY')
  const isMain = (p: unknown) => String(p).endsWith('session-state.json')
  const unlinkSync = ((p: Parameters<typeof real.unlinkSync>[0]) => {
    if (fault.bakLocked && String(p).endsWith('.bak')) throw busy()
    if (fault.bakGone && String(p).endsWith('.bak')) throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    if (fault.bakUnlink && String(p).endsWith('.bak')) throw failing(fault.bakUnlink)
    if (fault.mainUnlink && isMain(p)) throw busy()
    return real.unlinkSync(p)
  }) as typeof real.unlinkSync
  const copyFileSync = ((s: Parameters<typeof real.copyFileSync>[0], d: Parameters<typeof real.copyFileSync>[1], m?: number) => {
    if ((fault.bakLocked || fault.bakCopy) && String(d).endsWith('.bak')) throw busy()
    return real.copyFileSync(s, d, m)
  }) as typeof real.copyFileSync
  const readFileSync = ((p: Parameters<typeof real.readFileSync>[0], o?: Parameters<typeof real.readFileSync>[1]) => {
    if (fault.readBusy && isMain(p)) throw busy()
    return real.readFileSync(p, o)
  }) as typeof real.readFileSync
  return { ...real, unlinkSync, copyFileSync, readFileSync, default: { ...real, unlinkSync, copyFileSync, readFileSync } }
})

// The real session file, in this file's temp folder (no folder hardening).
vi.mock('../../../src/main/config-manager', async () => {
  const path = await import('node:path')
  const fs = await import('node:fs')
  return {
    getConfigDir: () => path.join(h.resourcesDir, 'CONFIG'),
    ensureConfigDir: () => { fs.mkdirSync(path.join(h.resourcesDir, 'CONFIG'), { recursive: true }) },
    migrateConfigToProviderShape: (s: unknown) => s,
  }
})
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: (m: string) => { h.logs.push(String(m)) }, logError: (m: string) => { h.logs.push(String(m)) }, logWarn: () => {} }))
// main's other live sources, as app-session-durability.test.ts replaces them.
vi.mock('../../../src/main/pty-manager', () => ({
  getKeptCodexConversation: () => undefined,
  uncertainCodexConversationIds: () => [],
  rememberUncertainCodexConversationsFrom: () => {},
}))
vi.mock('../../../src/main/hooks', () => ({ isExactBindSourceActive: () => true }))
vi.mock('../../../src/main/logging/logging-service', () => ({ getTranscriptBinder: () => null }))
vi.mock('../../../src/main/logging/transcript-discovery', () => ({ resolveResumeTargetFromTranscript: () => null }))

const { createSessionDurability } = await import('../../../src/main/session-durability')
const { createAppSessionDurability } = await import('../../../src/main/app-session-durability')
const { clearSessionState, loadSessionState, hasSavedSessionState } = await import('../../../src/main/session-state')
const {
  noteConversationRunningTime,
  conversationRunningTime,
  __resetConversationRunningTimesForTests,
} = await import('../../../src/main/conversation-running-time')

const CONV = '019dd000-0001-7000-8000-0000000000a1'

/** The saved set: one Codex tab, with what a clear must not keep. */
const theSet = (): SessionState =>
  ({ sessions: [{ id: 's1', provider: 'codex', name: 'Orchard', cwd: 'C:/work/orchard' }], activeSessionId: 's1', savedAt: 1 } as unknown as SessionState)
/** Fixer 11: a set saved after a clear. */
const freshSet = (): SessionState =>
  ({ sessions: [{ id: 's2', provider: 'codex', name: 'Quarry', cwd: 'C:/work/quarry' }], activeSessionId: 's2', savedAt: 2 } as unknown as SessionState)

describe('the durability core: a clear keeps main\'s running times (fixer 9 A1)', () => {
  type Times = Array<{ id: string; ms: number; until: number }>
  type Cleared = { ok: boolean; bakRemoved: boolean }
  function core(times: () => Times, save: (s: SessionState) => boolean = () => true, clear?: () => Cleared) {
    const saveFn = vi.fn(save)
    const log = vi.fn()
    const d = createSessionDurability({
      enrichDeps: {
        getExactResumeTarget: () => null,
        getLatestTranscriptPath: () => null,
        isExactBindSourceActive: () => true,
        resolveResumeTargetFromTranscript: () => null,
        getProviderResumeTarget: () => ({ uuid: CONV, cwd: 'C:/work/orchard' }),
        getUncertainProviderConversations: () => [CONV],
        getConversationRunningTimes: times,
      },
      save: saveFn,
      ...(clear ? { clear } : {}),
      log,
    })
    return { d, save: saveFn, log, logged: () => log.mock.calls.map((c) => String(c[0])).join('\n') }
  }

  // Fixer 11 (ADR-009 lens D round 2, finding 4; pre-existing): the
  // session:clear path drops the cache whatever the clear did. A clear that
  // failed (the file could not be removed) or was refused leaves a copy of
  // the set on disk, so, as for a .bak left, nothing is written until the
  // next save: before, the exit flush wrote the discarded set back.
  for (const [what, report] of [
    ['failed (the file could not be removed)', { ok: false, bakRemoved: false }],
    ['removed the file but not its .bak', { ok: true, bakRemoved: false }],
  ] as const) {
    it(`a clear that ${what}: the cache is dropped and nothing is written until the next save`, () => {
      const t: Times = [{ id: CONV, ms: 149_000, until: 1_000 }]
      const { d, save, logged } = core(() => t, () => true, () => report)
      d.saveEnriched(theSet())
      save.mockClear()
      expect(d.clear()).toBe(report.ok)
      expect(d.peek()).toBeNull()
      d.flushOnExit('before-quit')
      expect(save).not.toHaveBeenCalled()
      expect(logged()).toMatch(/still on disk/)
    })
  }

  it('a clear that removed every copy keeps main\'s running times, and one that throws counts as failed', () => {
    const t: Times = [{ id: CONV, ms: 149_000, until: 1_000 }]
    const done = core(() => t, () => true, () => ({ ok: true, bakRemoved: true }))
    done.d.saveEnriched(theSet())
    done.save.mockClear()
    expect(done.d.clear()).toBe(true)
    expect(done.save).toHaveBeenCalledTimes(1)
    expect(done.save.mock.calls[0][0]).toEqual({ sessions: [], activeSessionId: null, savedAt: expect.any(Number), conversationRunningTimes: t })
    const broken = core(() => t, () => true, () => { throw new Error('disk gone') })
    broken.d.saveEnriched(theSet())
    broken.save.mockClear()
    expect(broken.d.clear()).toBe(false)
    broken.d.flushOnExit('before-quit')
    expect(broken.save).not.toHaveBeenCalled()
    expect(broken.logged()).toMatch(/clear[^\n]*failed: disk gone/)
  })

  it('a clear writes main\'s running times back on their own: no sessions, nothing of the discarded set', () => {
    const t: Times = [{ id: CONV, ms: 149_000, until: 1_000 }]
    const { d, save } = core(() => t)
    d.saveEnriched(theSet())
    save.mockClear()
    d.noteCleared(true)
    expect(save).toHaveBeenCalledTimes(1)
    const written = save.mock.calls[0][0]
    expect(written).toEqual({ sessions: [], activeSessionId: null, savedAt: expect.any(Number), conversationRunningTimes: t })
    expect(Object.keys(written).sort()).toEqual(['activeSessionId', 'conversationRunningTimes', 'savedAt', 'sessions'])
    expect(JSON.stringify(written)).not.toMatch(/Orchard|orchard|"s1"/)
    // F1 still holds: the discarded set is not what the exit flush holds.
    expect(d.peek()).toBeNull()
  })

  it('the exit flush after a clear writes main\'s latest times (a run settled after the clear), never the discarded set', () => {
    let t: Times = [{ id: CONV, ms: 149_000, until: 1_000 }]
    const { d, save } = core(() => t)
    d.saveEnriched(theSet())
    d.noteCleared(true)
    save.mockClear()
    // "Close sessions" ends the sessions after the clear: the run settles then.
    t = [{ id: CONV, ms: 155_000, until: 7_000 }]
    d.flushOnExit('before-quit')
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toEqual({ sessions: [], activeSessionId: null, savedAt: expect.any(Number), conversationRunningTimes: t })
    expect(d.peek()).toBeNull()
  })

  it('with no running time kept, a clear and the exit flush write nothing: the file stays cleared, as before', () => {
    const { d, save } = core(() => [])
    d.saveEnriched(theSet())
    save.mockClear()
    d.noteCleared(true)
    d.flushOnExit('before-quit')
    expect(save).not.toHaveBeenCalled()
  })

  it('a flush with nothing saved or cleared this run writes nothing, times kept or not', () => {
    const { d, save } = core(() => [{ id: CONV, ms: 1, until: 1 }])
    d.flushOnExit('before-quit')
    expect(save).not.toHaveBeenCalled()
  })

  it('main\'s list that cannot be read writes nothing, and neither the clear nor the flush throws', () => {
    const { d, save } = core(() => { throw new Error('store gone') })
    d.saveEnriched(theSet())
    save.mockClear()
    expect(() => d.noteCleared(true)).not.toThrow()
    expect(() => d.flushOnExit('before-quit')).not.toThrow()
    expect(save).not.toHaveBeenCalled()
  })

  it('a write that fails or is refused (the read-failure latch) is logged and never throws', () => {
    const t: Times = [{ id: CONV, ms: 149_000, until: 1_000 }]
    const failing = core(() => t, () => { throw new Error('disk gone') })
    expect(() => failing.d.noteCleared(true)).not.toThrow()
    expect(() => failing.d.flushOnExit('before-quit')).not.toThrow()
    expect(failing.logged()).toMatch(/running times[^\n]*failed: disk gone/)
    const refused = core(() => t, () => false)
    refused.d.noteCleared(true)
    expect(refused.logged()).toMatch(/running times[^\n]*REFUSED/)
  })

  it('a save after the clear is a set again: the exit flush writes it whole', () => {
    const t: Times = [{ id: CONV, ms: 149_000, until: 1_000 }]
    const { d, save } = core(() => t)
    d.saveEnriched(theSet())
    d.noteCleared(true)
    d.saveEnriched(theSet())
    save.mockClear()
    d.flushOnExit('before-quit')
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toMatchObject({ sessions: [{ id: 's1', resumeUuid: CONV }], conversationRunningTimes: t })
  })

  // Fixer 10 (ADR-009 C2): the .bak of the discarded set could not be
  // removed. A file written now would put a current file in front of that
  // copy, which a damaged one would bring back, so nothing is kept (at the
  // clear or at any exit flush) until the next save, and that is said once.
  it('a clear that left a copy of the discarded set writes nothing until the next save, and says so once', () => {
    const t: Times = [{ id: CONV, ms: 149_000, until: 1_000 }]
    const { d, save, log } = core(() => t)
    d.saveEnriched(theSet())
    save.mockClear()
    d.noteCleared(false)
    d.flushOnExit('before-quit')
    d.flushOnExit('will-quit')
    expect(save).not.toHaveBeenCalled()
    expect(log.mock.calls.filter((c) => /still on disk/.test(String(c[0])))).toHaveLength(1)
    expect(d.peek()).toBeNull()
    // The next save is a set again, and the exit flush writes it whole.
    d.saveEnriched(theSet())
    d.flushOnExit('before-quit')
    expect(save).toHaveBeenCalledTimes(2)
    expect(save.mock.calls[1][0]).toMatchObject({ sessions: [{ id: 's1' }] })
    // A later clear that removed every copy keeps the times again.
    save.mockClear()
    d.noteCleared(true)
    d.flushOnExit('before-quit')
    expect(save).toHaveBeenCalledTimes(2)
    for (const c of save.mock.calls) expect(c[0]).toEqual({ sessions: [], activeSessionId: null, savedAt: expect.any(Number), conversationRunningTimes: t })
  })

  // Fixer 11 (gate 3 quality nit 3, ADR-009 lens C nit): the report is
  // required; a call without one (possible only around the types) counts as
  // a copy left, never as a clear that removed everything.
  it('noteCleared without a report writes nothing', () => {
    const t: Times = [{ id: CONV, ms: 149_000, until: 1_000 }]
    const { d, save } = core(() => t)
    d.saveEnriched(theSet())
    save.mockClear()
    ;(d.noteCleared as (bakRemoved?: boolean) => void)()
    d.flushOnExit('before-quit')
    expect(save).not.toHaveBeenCalled()
  })

  // The owner's 2026-10-04 answer (pre-existing since #397, recorded at the
  // PR 3 closeout): a clear that leaves a copy of the discarded set on disk
  // (the session file held by a scanner, or its .bak) is retried at each later
  // save and exit flush until it removes every copy; a save that succeeds ends
  // the retry, since the saved state replaces the set. Until then nothing the
  // core writes or loads brings the set back. A clear that succeeds does what
  // it always did.
  /** A clear that fails `failures` times, then removes every copy. */
  function clearFailing(failures: number) {
    let calls = 0
    const fn = vi.fn((): Cleared => (++calls <= failures ? { ok: false, bakRemoved: false } : { ok: true, bakRemoved: true }))
    return fn
  }

  it('[host] a clear that failed is retried at the next exit flush; once it succeeds the running times are kept, as after a clear that succeeded', () => {
    const t: Times = [{ id: CONV, ms: 149_000, until: 1_000 }]
    const clear = clearFailing(1)
    const { d, save, logged } = core(() => t, () => true, clear)
    d.saveEnriched(theSet())
    save.mockClear()
    expect(d.clear()).toBe(false)
    expect(save).not.toHaveBeenCalled()
    d.flushOnExit('before-quit')
    expect(clear).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toEqual({ sessions: [], activeSessionId: null, savedAt: expect.any(Number), conversationRunningTimes: t })
    expect(logged()).toMatch(/cleared sessions are now removed from disk/)
    // Done: later flushes keep the times without clearing again.
    d.flushOnExit('will-quit')
    expect(clear).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenCalledTimes(2)
    for (const c of save.mock.calls) expect(JSON.stringify(c[0])).not.toMatch(/Orchard|orchard|"s1"/)
  })

  it('[host] until the retried clear succeeds, no exit flush writes anything, and each flush tries again', () => {
    const t: Times = [{ id: CONV, ms: 149_000, until: 1_000 }]
    const clear = clearFailing(Infinity)
    const { d, save, logged } = core(() => t, () => true, clear)
    d.saveEnriched(theSet())
    save.mockClear()
    d.clear()
    for (const why of ['powerMonitor suspend', 'before-quit', 'will-quit']) d.flushOnExit(why)
    expect(clear).toHaveBeenCalledTimes(4)
    expect(save).not.toHaveBeenCalled()
    expect(d.peek()).toBeNull()
    expect(logged()).toMatch(/still on disk after a retry on exit flush on will-quit/)
  })

  it('[host] a save that succeeds ends the retry: the saved state replaces the set', () => {
    const t: Times = [{ id: CONV, ms: 149_000, until: 1_000 }]
    const clear = clearFailing(Infinity)
    const { d, save } = core(() => t, () => true, clear)
    d.saveEnriched(theSet())
    d.clear()
    save.mockClear()
    expect(d.saveEnriched(freshSet())).toBe(true)
    d.flushOnExit('before-quit')
    d.flushOnExit('will-quit')
    expect(clear).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledTimes(3)
    for (const c of save.mock.calls) expect(c[0]).toMatchObject({ sessions: [{ id: 's2' }] })
  })

  it('[host] after that save a load reads the saved state and clears nothing (the new file is never taken for the set)', () => {
    const clear = clearFailing(Infinity)
    const fresh = freshSet()
    const load = vi.fn((): SessionState | null => fresh)
    const enrichDeps = { getExactResumeTarget: () => null, getLatestTranscriptPath: () => null, isExactBindSourceActive: () => true, resolveResumeTargetFromTranscript: () => null }
    const d = createSessionDurability({ enrichDeps, save: () => true, load, clear })
    d.saveEnriched(theSet())
    d.clear()
    expect(d.saveEnriched(fresh)).toBe(true)
    expect(d.load()).toBe(fresh)
    expect(load).toHaveBeenCalledTimes(1)
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('[host] a save that fails while the clear is pending retries the clear (the file still holds the discarded set)', () => {
    const t: Times = [{ id: CONV, ms: 149_000, until: 1_000 }]
    const clear = clearFailing(1)
    let accept = false
    const { d, save } = core(() => t, () => accept, clear)
    d.saveEnriched(theSet())
    d.clear()
    expect(clear).toHaveBeenCalledTimes(1)
    expect(d.saveEnriched(freshSet())).toBe(false)
    expect(clear).toHaveBeenCalledTimes(2)
    // The clear is done; the next flush saves the fresh set and clears nothing.
    accept = true
    save.mockClear()
    d.flushOnExit('before-quit')
    expect(clear).toHaveBeenCalledTimes(2)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toMatchObject({ sessions: [{ id: 's2' }] })
  })

  it('[host] a load while the clear is pending retries it first, and never hands back the discarded set', () => {
    const readBack = vi.fn()
    const load = vi.fn((): SessionState | null => theSet())
    const enrichDeps = { getExactResumeTarget: () => null, getLatestTranscriptPath: () => null, isExactBindSourceActive: () => true, resolveResumeTargetFromTranscript: () => null }
    // Still held: the load answers as the clear would have (nothing saved),
    // without reading the file.
    const held = clearFailing(Infinity)
    const a = createSessionDurability({ enrichDeps, save: () => true, load, clear: held, readBack })
    a.clear()
    expect(a.load()).toBeNull()
    expect(held).toHaveBeenCalledTimes(2)
    expect(load).not.toHaveBeenCalled()
    expect(readBack).toHaveBeenCalledWith(null)
    // Released by the time of the load: the retry removes it, then the load reads.
    load.mockImplementation(() => null)
    const released = clearFailing(1)
    const b = createSessionDurability({ enrichDeps, save: () => true, load, clear: released, readBack })
    b.clear()
    expect(b.load()).toBeNull()
    expect(released).toHaveBeenCalledTimes(2)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('[host] a clear that succeeds first time is never retried, at a flush, a save or a load', () => {
    const t: Times = [{ id: CONV, ms: 149_000, until: 1_000 }]
    const clear = clearFailing(0)
    const { d, save } = core(() => t, () => true, clear)
    d.saveEnriched(theSet())
    save.mockClear()
    expect(d.clear()).toBe(true)
    expect(save).toHaveBeenCalledTimes(1)
    d.flushOnExit('before-quit')
    d.load()
    d.saveEnriched(freshSet())
    expect(clear).toHaveBeenCalledTimes(1)
  })
})

describe('the VM repro as a round trip through the real session file (fixer 9 A1)', () => {
  const PREFIX = 'ccc-test-clear-times-'
  let tmp = ''
  const file = () => join(tmp, 'CONFIG', 'session-state.json')

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), PREFIX))
    h.resourcesDir = tmp
  })
  beforeEach(() => {
    Object.assign(fault, { bakLocked: false, bakGone: false, bakUnlink: null, bakCopy: false, mainUnlink: false, readBusy: false })
    h.logs.length = 0
    rmSync(file(), { force: true })
    rmSync(file() + '.bak', { force: true })
    __resetConversationRunningTimesForTests()
    // A successful load resets the read-failure latch between cases.
    loadSessionState()
  })
  afterAll(() => {
    // Only the folder this file made: its own prefix, directly in the temp folder.
    if (tmp && dirname(tmp) === tmpdir() && basename(tmp).startsWith(PREFIX)) rmSync(tmp, { recursive: true, force: true })
  })

  /** A new run of the app: main keeps nothing until the saved state is loaded. */
  function nextRun() {
    __resetConversationRunningTimesForTests()
    const d = createAppSessionDurability()
    return { d, loaded: d.load() }
  }
  const names = (s: SessionState | null) => (s?.sessions ?? []).map((x) => (x as unknown as { name: string }).name)

  it('"Close sessions": the next run has the conversation\'s running time, including the run that ended after the clear', () => {
    const now = Date.now()
    noteConversationRunningTime(CONV, 149_000, now - 6_000)
    const d = createAppSessionDurability()
    expect(d.saveEnriched(theSet())).toBe(true)
    // index.ts's session:clear handler (fixer 11: the core's clear).
    expect(d.clear()).toBe(true)
    // The session is ended after the clear; its run settles as its process ends.
    noteConversationRunningTime(CONV, 155_000, now)
    d.flushOnExit('before-quit')

    const { loaded } = nextRun()
    expect(loaded?.sessions).toEqual([])
    expect(conversationRunningTime(CONV)).toMatchObject({ ms: 155_000, until: now })
    for (const f of [file(), file() + '.bak']) expect(readFileSync(f, 'utf8')).not.toMatch(/Orchard|orchard/)
  })

  it('"Don\'t open": the times read at the start survive the clear, even when the app then stops without a flush', () => {
    const now = Date.now()
    noteConversationRunningTime(CONV, 149_000, now)
    createAppSessionDurability().saveEnriched(theSet())

    const run2 = nextRun()
    expect(run2.loaded?.sessions).toHaveLength(1)
    expect(run2.d.clear()).toBe(true)
    // No exit flush: the app is stopped hard.

    const run3 = nextRun()
    expect(run3.loaded?.sessions).toEqual([])
    expect(conversationRunningTime(CONV)).toMatchObject({ ms: 149_000, until: now })
  })

  it('no running time kept (Claude only): a clear leaves no file, as before', () => {
    const d = createAppSessionDurability()
    d.saveEnriched(theSet())
    expect(existsSync(file())).toBe(true)
    expect(d.clear()).toBe(true)
    d.flushOnExit('before-quit')
    expect(existsSync(file())).toBe(false)
    expect(existsSync(file() + '.bak')).toBe(false)
  })

  // Fixer 10 (ADR-009 C2, with #397 N1): the .bak is held by another program
  // at "Close sessions" (it cannot be removed or written over), and the
  // session file is damaged before the next run: what a .bak is for.
  it('a clear whose .bak could not be removed writes no file in front of it, so a damaged file never brings the discarded set back', () => {
    noteConversationRunningTime(CONV, 149_000, Date.now())
    const d = createAppSessionDurability()
    expect(d.saveEnriched(theSet())).toBe(true)
    fault.bakLocked = true
    try {
      expect(d.clear()).toBe(true)
      d.flushOnExit('before-quit')
    } finally {
      fault.bakLocked = false
    }
    if (existsSync(file())) writeFileSync(file(), '{"sessions": [')
    const { loaded } = nextRun()
    expect(loaded?.sessions ?? []).toEqual([])
    // The copy is still there, behind no file: never read without one.
    expect(readFileSync(file() + '.bak', 'utf8')).toMatch(/Orchard/)
    expect(hasSavedSessionState()).toBe(false)
  })

  // Fixer 11 (ADR-009 lens D round 2, finding 2): any error but ENOENT on the
  // .bak's removal counts as a .bak left; EPERM and EACCES are what Windows
  // gives for a file another program holds.
  for (const code of ['EBUSY', 'EPERM', 'EACCES']) {
    it(`a .bak whose removal fails with ${code} counts as left: the clear says so and nothing is written in front of it`, () => {
      noteConversationRunningTime(CONV, 149_000, Date.now())
      const d = createAppSessionDurability()
      d.saveEnriched(theSet())
      fault.bakUnlink = code
      try {
        expect(clearSessionState()).toEqual({ ok: true, bakRemoved: false })
        expect(d.clear()).toBe(true)
        d.flushOnExit('before-quit')
      } finally {
        fault.bakUnlink = null
      }
      expect(existsSync(file())).toBe(false)
      expect(readFileSync(file() + '.bak', 'utf8')).toMatch(/Orchard/)
    })
  }

  it('a .bak gone by the time it is removed, or never there, counts as removed', () => {
    const d = createAppSessionDurability()
    d.saveEnriched(theSet())
    fault.bakGone = true
    try {
      expect(clearSessionState()).toEqual({ ok: true, bakRemoved: true })
    } finally {
      fault.bakGone = false
    }
    rmSync(file() + '.bak', { force: true })
    expect(clearSessionState()).toEqual({ ok: true, bakRemoved: true })
  })

  // Fixer 11 (ADR-009 lens D round 2, finding 4; pre-existing): a session file
  // that cannot be removed is a failed clear (ok false), and the discarded
  // set is still not written back by the exit flush: the file on disk is left
  // as it was.
  // The owner's 2026-10-04 answer: while the file is still held, each exit
  // flush retries the clear and writes nothing; the first flush after the hold
  // is released removes the file and its .bak, and keeps the running times.
  it('a session file that cannot be removed: the clear fails, and the exit flush never writes the discarded set back', () => {
    const now = Date.now()
    noteConversationRunningTime(CONV, 149_000, now - 6_000)
    const d = createAppSessionDurability()
    d.saveEnriched(theSet())
    const before = readFileSync(file(), 'utf8')
    fault.mainUnlink = true
    try {
      expect(clearSessionState()).toEqual({ ok: false, bakRemoved: false })
      expect(d.clear()).toBe(false)
      expect(d.peek()).toBeNull()
      // A run settles after the clear; the flush must still write nothing.
      noteConversationRunningTime(CONV, 155_000, now)
      d.flushOnExit('before-quit')
    } finally {
      fault.mainUnlink = false
    }
    expect(readFileSync(file(), 'utf8')).toBe(before)
  })

  it('[host] "Close sessions" with the session file held: the next exit flush after the hold ends removes the set, and the next run is offered nothing', () => {
    const now = Date.now()
    noteConversationRunningTime(CONV, 149_000, now - 6_000)
    const d = createAppSessionDurability()
    d.saveEnriched(theSet())
    fault.mainUnlink = true
    try {
      expect(d.clear()).toBe(false)
    } finally {
      fault.mainUnlink = false
    }
    // Still the discarded set on disk, file and .bak alike.
    expect(readFileSync(file(), 'utf8')).toMatch(/Orchard/)
    expect(readFileSync(file() + '.bak', 'utf8')).toMatch(/Orchard/)
    noteConversationRunningTime(CONV, 155_000, now)
    d.flushOnExit('before-quit')
    for (const f of [file(), file() + '.bak']) if (existsSync(f)) expect(readFileSync(f, 'utf8')).not.toMatch(/Orchard|orchard/)
    const { loaded } = nextRun()
    expect(names(loaded)).toEqual([])
    expect(conversationRunningTime(CONV)).toMatchObject({ ms: 155_000, until: now })
  })

  it('[host] the hold ends only after a new set is saved: that save replaces the discarded set, and nothing is cleared after it', () => {
    noteConversationRunningTime(CONV, 149_000, Date.now())
    const d = createAppSessionDurability()
    d.saveEnriched(theSet())
    fault.mainUnlink = true
    try {
      expect(d.clear()).toBe(false)
      // The user opens new tabs; the autosave lands while the file is held for
      // removal but can be written over.
      expect(d.saveEnriched(freshSet())).toBe(true)
    } finally {
      fault.mainUnlink = false
    }
    d.flushOnExit('before-quit')
    expect(names(nextRun().loaded)).toEqual(['Quarry'])
  })

  // Fixer 11 (ADR-009 R2-3, pre-existing since #397): a save whose copy over
  // the .bak fails used to leave the older .bak, which a damaged file then
  // brought back: a set cleared since among them. It is removed now.
  it('a save whose .bak copy fails removes the older .bak, so a damaged file never brings back a set cleared before it', () => {
    noteConversationRunningTime(CONV, 149_000, Date.now())
    const d = createAppSessionDurability()
    d.saveEnriched(theSet())
    fault.bakLocked = true
    try {
      expect(d.clear()).toBe(true)
    } finally {
      fault.bakLocked = false
    }
    // At the next save the .bak is still held for writing, but can be removed.
    fault.bakCopy = true
    try {
      expect(d.saveEnriched(freshSet())).toBe(true)
    } finally {
      fault.bakCopy = false
    }
    expect(existsSync(file() + '.bak')).toBe(false)
    expect(h.logs.some((l) => /mirror copy failed/.test(l))).toBe(true)
    writeFileSync(file(), '{"sessions": [')
    expect(names(nextRun().loaded)).not.toContain('Orchard')
  })

  it('a .bak that can be neither copied over nor removed at a save is left, and the log says what it holds', () => {
    const d = createAppSessionDurability()
    d.saveEnriched(theSet())
    fault.bakLocked = true
    try {
      expect(d.saveEnriched(freshSet())).toBe(true)
    } finally {
      fault.bakLocked = false
    }
    expect(readFileSync(file() + '.bak', 'utf8')).toMatch(/Orchard/)
    expect(h.logs.some((l) => /could not be removed either/.test(l))).toBe(true)
  })

  // Fixer 10 (gate 3 quality nit 2): session:hasSaved says whether there is a
  // saved session to restore, as a load would offer it; a file that keeps only
  // the conversations' running times holds none.
  it('session:hasSaved answers true only when a session is saved', () => {
    expect(hasSavedSessionState()).toBe(false)
    noteConversationRunningTime(CONV, 149_000, Date.now())
    const d = createAppSessionDurability()
    d.saveEnriched(theSet())
    expect(hasSavedSessionState()).toBe(true)
    // Fixer 11 (ADR-009 lens D round 2, finding 3): a file that cannot be
    // read holds no session to restore, as the load then offers none.
    fault.readBusy = true
    try {
      expect(hasSavedSessionState()).toBe(false)
    } finally {
      fault.readBusy = false
    }
    expect(d.clear()).toBe(true)
    expect(existsSync(file())).toBe(true)
    expect(hasSavedSessionState()).toBe(false)
    // A damaged file: what its .bak holds, as a load would recover it.
    writeFileSync(file() + '.bak', JSON.stringify(theSet()))
    writeFileSync(file(), '{"sessions": [')
    expect(hasSavedSessionState()).toBe(true)
    writeFileSync(file() + '.bak', JSON.stringify({ sessions: [null, 7], activeSessionId: null, savedAt: 1 }))
    expect(hasSavedSessionState()).toBe(false)
    rmSync(file() + '.bak', { force: true })
    expect(hasSavedSessionState()).toBe(false)
    // Only reads: the damaged file is left where it is for the load.
    expect(readFileSync(file(), 'utf8')).toBe('{"sessions": [')
  })

  it('index.ts hands session:clear to the core, which clears and drops the cache whatever the clear did (the wiring the fix rides on)', () => {
    const index = readFileSync(join(__dirname, '../../../src/main/index.ts'), 'utf8')
    expect(index).toMatch(/ipcMain\.handle\('session:clear', async \(\) => sessionDurability\.clear\(\)\)/)
    expect(index).not.toMatch(/clearSessionState/)
    const app = readFileSync(join(__dirname, '../../../src/main/app-session-durability.ts'), 'utf8')
    expect(app).toMatch(/\bclear: \(\) => clearSessionState\(\),/)
  })
})
