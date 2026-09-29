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
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {} }))

const { createAppSessionDurability } = await import('../../../src/main/app-session-durability')

const CONV = '019dd000-0001-7000-8000-0000000000e1'

beforeEach(() => {
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
})
