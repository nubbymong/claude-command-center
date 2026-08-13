// src/renderer/hooks/useWatchdogSubscription.ts
import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'

/**
 * Subscribe to Session Watchdog (#235) state pushes for a session. Mirrors
 * useStatuslineSubscription/useEffortSubscription: filters the main->renderer
 * push by sessionId and copies the fields the sidebar/status-area indicator
 * needs into the session store. A no-op stream when the watchdog is off or
 * was never started for this session (main never pushes for it).
 */
export function useWatchdogSubscription(sessionId: string) {
  const updateSession = useSessionStore((s) => s.updateSession)

  useEffect(() => {
    const unsub = window.electronAPI.watchdog.onUpdate((state) => {
      if (state.sessionId !== sessionId) return
      updateSession(sessionId, {
        watchdog: { status: state.status, waitUntil: state.waitUntil, gaveUp: state.gaveUp },
      })
    })
    return unsub
  }, [sessionId])
}
