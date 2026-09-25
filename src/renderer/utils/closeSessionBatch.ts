// Close a batch of sessions the way every "close all" path did inline
// (Sidebar's bulk close and its five per-group closes, 2.1.1): kill the PTY,
// forget the SSH browser profile, then drop the store record -- in that order,
// once per id.
//
// A CONTAINER SSH session first gets the End that closing its tab alone runs
// (requestCloseSession's container branch, endContainerSessionRemote): its
// claude runs inside the container, one hop past the connection the kill
// drops, and dropping that connection does not end it. Before this, a bulk
// close left it running there, with no notice. End goes out before the kill
// (main reads its target as the call arrives; the kill drops it). Every other
// session closes exactly as before.
import { killSessionPty } from '../ptyTracker'
import { forgetSessionBrowserProfile, endContainerSessionRemote } from '../stores/sshCloseStore'
import { useSessionStore } from '../stores/sessionStore'

export function closeSessionBatch(sessionIds: Iterable<string>): void {
  const { removeSession } = useSessionStore.getState()
  for (const id of sessionIds) {
    endContainerSessionRemote(useSessionStore.getState().sessions.find((s) => s.id === id))
    killSessionPty(id)
    forgetSessionBrowserProfile(id)
    removeSession(id)
  }
}
