/**
 * session-resume-enrich.ts — main-side exact-conversation resume enrichment (#397).
 *
 * The renderer persists `session-state.json` from several call sites (the graceful
 * Save-&-Close, the debounced autosave, the account flush, the GitHub per-session
 * flush). Before #397 only ONE of them — Save-&-Close — enriched each session with
 * its exact-conversation resume target ({resumeUuid, resumeCwd}); every other
 * writer wrote a NON-enriched record, and the debounced autosave could even fire
 * after the enriched save and clobber it. So any non-graceful exit left a file
 * that, on the next launch, fell back to the terminal resume PICKER instead of
 * resuming the exact conversation.
 *
 * The transcript binder that knows each session's latest conversation lives in the
 * MAIN process. So enrichment belongs here, at the single `session:save` IPC choke
 * point, not spread across the renderer's writers: run it once in main and EVERY
 * writer persists a resumable record for free, and the clobber race dissolves
 * (there is no longer a non-enriched writer to clobber with).
 *
 * Pure + dependency-injected so it is unit-testable without the Electron ABI or a
 * live binder (the repo's spawn-claude-command / resume-picker convention).
 */
import type { SessionState } from './session-state'

export interface ResumeEnrichDeps {
  /** The binder's latest canonical transcript path for a session, or null. */
  getLatestTranscriptPath: (sessionId: string) => string | null
  /** Derive {uuid, cwd} from a transcript path, or null on any failure. */
  resolveResumeTargetFromTranscript: (transcriptPath: string) => { uuid: string; cwd: string } | null
}

/**
 * Enrich a SessionState IN PLACE with each Claude session's exact-conversation
 * resume target, read from the live transcript binder.
 *
 * FAIL-SAFE throughout:
 *   - A session whose target cannot be resolved KEEPS whatever the record already
 *     carried (from restore, or the renderer's own enrichment). The fallback is
 *     therefore never worse than today's behaviour.
 *   - A null binder (logging disabled) is a whole no-op.
 *   - Shell-only and non-Claude (Codex/SSH) sessions are skipped — the binder only
 *     tracks local Claude transcripts.
 *   - Never throws: a per-session failure leaves that one record unchanged.
 *
 * Returns the same object (mutated) for call-site convenience.
 */
export function enrichSessionStateWithResumeTargets(
  state: SessionState,
  deps: ResumeEnrichDeps,
): SessionState {
  if (!state || !Array.isArray(state.sessions)) return state
  for (const s of state.sessions) {
    try {
      if (!s || s.shellOnly) continue
      if ((s.provider ?? 'claude') !== 'claude') continue
      const latest = deps.getLatestTranscriptPath(s.id)
      if (!latest) continue
      const target = deps.resolveResumeTargetFromTranscript(latest)
      if (target && target.uuid && target.cwd) {
        s.resumeUuid = target.uuid
        s.resumeCwd = target.cwd
      }
    } catch {
      // best-effort: leave this record exactly as it was
    }
  }
  return state
}
