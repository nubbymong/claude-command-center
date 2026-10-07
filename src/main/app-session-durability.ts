/**
 * app-session-durability.ts: the app's one session durability core
 * (session-durability.ts), composed from main's live sources. Kept out of
 * index.ts so the wiring itself is unit-testable without the Electron main
 * entry (tests/unit/main/app-session-durability.test.ts); index.ts calls it
 * once, at the same point it always composed the core.
 *
 * saveEnriched enriches each Claude session's exact resume target from the
 * live transcript binder, so every persisted file is resumable, not only the
 * graceful close (Group 1). flushOnExit persists the cached state on any
 * non-graceful exit (Group 2); clear (fixer 11) removes the saved file and
 * drops the cache on an intentional clear, whatever the removal did, so the
 * flush never resurrects a discarded set (F1). The binder is read
 * lazily per call: it may init after this module loads.
 */
import { createSessionDurability, type SessionDurability } from './session-durability'
import { saveSessionState, loadSessionState, clearSessionState } from './session-state'
import { isExactBindSourceActive } from './hooks'
import { getTranscriptBinder } from './logging/logging-service'
import { resolveResumeTargetFromTranscript } from './logging/transcript-discovery'
import { getKeptCodexConversation, uncertainCodexConversationIds, rememberUncertainCodexConversationsFrom } from './pty-manager'
import { conversationRunningTimesForSave, rememberConversationRunningTimesFrom } from './conversation-running-time'
import { seedRestoredSessions } from './launch-one-at-a-time'
import { logInfo } from './debug-logger'

export function createAppSessionDurability(): SessionDurability {
  return createSessionDurability({
    enrichDeps: {
      // #480: exact bind is the source of truth; the heuristic path is used only as
      // the hooks-off fallback (gated by isExactBindSourceActive) so this main-side
      // enrichment can never persist a cross-prone heuristic guess in the default
      // (hooks-on) config, matching the resume-handlers IPC.
      getExactResumeTarget: (id) => getTranscriptBinder()?.getExactResumeTarget(id) ?? null,
      getLatestTranscriptPath: (id) => getTranscriptBinder()?.getLatestTranscriptPath(id) ?? null,
      isExactBindSourceActive,
      resolveResumeTargetFromTranscript,
      // P3.5: the conversation a Codex session is on, as main keeps it (pty-manager).
      getProviderResumeTarget: (id) => getKeptCodexConversation(id) ?? null,
      // P3.6: the conversations a Switch account never carries, kept across a relaunch.
      getUncertainProviderConversations: uncertainCodexConversationIds,
      // P3.7: each conversation's running time, carried on across a relaunch.
      getConversationRunningTimes: conversationRunningTimesForSave,
    },
    save: saveSessionState,
    load: loadSessionState,
    // Fixer 11: the session:clear path (index.ts) clears through the core,
    // which drops the cache whatever the clear did. Looked up when called.
    clear: () => clearSessionState(),
    // P3.6: read back before any restored session respawns. P3.7: the running
    // times too, even when the uncertain list cannot be read back.
    readBack: (state) => {
      try {
        try {
          rememberUncertainCodexConversationsFrom(state)
        } finally {
          rememberConversationRunningTimesFrom(state)
        }
      } finally {
        // P3.13 (round 1, M1): the sessions saved at the last quit keep their
        // right to run beside another copy of a config that is not Multi Spawn
        // (the first load of this run only; launch-one-at-a-time.ts).
        seedRestoredSessions(state)
      }
    },
    log: logInfo,
  })
}
