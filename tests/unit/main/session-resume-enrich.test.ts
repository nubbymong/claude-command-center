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
