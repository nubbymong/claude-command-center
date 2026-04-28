import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { Terminal } from '@xterm/xterm'

/**
 * Clear attention, repaint, and pull keyboard focus into the terminal
 * when the tab becomes active. The focus call is what fixes "SSH lands
 * on Claude's trust-this-folder prompt but Enter goes nowhere because
 * the renderer never routed focus into the xterm" — the SSH flow
 * transitions through several states without firing a focus event,
 * and the only previous path to focus was a mouseup listener.
 *
 * Skip focusing when an in-app modal is open (`role="dialog"`
 * `aria-modal="true"`) so we don't yank focus out from under the
 * walkthrough / config dialogs.
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
          // Defer the focus call so xterm has finished its own paint
          // pass; focusing too early can put the cursor in a stale
          // viewport.
          if (document.querySelector('[role="dialog"][aria-modal="true"]')) return
          try { term.focus() } catch { /* ignore */ }
        })
      }
    }
  }, [isActive, sessionId])
}
