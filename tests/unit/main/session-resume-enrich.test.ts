import { describe, it, expect, vi } from 'vitest'
import { enrichSessionStateWithResumeTargets } from '../../../src/main/session-resume-enrich'
import type { ResumeEnrichDeps } from '../../../src/main/session-resume-enrich'
import type { SessionState } from '../../../src/main/session-state'

// #397 Group 1: main-side enrichment is the single write choke point that stamps
// each Claude session's exact-conversation resume target, so EVERY renderer writer
// persists a resumable record — not only the graceful-close path.
// #480: it must use the EXACT bind (never the heuristic), with a hooks-off
// fallback, so it can never persist a cross-prone guess in the default config.

function state(sessions: any[]): SessionState {
  return { sessions, activeSessionId: sessions[0]?.id, savedAt: 1 } as unknown as SessionState
}

const okTarget = { uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', cwd: 'C:/proj' }
const EXACT = '/x/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl'
const HEUR = '/x/heuristic-sibling.jsonl'

/** Default deps: hooks ON, an exact path available, and a heuristic path that
 *  MUST NOT be consulted while hooks are on. Override per test. */
function mkDeps(over: Partial<ResumeEnrichDeps> = {}): ResumeEnrichDeps {
  return {
    getExactResumeTarget: () => EXACT,
    getLatestTranscriptPath: () => HEUR,
    isExactBindSourceActive: () => true,
    resolveResumeTargetFromTranscript: () => okTarget,
    ...over,
  }
}

describe('enrichSessionStateWithResumeTargets', () => {
  it('stamps uuid+cwd on a Claude session from the EXACT bind', () => {
    const s = state([{ id: 's1', provider: 'claude' }])
    enrichSessionStateWithResumeTargets(s, mkDeps())
    expect(s.sessions[0]).toMatchObject({ resumeUuid: okTarget.uuid, resumeCwd: okTarget.cwd })
  })

  it('treats an absent provider as claude (default) and enriches it', () => {
    const s = state([{ id: 's1' }])
    enrichSessionStateWithResumeTargets(s, mkDeps())
    expect(s.sessions[0].resumeUuid).toBe(okTarget.uuid)
  })

  it('#480 hooks-on: NEVER consults the heuristic path (no cross)', () => {
    const s = state([{ id: 's1', provider: 'claude' }])
    const getLatest = vi.fn(() => HEUR)
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: () => null, getLatestTranscriptPath: getLatest }))
    expect(getLatest).not.toHaveBeenCalled()
    expect(s.sessions[0].resumeUuid).toBeUndefined()
  })

  it('#480 hooks-off: falls back to the heuristic path', () => {
    const s = state([{ id: 's1', provider: 'claude' }])
    const getLatest = vi.fn(() => HEUR)
    enrichSessionStateWithResumeTargets(s, mkDeps({
      getExactResumeTarget: () => null,
      isExactBindSourceActive: () => false,
      getLatestTranscriptPath: getLatest,
    }))
    expect(getLatest).toHaveBeenCalledWith('s1')
    expect(s.sessions[0].resumeUuid).toBe(okTarget.uuid)
  })

  it('skips shell-only sessions', () => {
    const s = state([{ id: 's1', provider: 'claude', shellOnly: true }])
    const getExact = vi.fn(() => EXACT)
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: getExact }))
    expect(getExact).not.toHaveBeenCalled()
    expect(s.sessions[0].resumeUuid).toBeUndefined()
  })

  it('skips non-Claude (codex) sessions', () => {
    const s = state([{ id: 's1', provider: 'codex' }])
    const getExact = vi.fn(() => EXACT)
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: getExact }))
    expect(getExact).not.toHaveBeenCalled()
    expect(s.sessions[0].resumeUuid).toBeUndefined()
  })

  it('KEEPS the existing target when there is no exact bind (hooks on, no fallback)', () => {
    const s = state([{ id: 's1', provider: 'claude', resumeUuid: 'old-uuid', resumeCwd: 'C:/old' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: () => null }))
    expect(s.sessions[0]).toMatchObject({ resumeUuid: 'old-uuid', resumeCwd: 'C:/old' })
  })

  it('KEEPS the existing target when the transcript does not resolve a target', () => {
    const s = state([{ id: 's1', provider: 'claude', resumeUuid: 'old-uuid', resumeCwd: 'C:/old' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ resolveResumeTargetFromTranscript: () => null }))
    expect(s.sessions[0]).toMatchObject({ resumeUuid: 'old-uuid', resumeCwd: 'C:/old' })
  })

  it('never throws on a per-session dep failure; leaves that record unchanged and continues', () => {
    const s = state([
      { id: 'bad', provider: 'claude', resumeUuid: 'keep' },
      { id: 'good', provider: 'claude' },
    ])
    enrichSessionStateWithResumeTargets(s, mkDeps({
      getExactResumeTarget: (id) => {
        if (id === 'bad') throw new Error('binder blew up')
        return EXACT
      },
    }))
    expect(s.sessions[0].resumeUuid).toBe('keep')          // untouched despite the throw
    expect(s.sessions[1].resumeUuid).toBe(okTarget.uuid)   // later session still enriched
  })

  it('is a whole no-op on a non-array sessions field', () => {
    const s = { sessions: undefined, savedAt: 1 } as unknown as SessionState
    expect(() => enrichSessionStateWithResumeTargets(s, mkDeps())).not.toThrow()
  })
})

