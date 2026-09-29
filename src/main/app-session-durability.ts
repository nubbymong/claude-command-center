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
 * non-graceful exit (Group 2); noteCleared drops the cache on an intentional
 * clear so the flush never resurrects a discarded set (F1). The binder is read
 * lazily per call: it may init after this module loads.
 */
import { createSessionDurability, type SessionDurability } from './session-durability'
import { saveSessionState, loadSessionState } from './session-state'
import { isExactBindSourceActive } from './hooks'
import { getTranscriptBinder } from './logging/logging-service'
import { resolveResumeTargetFromTranscript } from './logging/transcript-discovery'
import { getKeptCodexConversation, uncertainCodexConversationIds, rememberUncertainCodexConversationsFrom } from './pty-manager'
import { conversationRunningTimesForSave, rememberConversationRunningTimesFrom } from './conversation-running-time'
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
    // P3.6: read back before any restored session respawns. P3.7: the running
    // times too, even when the uncertain list cannot be read back.
    readBack: (state) => {
      try {
        rememberUncertainCodexConversationsFrom(state)
      } finally {
        rememberConversationRunningTimesFrom(state)
      }
    },
    log: logInfo,
  })
}
