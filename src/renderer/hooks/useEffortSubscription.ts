// src/renderer/hooks/useEffortSubscription.ts
import { useEffect } from 'react'
import { useSessionStore, type Session } from '../stores/sessionStore'

const VALID: ReadonlyArray<NonNullable<Session['effortLevel']>> = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode']

/**
 * Subscribe to live reasoning-effort updates pushed from the hooks gateway.
 * Updates session.effortLevel so the status strip shows the REAL effort even
 * when it was set globally in ~/.claude/settings.json (not through CCC).
 */
export function useEffortSubscription(sessionId: string) {
  const updateSession = useSessionStore((s) => s.updateSession)
  useEffect(() => {
    const unsub = window.electronAPI.effort.onUpdate(({ sessionId: sid, effortLevel }) => {
      if (sid !== sessionId) return
      if (!VALID.includes(effortLevel as NonNullable<Session['effortLevel']>)) return
      updateSession(sessionId, { effortLevel: effortLevel as Session['effortLevel'] })
    })
    return unsub
  }, [sessionId, updateSession])
}
