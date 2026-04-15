import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { Terminal } from '@xterm/xterm'

/**
 * Clear attention and force terminal redraw when tab becomes active.
 */
export function useActiveTabEffect(
  sessionId: string,
  isActive: boolean,
  terminalRef: React.RefObject<Terminal | null>,
  attentionTimerRef: React.MutableRefObject<ReturnType<typeof setTimeout> | null>,
  attentionAckedRef: React.MutableRefObject<boolean>
) {
  const updateSession = useSessionStore((s) => s.updateSession)

  useEffect(() => {
    if (isActive) {
      updateSession(sessionId, { needsAttention: false })
      attentionAckedRef.current = true
      if (attentionTimerRef.current) {
        clearTimeout(attentionTimerRef.current)
        attentionTimerRef.current = null
      }
      const term = terminalRef.current
      if (term) {
        requestAnimationFrame(() => {
          try { term.refresh(0, term.rows - 1) } catch { /* ignore */ }
        })
      }
    }
  }, [isActive, sessionId])
}
