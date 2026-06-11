import { useEffect, useRef } from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { buildSessionState } from '../session-persistence'

const DEBOUNCE_MS = 1000

/**
 * Keep session-state.json in sync with the live session set.
 *
 * session-state.json is the "offer to resume on next launch" file. It used to be
 * written ONLY on a graceful in-app close (Save-&-close, the Resume / Don't-open
 * buttons, the account/GitHub eager flushes). Closing a session card
 * (sessionStore.removeSession) never touched it -- so a NON-graceful termination
 * (a crash, or an EXTERNAL installer force-closing the running app to replace
 * files) left a stale file from an earlier graceful save, and the next launch
 * re-offered phantom sessions the user had already closed.
 *
 * This debounce-flushes the current session set whenever it CHANGES, so the file
 * always reflects what's actually open and ANY termination leaves it correct.
 * Closing all cards -> the file empties -> no resume offer next launch. Resume
 * still works: it reads the in-memory pendingRestore, not this file. Fires only on
 * add/remove (the sessions array identity changes), not on per-session metadata
 * churn (active-session switches, status updates).
 */
export function useSessionAutosave(): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const unsub = useSessionStore.subscribe((state, prev) => {
      if (state.sessions === prev.sessions) return
      if (timer.current) clearTimeout(timer.current)
      timer.current = setTimeout(() => {
        void window.electronAPI?.session?.save(buildSessionState())
      }, DEBOUNCE_MS)
    })
    return () => {
      unsub()
      if (timer.current) clearTimeout(timer.current)
    }
  }, [])
}
