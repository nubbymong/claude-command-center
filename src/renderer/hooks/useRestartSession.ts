import { useCallback } from 'react'
import { Session, useSessionStore } from '../stores/sessionStore'
import { killSessionPty, clearSpawned } from '../ptyTracker'
import { markSessionForResumePicker } from '../utils/resumePicker'
import { useAccountGateStore } from '../stores/accountGateStore'

// Shared restart/recover logic for SessionHeader and the v2 bottom bar.
// Behaviour is identical to the inline functions that previously lived in
// SessionHeader -- extracted so both can share the EXACT same mechanism.

export function useRestartSession(
  session: Session | null | undefined,
  isShowingPartner = false,
): { restart: (overrides?: Partial<Session>) => void; recover: () => void } {
  const forceRemount = useCallback(
    (status: 'idle' | 'working', overrides?: Partial<Session>) => {
      if (!session) return
      const store = useSessionStore.getState()
      // Merge from the LIVE store record (not just the captured closure) so a
      // store mutation made immediately before restart -- e.g. switchAccount
      // setting profileId -- survives the remove/re-add. `overrides` lets the
      // caller force specific fields (profileId) even if the store read raced.
      const live = store.getSession(session.id)
      store.removeSession(session.id)
      store.addSession({
        ...session,
        ...live,
        ...overrides,
        id: session.id,
        status,
        createdAt: Date.now(),
        // Clear stale metadata from previous run
        contextPercent: undefined,
        costUsd: undefined,
        needsAttention: false,
        modelName: undefined,
        // Graceful-fail: the previous run's live indicators must not linger on the
        // restarted card. Clearing effortLive re-hides the effort pill (and fastMode
        // the bolt) until the new run's first statusline tick confirms them.
        effortLive: undefined,
        fastMode: undefined,
        // The whole point of a remount is that a new PTY is about to exist.
        // Leaving the previous run's exit flag set would make every liveness
        // check (findAskSession's, the dock's dot) read the fresh session as
        // dead.
        ptyExited: undefined,
        // A restart re-runs the spawn effect. Ask Conductor's opening question
        // is one-shot: without this, restarting an Ask session would re-submit
        // whatever the user first typed. TerminalView also consumes it at spawn;
        // this is the second fence, because forceRemount merges the CAPTURED
        // session on top of nothing when the store read races.
        askPrompt: undefined,
        linesAdded: undefined,
        linesRemoved: undefined,
        inputTokens: undefined,
        outputTokens: undefined,
        totalDurationMs: undefined,
        rateLimitCurrent: undefined,
        rateLimitCurrentResets: undefined,
        rateLimitWeekly: undefined,
        rateLimitWeeklyResets: undefined,
        rateLimitExtra: undefined,
        // Per-model usage buckets (statusline limits[], incl. the weekly Fable
        // bucket) are live indicators too -- omitting them left the previous
        // account's hit limit painted on the card after a mid-session switch
        // (which routes through this same remount) until a later tick overwrote
        // it. Clear them like the rateLimit* siblings.
        usageBuckets: undefined,
        // #266 MAJOR-4: the watchdog badge (waiting/gave-up) belongs to the
        // PREVIOUS run's watcher, which the restart tears down; main pushes a
        // fresh 'monitoring' state when the new run arms one.
        watchdog: undefined,
      })
    },
    [session],
  )

  const restart = useCallback((overrides?: Partial<Session>) => {
    if (!session) return
    if (isShowingPartner) {
      // Partner terminal: just kill partner PTY, leave main Claude untouched
      const partnerPtyId = session.id + '-partner'
      // Only kill the partner -- don't use killSessionPty which also kills main+partner
      window.electronAPI.pty.kill(partnerPtyId)
      // Clear partner from spawn tracker so it respawns on remount
      clearSpawned(partnerPtyId)
      // Force re-mount by bumping createdAt. Merge the live store record +
      // overrides so a pre-restart store mutation (e.g. profileId) survives.
      const store = useSessionStore.getState()
      const live = store.getSession(session.id)
      store.removeSession(session.id)
      store.addSession({ ...session, ...live, ...overrides, id: session.id, status: session.status, createdAt: Date.now() })
      return
    }
    // Kill the old PTY (also clears spawn tracker so new one will spawn)
    killSessionPty(session.id)
    // Show resume picker on restart so user can pick a conversation
    if (session.sessionType === 'local' && !session.shellOnly) {
      markSessionForResumePicker(session.id)
    }
    // Restart (and switch, which routes through here) already determines the
    // account -- the re-spawn must NOT pop the pre-spawn account gate.
    useAccountGateStore.getState().markPredetermined(session.id)
    // Force re-mount with clean metadata
    forceRemount('idle', overrides)
  }, [session, isShowingPartner, forceRemount])

  const recover = useCallback(() => {
    if (!session) return
    const partnerPtyId = session.id + '-partner'
    // Kill both main and partner PTYs (ignore errors -- process may already be dead)
    window.electronAPI.pty.kill(session.id)
    window.electronAPI.pty.kill(partnerPtyId)
    clearSpawned(session.id)
    clearSpawned(partnerPtyId)
    // Show resume picker for Claude sessions
    if (session.sessionType === 'local' && !session.shellOnly) {
      markSessionForResumePicker(session.id)
    }
    // Recover preserves the current account -- skip the pre-spawn gate.
    useAccountGateStore.getState().markPredetermined(session.id)
    forceRemount('idle')
  }, [session, forceRemount])

  return { restart, recover }
}
