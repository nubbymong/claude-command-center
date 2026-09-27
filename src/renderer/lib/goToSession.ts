// P3.2 (design 5.3): "Go to <session>" from Settings, Accounts. A refused
// inactivate, archive or removal names the sessions holding the account;
// each one's button brings that session's tab forward. The row dispatches;
// App listens (it owns the view) and does the switch.
import { useSessionStore } from '../stores/sessionStore'

export const GO_TO_SESSION_EVENT = 'app:goToSession'

export function goToSession(sessionId: string): void {
  window.dispatchEvent(new CustomEvent(GO_TO_SESSION_EVENT, { detail: { sessionId } }))
}

/** Listen for Go to: select that session and show the sessions view. A
 *  session that is no longer open is a no-op. Returns the unsubscribe. */
export function listenGoToSession(showSessions: () => void): () => void {
  const onGoTo = (e: Event) => {
    const detail = (e as CustomEvent).detail as { sessionId?: unknown } | undefined
    const id = detail?.sessionId
    if (typeof id !== 'string' || !id) return
    const store = useSessionStore.getState()
    if (!store.sessions.some((s) => s.id === id)) return
    store.setActiveSession(id)
    showSessions()
  }
  window.addEventListener(GO_TO_SESSION_EVENT, onGoTo)
  return () => window.removeEventListener(GO_TO_SESSION_EVENT, onGoTo)
}
