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
 *
 * To honour that "add/remove only" promise we compare a STRUCTURAL KEY (session
 * ids in order), not the array identity: sessionStore.updateSession replaces the
 * array on every per-session metadata patch (statusline telemetry ticks a few
 * times a second per working session), so the old `state.sessions === prev.sessions`
 * guard fired on every tick. That trailing debounce was then reset by each tick --
 * during a sustained busy stretch the file was never rewritten until a quiet gap
 * (a crash mid-stretch restored a stale set, the exact failure this hook exists to
 * fix), and during stop-and-go usage it wrote redundantly after every lull.
 */
function sessionsKey(sessions: { id: string }[]): string {
  return sessions.map((s) => s.id).join('\n')
}

export function useSessionAutosave(): void {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastKey = useRef<string>(sessionsKey(useSessionStore.getState().sessions))
  useEffect(() => {
    const unsub = useSessionStore.subscribe((state, prev) => {
      if (state.sessions === prev.sessions) return
      // Ignore telemetry-only / metadata churn -- only the session SET (add /
      // remove / reorder) changes the file's contents that matter for resume.
      const key = sessionsKey(state.sessions)
      if (key === lastKey.current) return
      lastKey.current = key
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
