// Close a batch of sessions the way every "close all" path did inline
// (Sidebar's bulk close and its five per-group closes, 2.1.1): kill the PTY,
// forget the SSH browser profile, then drop the store record -- in that order,
// once per id.
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
