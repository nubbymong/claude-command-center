import { create } from 'zustand'
import { useSessionStore } from './sessionStore'
import { killSessionPty } from '../ptyTracker'

// SSH tmux enhancement (item 4): a one-slot store for the "you're closing a
// PERSISTENT remote session" confirmation. Any close call site (tab close,
// sidebar context menu, Delete key) routes through `requestCloseSession`; for a
// persistent SSH session that opens the dialog rather than tearing the tab down
// immediately, so the user can choose to END the remote (tmux kill-session) or
// LEAVE it running (detach + reattach later). Every other session closes
// straight away, exactly as before.

interface PendingSshClose {
  sessionId: string
  /** Display name for the dialog copy. */
  label: string
  /** The remote account descriptor, when known — shown so the user knows which
   *  remote they're ending. */
  remoteAccount?: string
  host?: string
}

interface SshCloseState {
  pending: PendingSshClose | null
  request: (p: PendingSshClose) => void
  clear: () => void
}

export const useSshCloseStore = create<SshCloseState>((set) => ({
  pending: null,
  request: (p) => set({ pending: p }),
  clear: () => set({ pending: null }),
}))

/** Close a session, first checking whether it is a persistent SSH session that
 *  warrants the End-vs-Leave-running choice. Non-persistent / non-SSH sessions
 *  close immediately (kill the local PTY + drop the tab). */
export function requestCloseSession(sessionId: string): void {
  const store = useSessionStore.getState()
  const session = store.sessions.find((s) => s.id === sessionId)
  // Only a session confirmed running inside a tmux persistence wrapper gets the
  // choice — a non-persistent SSH session's remote dies with the connection, so
  // there is nothing to leave running or to end.
  if (session && session.sessionType === 'ssh' && session.sshTmuxPersistent === true) {
    useSshCloseStore.getState().request({
      sessionId,
      label: session.customName?.trim() || session.label,
      remoteAccount: session.sshRemoteAccount,
      host: session.sshConfig ? `${session.sshConfig.username}@${session.sshConfig.host}` : undefined,
    })
    return
  }
  killSessionPty(sessionId)
  store.removeSession(sessionId)
}

/** "End remote": kill the remote tmux session + sidecars over a separate ssh
 *  exec, then tear down the local tab. */
export async function endRemoteAndClose(sessionId: string): Promise<void> {
  try {
    await window.electronAPI.ssh.endRemote(sessionId)
  } catch {
    // Best-effort — even if the end exec couldn't be dispatched, still close the
    // local tab (the remote at worst detaches, exactly the pre-enhancement path).
  }
  killSessionPty(sessionId)
  useSessionStore.getState().removeSession(sessionId)
  useSshCloseStore.getState().clear()
}

/** "Leave running": detach only — the remote tmux session survives for a later
 *  reattach. Identical to a plain close (which, for a live SSH PTY, detaches). */
export function leaveRunningAndClose(sessionId: string): void {
  killSessionPty(sessionId)
  useSessionStore.getState().removeSession(sessionId)
  useSshCloseStore.getState().clear()
}
