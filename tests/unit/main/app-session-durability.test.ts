// P3.6 (ADR-009 round 2 quality nit): the app's session durability core as
// main composes it (src/main/app-session-durability.ts), with main's live
// sources replaced: the session:load step hands the loaded state to
// pty-manager's read-back, and a save stamps the conversations main keeps.
// The core itself is session-durability.test.ts's; the read-back itself is
// launch-handoff-pty.test.ts's (kept across a relaunch).
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SessionState } from '../../../src/main/session-state'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const h = vi.hoisted(() => ({
  loaded: null as unknown,
  saved: [] as unknown[],
  readBack: [] as unknown[],
  uncertain: [] as string[],
  kept: new Map<string, { uuid: string; cwd: string }>(),
  /** P3.7: main's conversation running times, and what was handed to their read-back. */
  times: [] as Array<{ id: string; ms: number; until: number }>,
  timesReadBack: [] as unknown[],
  uncertainReadBackThrows: false,
}))

vi.mock('../../../src/main/session-state', () => ({
  loadSessionState: () => h.loaded,
  saveSessionState: (s: unknown) => { h.saved.push(s); return true },
}))
vi.mock('../../../src/main/pty-manager', () => ({
  getKeptCodexConversation: (id: string) => h.kept.get(id),
  uncertainCodexConversationIds: () => [...h.uncertain],
  rememberUncertainCodexConversationsFrom: (state: unknown) => { h.readBack.push(state); if (h.uncertainReadBackThrows) throw new Error('unreadable') },
}))
vi.mock('../../../src/main/conversation-running-time', () => ({
  conversationRunningTimesForSave: () => [...h.times],
  rememberConversationRunningTimesFrom: (state: unknown) => { h.timesReadBack.push(state) },
}))
vi.mock('../../../src/main/hooks', () => ({ isExactBindSourceActive: () => true }))
vi.mock('../../../src/main/logging/logging-service', () => ({ getTranscriptBinder: () => null }))
vi.mock('../../../src/main/logging/transcript-discovery', () => ({ resolveResumeTargetFromTranscript: () => null }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logWarn: () => {} }))

const { createAppSessionDurability } = await import('../../../src/main/app-session-durability')
const { claimConfigLaunch, _resetConfigLaunchClaimsForTest } = await import('../../../src/main/launch-one-at-a-time')

const CONV = '019dd000-0001-7000-8000-0000000000e1'

beforeEach(() => {
  _resetConfigLaunchClaimsForTest()
  h.loaded = null
  h.saved = []
  h.readBack = []
  h.uncertain = []
  h.kept.clear()
  h.times = []
  h.timesReadBack = []
  h.uncertainReadBackThrows = false
})

