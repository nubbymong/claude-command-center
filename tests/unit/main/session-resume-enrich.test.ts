import { describe, it, expect, vi } from 'vitest'
import { enrichSessionStateWithResumeTargets } from '../../../src/main/session-resume-enrich'
import type { SessionState } from '../../../src/main/session-state'

// #397 Group 1: main-side enrichment is the single write choke point that stamps
// each Claude session's exact-conversation resume target, so EVERY renderer writer
// (autosave, account flush, GitHub flush, Save-&-Close) persists a resumable
// record — not only the graceful-close path. These tests pin the fail-safe rules.

function state(sessions: any[]): SessionState {
  return { sessions, activeSessionId: sessions[0]?.id, savedAt: 1 } as unknown as SessionState
}

const okTarget = { uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', cwd: 'C:/proj' }

describe('enrichSessionStateWithResumeTargets', () => {
  it('stamps uuid+cwd on a Claude session from the binder', () => {
    const s = state([{ id: 's1', provider: 'claude' }])
    enrichSessionStateWithResumeTargets(s, {
      getLatestTranscriptPath: () => '/x/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl',
      resolveResumeTargetFromTranscript: () => okTarget,
    })
    expect(s.sessions[0]).toMatchObject({ resumeUuid: okTarget.uuid, resumeCwd: okTarget.cwd })
  })

  it('treats an absent provider as claude (default) and enriches it', () => {
    const s = state([{ id: 's1' }])
    enrichSessionStateWithResumeTargets(s, {
      getLatestTranscriptPath: () => '/x/f.jsonl',
      resolveResumeTargetFromTranscript: () => okTarget,
    })
    expect(s.sessions[0].resumeUuid).toBe(okTarget.uuid)
  })

  it('skips shell-only sessions', () => {
    const s = state([{ id: 's1', provider: 'claude', shellOnly: true }])
    const getLatest = vi.fn(() => '/x/f.jsonl')
    enrichSessionStateWithResumeTargets(s, {
      getLatestTranscriptPath: getLatest,
      resolveResumeTargetFromTranscript: () => okTarget,
    })
    expect(getLatest).not.toHaveBeenCalled()
    expect(s.sessions[0].resumeUuid).toBeUndefined()
  })

  it('skips non-Claude (codex) sessions', () => {
    const s = state([{ id: 's1', provider: 'codex' }])
    const getLatest = vi.fn(() => '/x/f.jsonl')
    enrichSessionStateWithResumeTargets(s, {
      getLatestTranscriptPath: getLatest,
      resolveResumeTargetFromTranscript: () => okTarget,
    })
    expect(getLatest).not.toHaveBeenCalled()
    expect(s.sessions[0].resumeUuid).toBeUndefined()
  })

  it('KEEPS the existing target when the binder has no path (logging off)', () => {
    const s = state([{ id: 's1', provider: 'claude', resumeUuid: 'old-uuid', resumeCwd: 'C:/old' }])
    enrichSessionStateWithResumeTargets(s, {
      getLatestTranscriptPath: () => null,
      resolveResumeTargetFromTranscript: () => okTarget,
    })
    expect(s.sessions[0]).toMatchObject({ resumeUuid: 'old-uuid', resumeCwd: 'C:/old' })
  })

  it('KEEPS the existing target when the transcript does not resolve a target', () => {
    const s = state([{ id: 's1', provider: 'claude', resumeUuid: 'old-uuid', resumeCwd: 'C:/old' }])
    enrichSessionStateWithResumeTargets(s, {
      getLatestTranscriptPath: () => '/x/f.jsonl',
      resolveResumeTargetFromTranscript: () => null,
    })
    expect(s.sessions[0]).toMatchObject({ resumeUuid: 'old-uuid', resumeCwd: 'C:/old' })
  })

  it('never throws on a per-session dep failure; leaves that record unchanged and continues', () => {
    const s = state([
      { id: 'bad', provider: 'claude', resumeUuid: 'keep' },
      { id: 'good', provider: 'claude' },
    ])
    enrichSessionStateWithResumeTargets(s, {
      getLatestTranscriptPath: (id) => {
        if (id === 'bad') throw new Error('binder blew up')
        return '/x/f.jsonl'
      },
      resolveResumeTargetFromTranscript: () => okTarget,
    })
    expect(s.sessions[0].resumeUuid).toBe('keep')          // untouched despite the throw
    expect(s.sessions[1].resumeUuid).toBe(okTarget.uuid)   // later session still enriched
  })

  it('is a whole no-op on a non-array sessions field', () => {
    const s = { sessions: undefined, savedAt: 1 } as unknown as SessionState
    expect(() => enrichSessionStateWithResumeTargets(s, {
      getLatestTranscriptPath: () => '/x/f.jsonl',
      resolveResumeTargetFromTranscript: () => okTarget,
    })).not.toThrow()
  })
})
