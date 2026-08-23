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
    // Seed from main's CURRENT states on mount (#266 MAJOR-4): a push-only
    // stream shows nothing for a watcher armed before this view mounted, and
    // — worse — leaves a PREVIOUS run's badge painted when no watcher exists
    // any more. Main is the truth; absent there means absent here.
    let cancelled = false
    void window.electronAPI.watchdog.getStates().then((states) => {
      if (cancelled) return
      const mine = states.find((s) => s.sessionId === sessionId)
      updateSession(sessionId, {
        watchdog: mine ? { status: mine.status, waitUntil: mine.waitUntil, gaveUp: mine.gaveUp } : undefined,
      })
    }).catch(() => { /* main gone mid-teardown */ })
    return () => {
      cancelled = true
      unsub()
    }
  }, [sessionId])
}