// P3.5 (row 34): a Codex session keeps the conversation it is on (pty-manager's
// kept conversation), and session:save persists it the way it persists a
// Claude tab's, so a relaunch resumes it (`codex resume <id>`).
describe('enrichSessionStateWithResumeTargets for a Codex session (P3.5)', () => {
  const CODEX = { uuid: '019dd000-0001-7000-8000-0000000000e1', cwd: 'C:/p/demo' }

  it('persists the conversation the tab is on, from its provider, never from the Claude binder', () => {
    const s = state([{ id: 's1', provider: 'codex' }])
    const getExact = vi.fn(() => EXACT)
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: getExact, getProviderResumeTarget: () => CODEX }))
    expect(getExact).not.toHaveBeenCalled()
    expect(s.sessions[0]).toMatchObject({ resumeUuid: CODEX.uuid, resumeCwd: CODEX.cwd })
  })

  it('keeps what the record carried while the tab is on no known conversation', () => {
    const s = state([{ id: 's1', provider: 'codex', resumeUuid: CODEX.uuid, resumeCwd: 'C:/old' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ getProviderResumeTarget: () => null }))
    expect(s.sessions[0]).toMatchObject({ resumeUuid: CODEX.uuid, resumeCwd: 'C:/old' })
  })

  it('persists only a conversation id, with a directory', () => {
    const s = state([{ id: 's1', provider: 'codex' }, { id: 's2', provider: 'codex' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ getProviderResumeTarget: (id) => (id === 's1' ? { uuid: '--resume', cwd: 'C:/p' } : { uuid: CODEX.uuid, cwd: '' }) }))
    expect(s.sessions[0].resumeUuid).toBeUndefined()
    expect(s.sessions[1].resumeUuid).toBeUndefined()
  })

  it('never for a shell-only tab, and a Claude tab never takes it', () => {
    const provider = vi.fn(() => CODEX)
    const s = state([{ id: 's1', provider: 'codex', shellOnly: true }, { id: 's2', provider: 'claude' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({ getExactResumeTarget: () => null, getProviderResumeTarget: provider }))
    expect(provider).not.toHaveBeenCalled()
    expect(s.sessions[0].resumeUuid).toBeUndefined()
    expect(s.sessions[1].resumeUuid).toBeUndefined()
  })
})

