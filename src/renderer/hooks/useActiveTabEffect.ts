import { useEffect } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useSleepStore } from '../stores/sleepStore'
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
      // Sleep grace (canvas rules, 2026-08-27): activating the tab is the
      // attention DISMISS. Stamp it only when attention was actually up, so
      // the moon's clock restarts at the dismiss instead of appearing the
      // instant a long-attention session is cleared. Plain activations of a
      // no-attention session stamp nothing — clicking never delays a moon.
      const wasAttention = useSessionStore.getState().sessions.find((s) => s.id === sessionId)?.needsAttention === true
      if (wasAttention) useSleepStore.getState().noteAttentionDismissed(sessionId)
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
