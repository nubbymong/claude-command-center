import { useCallback } from 'react'
import { Session, useSessionStore } from '../stores/sessionStore'
import { killSessionPty, clearSpawned } from '../ptyTracker'
import { markSessionForResumePicker } from '../utils/resumePicker'

// Shared restart/recover logic for SessionHeader and the v2 bottom bar.
// Behaviour is identical to the inline functions that previously lived in
// SessionHeader -- extracted so both can share the EXACT same mechanism.

export function useRestartSession(
  session: Session | null | undefined,
  isShowingPartner = false,
): { restart: () => void; recover: () => void } {
  const forceRemount = useCallback(
    (status: 'idle' | 'working') => {
      if (!session) return
      const store = useSessionStore.getState()
      store.removeSession(session.id)
      store.addSession({
        ...session,
        id: session.id,
        status,
        createdAt: Date.now(),
        // Clear stale metadata from previous run
        contextPercent: undefined,
        costUsd: undefined,
        needsAttention: false,
        modelName: undefined,
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
      })
    },
    [session],
  )

  const restart = useCallback(() => {
    if (!session) return
    if (isShowingPartner) {
      // Partner terminal: just kill partner PTY, leave main Claude untouched
      const partnerPtyId = session.id + '-partner'
      // Only kill the partner -- don't use killSessionPty which also kills main+partner
      window.electronAPI.pty.kill(partnerPtyId)
      // Clear partner from spawn tracker so it respawns on remount
      clearSpawned(partnerPtyId)
      // Force re-mount by bumping createdAt
      const store = useSessionStore.getState()
      store.removeSession(session.id)
      store.addSession({ ...session, id: session.id, status: session.status, createdAt: Date.now() })
      return
    }
    // Kill the old PTY (also clears spawn tracker so new one will spawn)
    killSessionPty(session.id)
    // Show resume picker on restart so user can pick a conversation
    if (session.sessionType === 'local' && !session.shellOnly) {
      markSessionForResumePicker(session.id)
    }
    // Force re-mount with clean metadata
    forceRemount('idle')
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
    forceRemount('idle')
  }, [session, forceRemount])

  return { restart, recover }
}
