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
// answers true only for a saved session.
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import type { SessionState } from '../../../src/main/session-state'

const h = vi.hoisted(() => ({ resourcesDir: '' }))

// Fixer 10 (ADR-009 C2): a .bak held by another program (a scanner, a sync
// tool) cannot be removed or written over while `bakLocked` is on; with
// `bakGone`, it is gone by the time it is removed (ENOENT); otherwise the
// real fs.
const fault = vi.hoisted(() => ({ bakLocked: false, bakGone: false }))
vi.mock('fs', async (orig) => {
  const real = await orig<typeof import('fs')>()
  const busy = () => Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
  const unlinkSync = ((p: Parameters<typeof real.unlinkSync>[0]) => {
    if (fault.bakLocked && String(p).endsWith('.bak')) throw busy()
    if (fault.bakGone && String(p).endsWith('.bak')) throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' })
    return real.unlinkSync(p)
  }) as typeof real.unlinkSync
  const copyFileSync = ((s: Parameters<typeof real.copyFileSync>[0], d: Parameters<typeof real.copyFileSync>[1], m?: number) => {
    if (fault.bakLocked && String(d).endsWith('.bak')) throw busy()
    return real.copyFileSync(s, d, m)
  }) as typeof real.copyFileSync
  return { ...real, unlinkSync, copyFileSync, default: { ...real, unlinkSync, copyFileSync } }
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
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logError: () => {}, logWarn: () => {} }))
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

describe('the durability core: a clear keeps main\'s running times (fixer 9 A1)', () => {
  type Times = Array<{ id: string; ms: number; until: number }>
  function core(times: () => Times, save: (s: SessionState) => boolean = () => true) {
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
      log,
    })
    return { d, save: saveFn, log, logged: () => log.mock.calls.map((c) => String(c[0])).join('\n') }
  }

  it('a clear writes main\'s running times back on their own: no sessions, nothing of the discarded set', () => {
    const t: Times = [{ id: CONV, ms: 149_000, until: 1_000 }]
    const { d, save } = core(() => t)
    d.saveEnriched(theSet())
    save.mockClear()
    d.noteCleared()
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
    d.noteCleared()
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
    d.noteCleared()
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
    expect(() => d.noteCleared()).not.toThrow()
    expect(() => d.flushOnExit('before-quit')).not.toThrow()
    expect(save).not.toHaveBeenCalled()
  })

  it('a write that fails or is refused (the read-failure latch) is logged and never throws', () => {
    const t: Times = [{ id: CONV, ms: 149_000, until: 1_000 }]
    const failing = core(() => t, () => { throw new Error('disk gone') })
    expect(() => failing.d.noteCleared()).not.toThrow()
    expect(() => failing.d.flushOnExit('before-quit')).not.toThrow()
    expect(failing.logged()).toMatch(/running times[^\n]*failed: disk gone/)
    const refused = core(() => t, () => false)
    refused.d.noteCleared()
    expect(refused.logged()).toMatch(/running times[^\n]*REFUSED/)
  })

  it('a save after the clear is a set again: the exit flush writes it whole', () => {
    const t: Times = [{ id: CONV, ms: 149_000, until: 1_000 }]
    const { d, save } = core(() => t)
    d.saveEnriched(theSet())
    d.noteCleared()
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
    expect(log.mock.calls.filter((c) => /could not be removed/.test(String(c[0])))).toHaveLength(1)
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
    fault.bakLocked = false
    fault.bakGone = false
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

  it('"Close sessions": the next run has the conversation\'s running time, including the run that ended after the clear', () => {
    const now = Date.now()
    noteConversationRunningTime(CONV, 149_000, now - 6_000)
    const d = createAppSessionDurability()
    expect(d.saveEnriched(theSet())).toBe(true)
    // index.ts's session:clear handler.
    const cleared = clearSessionState()
    expect(cleared).toEqual({ ok: true, bakRemoved: true })
    d.noteCleared(cleared.bakRemoved)
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
    const cleared = clearSessionState()
    expect(cleared).toEqual({ ok: true, bakRemoved: true })
    run2.d.noteCleared(cleared.bakRemoved)
    // No exit flush: the app is stopped hard.

    const run3 = nextRun()
    expect(run3.loaded?.sessions).toEqual([])
    expect(conversationRunningTime(CONV)).toMatchObject({ ms: 149_000, until: now })
  })

  it('no running time kept (Claude only): a clear leaves no file, as before', () => {
    const d = createAppSessionDurability()
    d.saveEnriched(theSet())
    expect(existsSync(file())).toBe(true)
    expect(clearSessionState().ok).toBe(true)
    d.noteCleared(true)
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
    let cleared: ReturnType<typeof clearSessionState>
    try {
      cleared = clearSessionState()
      d.noteCleared(cleared.bakRemoved)
      d.flushOnExit('before-quit')
    } finally {
      fault.bakLocked = false
    }
    if (existsSync(file())) writeFileSync(file(), '{"sessions": [')
    const { loaded } = nextRun()
    expect(loaded?.sessions ?? []).toEqual([])
    expect(cleared).toEqual({ ok: true, bakRemoved: false })
    // The copy is still there, behind no file: never read without one.
    expect(readFileSync(file() + '.bak', 'utf8')).toMatch(/Orchard/)
    expect(hasSavedSessionState()).toBe(false)
  })

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

  // Fixer 10 (gate 3 quality nit 2): session:hasSaved says whether there is a
  // saved session to restore, as a load would offer it; a file that keeps only
  // the conversations' running times holds none.
  it('session:hasSaved answers true only when a session is saved', () => {
    expect(hasSavedSessionState()).toBe(false)
    noteConversationRunningTime(CONV, 149_000, Date.now())
    const d = createAppSessionDurability()
    d.saveEnriched(theSet())
    expect(hasSavedSessionState()).toBe(true)
    expect(clearSessionState().ok).toBe(true)
    d.noteCleared(true)
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

  it('index.ts tells the core of every successful clear, and whether a copy of the set was left (the wiring the fix rides on)', () => {
    const index = readFileSync(join(__dirname, '../../../src/main/index.ts'), 'utf8')
    expect(index).toMatch(/ipcMain\.handle\('session:clear', async \(\) => \{\s*const cleared = clearSessionState\(\)[\s\S]{0,600}?if \(cleared\.ok\) sessionDurability\.noteCleared\(cleared\.bakRemoved\)\s*return cleared\.ok\s*\}\)/)
  })
})
