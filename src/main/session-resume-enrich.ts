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
  /**
   * #480: the binder's EXACT (authenticated) transcript path for a session, or
   * null. This is the source of truth — never the heuristic newest-file scan,
   * which cross-attributes conversations among cards that share one repo folder.
   */
  getExactResumeTarget: (sessionId: string) => string | null
  /**
   * #480: the heuristic-inclusive latest path, used ONLY as the hooks-off
   * fallback (when no exact source can ever arrive).
   */
  getLatestTranscriptPath: (sessionId: string) => string | null
  /**
   * #480: is an exact bind possible (hooks enabled)? When false, fall back to the
   * heuristic path so a hooks-off user still gets a resumable record.
   */
  isExactBindSourceActive: () => boolean
  /** Derive {uuid, cwd} from a transcript path, or null on any failure. */
  resolveResumeTargetFromTranscript: (transcriptPath: string) => { uuid: string; cwd: string } | null
  /**
   * P3.5: the conversation a non-Claude (Codex) tab is on, as its provider
   * keeps it in main (pty-manager's kept conversation: the one its status
   * line claimed, or the one an exact resume started), or null. Absent: such
   * tabs are left as they are.
   */
  getProviderResumeTarget?: (sessionId: string) => { uuid: string; cwd: string } | null | undefined
  /**
   * P3.6: the conversations whose claim was not certain (pty-manager), saved
   * with the state so a relaunch that resumes one keeps it from being carried
   * by a Switch account. Only those a saved session is on are written.
   */
  getUncertainProviderConversations?: () => string[]
  /**
   * P3.7: each conversation's running time, as main keeps it
   * (conversation-running-time.ts), saved with the state at every save,
   * whichever tabs are open (a closed tab's conversation can be resumed
   * later), so a session's Duration carries on across a relaunch.
   */
  getConversationRunningTimes?: () => Array<{ id: string; ms: number; until: number }>
}

/** A conversation id, as every resume target must carry (the spawn schema's form). */
const CONVERSATION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

/**
 * Enrich a SessionState IN PLACE with each Claude session's exact-conversation
 * resume target, read from the live transcript binder.
 *
 * FAIL-SAFE throughout:
 *   - A session whose target cannot be resolved KEEPS whatever the record already
 *     carried (from restore, or the renderer's own enrichment). The fallback is
 *     therefore never worse than today's behaviour.
 *   - A null binder (logging disabled) is a whole no-op.
 *   - Shell-only sessions are skipped; non-Claude (Codex) sessions never read
 *     the binder, which only tracks local Claude transcripts: P3.5 stamps them
 *     from their provider's kept conversation (getProviderResumeTarget), a
 *     conversation id only.
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
      if ((s.provider ?? 'claude') !== 'claude') {
        const kept = deps.getProviderResumeTarget?.(s.id)
        if (kept && typeof kept.uuid === 'string' && CONVERSATION_ID_RE.test(kept.uuid) && typeof kept.cwd === 'string' && kept.cwd) {
          s.resumeUuid = kept.uuid
          s.resumeCwd = kept.cwd
        }
        continue
      }
      // #480: EXACT bind only — this must not persist a heuristic (cross-prone)
      // guess. The hooks-off fallback re-enables the heuristic only when no
      // authenticated source can arrive.
      let latest = deps.getExactResumeTarget(s.id)
      if (!latest && !deps.isExactBindSourceActive()) {
        latest = deps.getLatestTranscriptPath(s.id)
      }
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
  if (deps.getUncertainProviderConversations) {
    let all: string[] | null = null
    try {
      const got = deps.getUncertainProviderConversations()
      all = Array.isArray(got) ? got.filter((id): id is string => typeof id === 'string') : null
    } catch {
      // Main cannot say: the list stays as it was.
      all = null
    }
    if (all) {
      try {
        const on = new Set(state.sessions.map((s) => (s && typeof s.resumeUuid === 'string' ? s.resumeUuid.toLowerCase() : '')).filter(Boolean))
        const kept = all.filter((id) => on.has(id.toLowerCase()))
        if (kept.length) state.codexUncertainConversations = kept
        else delete state.codexUncertainConversations
      } catch {
        // The saved sessions could not be read (ADR-009 round 2, C8): main's
        // own list, whole, never what the renderer sent.
        state.codexUncertainConversations = all
      }
    }
  }
  if (deps.getConversationRunningTimes) {
    // Main's own list, never what the renderer sent (as C8 for the uncertain
    // list): when main cannot give one, none is written.
    let times: unknown = null
    try {
      times = deps.getConversationRunningTimes()
    } catch {
      times = null
    }
    if (Array.isArray(times) && times.length) state.conversationRunningTimes = times
    else delete state.conversationRunningTimes
  }
  return state
}
