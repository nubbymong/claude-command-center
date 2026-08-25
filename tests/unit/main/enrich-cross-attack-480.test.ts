import { describe, it, expect, vi } from 'vitest'
import { enrichSessionStateWithResumeTargets } from '../../../src/main/session-resume-enrich'
import type { ResumeEnrichDeps } from '../../../src/main/session-resume-enrich'
import type { SessionState } from '../../../src/main/session-state'

// #480 adversarial round 2 re-check (attacker): two same-repo cards, hooks ON,
// with NO exact bind and ONLY a shared heuristic bind (the newest .jsonl in the
// per-repo folder). The main enrich path must NOT stamp the same conversation
// uuid on both cards — that was the same-repo cross that survived on the relaunch
// (enrich) path. Deps are shaped EXACTLY as src/main/index.ts wires them.

function state(sessions: any[]): SessionState {
  return { sessions, activeSessionId: sessions[0]?.id, savedAt: 1 } as unknown as SessionState
}

// Both same-repo cards resolve, via the heuristic newest-file scan, to the SAME
// sibling transcript — the concrete cross.
const SHARED_HEUR = '/repo/proj/9f9f9f9f-1111-2222-3333-444444444444.jsonl'
const CROSS_UUID = '9f9f9f9f-1111-2222-3333-444444444444'

/** Deps mirroring src/main/index.ts createSessionDurability wiring:
 *  getExactResumeTarget -> binder exact map (null: nothing authenticated yet),
 *  getLatestTranscriptPath -> binder heuristic newest-file scan (shared sibling),
 *  isExactBindSourceActive -> real hook gate (hooks ON => true),
 *  resolveResumeTargetFromTranscript -> uuid from transcript basename. */
function prodDeps(hooksEnabled: boolean): ResumeEnrichDeps & { _getLatest: ReturnType<typeof vi.fn> } {
  const getLatest = vi.fn((_id: string): string | null => SHARED_HEUR)
  return {
    getExactResumeTarget: (_id: string) => null,
    getLatestTranscriptPath: (id: string) => getLatest(id),
    isExactBindSourceActive: () => hooksEnabled,
    resolveResumeTargetFromTranscript: (p: string) => ({
      uuid: p.split('/').pop()!.replace(/\.jsonl$/i, ''),
      cwd: '/repo/proj',
    }),
    _getLatest: getLatest,
  }
}

describe('#480 cross attack — main enrich, hooks ON, two same-repo cards', () => {
  it('does NOT stamp the same heuristic uuid on two same-repo cards (hooks on)', () => {
    const deps = prodDeps(true)
    const s = state([
      { id: 'cardA', provider: 'claude', cwd: '/repo/proj' },
      { id: 'cardB', provider: 'claude', cwd: '/repo/proj' },
    ])
    enrichSessionStateWithResumeTargets(s, deps)

    // Heuristic path must never be consulted while hooks are on.
    expect(deps._getLatest).not.toHaveBeenCalled()
    // Neither card gets a resume uuid — a fresh start beats reopening a stranger.
    expect(s.sessions[0].resumeUuid).toBeUndefined()
    expect(s.sessions[1].resumeUuid).toBeUndefined()
    // Explicitly: they are NOT both the crossed sibling uuid.
    expect(s.sessions[0].resumeUuid).not.toBe(CROSS_UUID)
    expect(s.sessions[1].resumeUuid).not.toBe(CROSS_UUID)
  })

  it('control: hooks OFF DOES fall back to the (crossing) heuristic — the documented trade', () => {
    const deps = prodDeps(false)
    const s = state([
      { id: 'cardA', provider: 'claude', cwd: '/repo/proj' },
      { id: 'cardB', provider: 'claude', cwd: '/repo/proj' },
    ])
    enrichSessionStateWithResumeTargets(s, deps)
    // With no authenticated source at all, both cross to the sibling — expected.
    expect(s.sessions[0].resumeUuid).toBe(CROSS_UUID)
    expect(s.sessions[1].resumeUuid).toBe(CROSS_UUID)
  })
})