describe('the app\'s session durability core, as main composes it', () => {
  // The session:load IPC is this core's load step, so the read-back runs on it.
  it('index.ts: session:load returns sessionDurability.load()', () => {
    const index = readFileSync(resolve(__dirname, '../../../src/main/index.ts'), 'utf8')
    expect(index).toMatch(/ipcMain\.handle\('session:load', async \(\) => \{\s*return sessionDurability\.load\(\)\s*\}\)/)
  })

  it('load: the saved state is returned, and handed to main\'s read-back once', () => {
    const state = { sessions: [], activeSessionId: null, savedAt: 1 } as unknown as SessionState
    h.loaded = state
    const d = createAppSessionDurability()
    expect(d.load()).toBe(state)
    expect(h.readBack).toEqual([state])
    // P3.7: and to the read-back of the conversations' running time.
    expect(h.timesReadBack).toEqual([state])
  })

  it('load: the running times are read back even when the uncertain list cannot be', () => {
    const state = { sessions: [], activeSessionId: null, savedAt: 1 } as unknown as SessionState
    h.loaded = state
    h.uncertainReadBackThrows = true
    const d = createAppSessionDurability()
    expect(d.load()).toBe(state)
    expect(h.timesReadBack).toEqual([state])
  })

  it('load with nothing saved: null, and the read-back is handed null', () => {
    const d = createAppSessionDurability()
    expect(d.load()).toBeNull()
    expect(h.readBack).toEqual([null])
  })

  it('save: a session is stamped with the conversation main keeps for it, and main\'s list of uncertain claims is saved with it', () => {
    h.kept.set('s1', { uuid: CONV, cwd: 'C:/p' })
    h.uncertain = [CONV]
    const d = createAppSessionDurability()
    expect(d.saveEnriched({ sessions: [{ id: 's1', provider: 'codex' }], activeSessionId: 's1', savedAt: 1 } as unknown as SessionState)).toBe(true)
    expect(h.saved).toHaveLength(1)
    expect(h.saved[0]).toMatchObject({ sessions: [{ id: 's1', resumeUuid: CONV, resumeCwd: 'C:/p' }], codexUncertainConversations: [CONV] })
  })

  it('save: main\'s running time of each conversation is saved with it (P3.7)', () => {
    h.times = [{ id: CONV, ms: 61_000, until: 5 }]
    const d = createAppSessionDurability()
    expect(d.saveEnriched({ sessions: [], activeSessionId: null, savedAt: 1 } as unknown as SessionState)).toBe(true)
    expect(h.saved[0]).toMatchObject({ conversationRunningTimes: [{ id: CONV, ms: 61_000, until: 5 }] })
  })

  // P3.13 round 1 (M1): the sessions this load brings back keep their right to
  // run beside another copy of a config that is not Multi Spawn, read from the
  // saved state by main (never a flag the renderer sends). The gate itself is
  // launch-one-at-a-time.test.ts's; the spawn handler's is
  // pty-spawn-one-at-a-time-rights.test.ts's.
  /** A gate whose live copies are the ones the test names. */
  function gate(liveIds: string[] = []) {
    const live = new Set<string>(liveIds)
    return { live, deps: { savedConfigs: () => [{ id: 'c1', label: 'App Dev', allowMultiSpawn: false }], isLive: (id: string) => live.has(id) } }
  }
  /** The gate's answer as the refusal, or null when the spawn may go ahead. */
  const ask = (id: string, deps: ReturnType<typeof gate>['deps']) => {
    const c = claimConfigLaunch(id, { configId: 'c1' }, deps)
    return 'refused' in c ? c.refused : null
  }

  it('load: the saved sessions are the ones the one-at-a-time rule lets run, and a new tab is still refused', () => {
    h.loaded = { sessions: [{ id: 'r1', configId: 'c1' }, { id: 'r2', configId: 'c1' }], activeSessionId: null, savedAt: 1 } as unknown as SessionState
    createAppSessionDurability().load()
    const { live, deps } = gate()
    for (const id of ['r1', 'r2']) { expect(ask(id, deps)).toBeNull(); live.add(id) }
    expect(ask('n1', deps)).toMatchObject({ code: 'already-running' })
  })

  it('load: the remotes left running are restored too, and only the first load of the run seeds', () => {
    h.loaded = { sessions: [], activeSessionId: null, savedAt: 1, detachedRemotes: [{ sessionId: 'd1', configId: 'c1' }] } as unknown as SessionState
    createAppSessionDurability().load()
    h.loaded = { sessions: [{ id: 'later', configId: 'c1' }], activeSessionId: null, savedAt: 2 } as unknown as SessionState
    createAppSessionDurability().load()
    const { live, deps } = gate()
    expect(ask('other', deps)).toBeNull(); live.add('other')
    expect(ask('d1', deps)).toBeNull()
    expect(ask('later', deps)).toMatchObject({ code: 'already-running' })
  })

  it('load: a read of the other records that fails does not stop the seeding', () => {
    h.loaded = { sessions: [{ id: 'r1', configId: 'c1' }], activeSessionId: null, savedAt: 1 } as unknown as SessionState
    h.uncertainReadBackThrows = true
    createAppSessionDurability().load()
    const { live, deps } = gate()
    expect(ask('other', deps)).toBeNull(); live.add('other')
    expect(ask('r1', deps)).toBeNull()
  })

  it('load with nothing saved seeds nothing and does not use up the one seeding of the run', () => {
    createAppSessionDurability().load()
    h.loaded = { sessions: [{ id: 'r1', configId: 'c1' }], activeSessionId: null, savedAt: 1 } as unknown as SessionState
    createAppSessionDurability().load()
    const { live, deps } = gate()
    expect(ask('other', deps)).toBeNull(); live.add('other')
    expect(ask('r1', deps)).toBeNull()
  })
})
