import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useSettingsStore } from '../stores/settingsStore'

/**
 * Auto-Escape when context exceeds threshold (compaction interrupt).
 */
export function useCompactionInterrupt(sessionId: string) {
  const session = useSessionStore((s) => s.sessions.find((sess) => sess.id === sessionId))
  const updateSession = useSessionStore((s) => s.updateSession)
  const threshold = useSettingsStore((s) => s.settings.compactionInterruptThreshold)

  useEffect(() => {
    if (!session?.compactionInterrupt) return
    if (session.compactionInterruptTriggered) return
    if (session.contextPercent == null) return

    if (session.contextPercent >= threshold) {
      window.electronAPI.pty.write(sessionId, '\x1b')
      updateSession(sessionId, { compactionInterruptTriggered: true })
      console.log(`[CI] Session ${sessionId}: context ${session.contextPercent}% >= ${threshold}%, sent Escape`)
    }
  }, [session?.contextPercent, session?.compactionInterrupt, session?.compactionInterruptTriggered, threshold, sessionId])
}
