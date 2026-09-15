import { killSessionPty } from '../ptyTracker'
import { forgetSessionBrowserProfile } from '../stores/sshCloseStore'
import { useSessionStore } from '../stores/sessionStore'

export function closeSessionBatch(sessionIds: Iterable<string>): void {
  const { removeSession } = useSessionStore.getState()
  for (const id of sessionIds) {
    killSessionPty(id)
    forgetSessionBrowserProfile(id)
    removeSession(id)
  }
}