// P3.6 (ADR-009 round 1, B1; owner decision): the Codex conversations whose
// claim was not certain are saved with the state, so a relaunch that resumes
// one still never has it carried by a Switch account. Main writes the list at
// every save (only the ones a saved session is on) and reads it back at load.
describe('enrichSessionStateWithResumeTargets keeps the uncertain claims (P3.6)', () => {
  const ON = '019dd000-0001-7000-8000-0000000000f1'
  const GONE = '019dd000-0001-7000-8000-0000000000f2'

  it('writes those a saved session is on, whatever their case; drops the rest; and removes the list when none is left', () => {
    const s = state([{ id: 's1', provider: 'codex' }, { id: 's2', provider: 'codex' }])
    enrichSessionStateWithResumeTargets(s, mkDeps({
      getProviderResumeTarget: (id) => (id === 's1' ? { uuid: ON, cwd: 'C:/p' } : null),
      getUncertainProviderConversations: () => [ON.toUpperCase(), GONE],
    }))
    expect(s.codexUncertainConversations).toEqual([ON.toUpperCase()])
    const later = state([{ id: 's1', provider: 'codex', resumeUuid: GONE, resumeCwd: 'C:/p' }])
    later.codexUncertainConversations = [ON]
    enrichSessionStateWithResumeTargets(later, mkDeps({ getProviderResumeTarget: () => null, getUncertainProviderConversations: () => [ON] }))
    expect(later.codexUncertainConversations).toBeUndefined()
  })

  it('without the source, the saved list is left as it is; a source that throws leaves it too', () => {
    const s = state([{ id: 's1', provider: 'codex', resumeUuid: ON, resumeCwd: 'C:/p' }])
    s.codexUncertainConversations = [ON]
    enrichSessionStateWithResumeTargets(s, mkDeps())
    expect(s.codexUncertainConversations).toEqual([ON])
    enrichSessionStateWithResumeTargets(s, mkDeps({ getUncertainProviderConversations: () => { throw new Error('x') } }))
    expect(s.codexUncertainConversations).toEqual([ON])
  })

  // ADR-009 round 2 (C8): the list is main's own; where the saved sessions
  // cannot be read, main's whole list is written, never the renderer's.
  it('saved sessions that cannot be read: main\'s whole list is written, replacing the one the renderer sent', () => {
    const odd = { id: 's1', provider: 'codex' }
    Object.defineProperty(odd, 'resumeUuid', { get() { throw new Error('unreadable') }, enumerable: true })
    const s = state([odd])
    s.codexUncertainConversations = ['019dd000-0001-7000-8000-0000000000f9']
    enrichSessionStateWithResumeTargets(s, mkDeps({ getUncertainProviderConversations: () => [ON, GONE] }))
    expect(s.codexUncertainConversations).toEqual([ON, GONE])
  })
})

// P3.7 (row 36): each conversation's running time, main's own, is saved with
// the state at every save (whichever tabs are open: a closed tab's
// conversation can be resumed later), so a relaunch carries it on.
describe('enrichSessionStateWithResumeTargets saves the conversations\' running time (P3.7)', () => {
  const MAIN = [{ id: '019dd000-0001-7000-8000-0000000000f1', ms: 5_000, until: 100 }]

  it('writes main\'s list, replacing the one the renderer sent; an empty one removes it', () => {
    const s = state([{ id: 's1', provider: 'codex' }])
    s.conversationRunningTimes = [{ id: '019dd000-0001-7000-8000-0000000000f9', ms: 999_999, until: 5 }]
    enrichSessionStateWithResumeTargets(s, mkDeps({ getConversationRunningTimes: () => MAIN }))
    expect(s.conversationRunningTimes).toEqual(MAIN)
    enrichSessionStateWithResumeTargets(s, mkDeps({ getConversationRunningTimes: () => [] }))
    expect(s.conversationRunningTimes).toBeUndefined()
  })

  it('without the source, the saved list is left as it is', () => {
    const s = state([{ id: 's1', provider: 'codex' }])
    s.conversationRunningTimes = MAIN
    enrichSessionStateWithResumeTargets(s, mkDeps())
    expect(s.conversationRunningTimes).toEqual(MAIN)
  })

  // Review fix 5: the list is main's own; when main cannot give it, none is
  // written, never the renderer's (unlike the uncertain list, which keeps the
  // state's own copy when its getter throws: the test above).
  it('a source that throws or gives no list: the list the renderer sent is removed', () => {
    const s = state([{ id: 's1', provider: 'codex' }])
    s.conversationRunningTimes = MAIN
    enrichSessionStateWithResumeTargets(s, mkDeps({ getConversationRunningTimes: () => { throw new Error('x') } }))
    expect(s.conversationRunningTimes).toBeUndefined()
    s.conversationRunningTimes = MAIN
    enrichSessionStateWithResumeTargets(s, mkDeps({ getConversationRunningTimes: () => 'not a list' as never }))
    expect(s.conversationRunningTimes).toBeUndefined()
  })
})
