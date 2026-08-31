import { create } from 'zustand'
import { useSessionStore } from './sessionStore'
import { useWebviewStore } from './webviewStore'
import { useDetachedRemotesStore } from './detachedRemotesStore'
import { killSessionPty } from '../ptyTracker'
import { buildDetachedRemote } from '../utils/detachedRemotes'
import { persistSessionState } from '../session-persistence'

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

/**
 * Drop everything the browser pane kept for a session that is going away (#371).
 *
 * A pane runs in `persist:webview-<sessionId>`, which Chromium turns into a
 * profile directory holding that pane's cookies, localStorage and cache.
 * Session ids are minted per tile and never reused, so nothing ever came back
 * for one: every closed tile left a populated profile on disk for the life of
 * the install, with logged-in cookies for whatever had been browsed in it.
 * (`webviewStore.reset` had no callers at all, so even the in-memory pane state
 * leaked.)
 *
 * Call this ONLY where the user is closing a session for good. It is
 * deliberately NOT inside `sessionStore.removeSession`, which the Restart button
 * and an in-tile account switch also call — those re-add the SAME id a moment
 * later, and signing the user out of every site in the pane on a restart would
 * be its own bug.
 */
export function forgetSessionBrowserProfile(sessionId: string): void {
  useWebviewStore.getState().reset(sessionId)
  // Fire and forget: a profile that will not clear must never block a tab close.
  try {
    void Promise.resolve(window.electronAPI?.webview?.forget?.(sessionId)).catch(() => {})
  } catch {
    /* preload not available (tests, early boot) — the tab still closes */
  }
}

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
  forgetSessionBrowserProfile(sessionId)
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
  // SSH Persistent (Phase 1 lifecycle): the remote is being ended, so drop any
  // left-running registry entry for this id — it must never be offered for
  // reattach again. No-op when the id was never registered (the common case:
  // ending a LIVE session that was never left running), and then the End path is
  // untouched — only a real registry change triggers the durable flush below.
  const hadEntry = useDetachedRemotesStore.getState().entries.some((e) => e.sessionId === sessionId)
  useDetachedRemotesStore.getState().remove(sessionId)
  killSessionPty(sessionId)
  forgetSessionBrowserProfile(sessionId)
  useSessionStore.getState().removeSession(sessionId)
  useSshCloseStore.getState().clear()
  if (hadEntry) void persistSessionState()
}

/** "Leave running": detach only — the remote tmux session survives for a later
 *  reattach. Identical to a plain close (which, for a live SSH PTY, detaches),
 *  plus SSH Persistent (Phase 1): record the detached remote in the persisted
 *  registry BEFORE teardown so the resume surface can later offer to reattach it.
 *  Launching the config again does NOT consult this — that always starts new. */
export function leaveRunningAndClose(sessionId: string): void {
  // Capture the entry while the session is still in the store. Non-SSH / config-
  // less sessions yield null (buildDetachedRemote guards), so this is a no-op for
  // anything that has nothing to reattach.
  const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
  const entry = buildDetachedRemote(session, Date.now())
  if (entry) useDetachedRemotesStore.getState().add(entry)
  killSessionPty(sessionId)
  forgetSessionBrowserProfile(sessionId)
  useSessionStore.getState().removeSession(sessionId)
  useSshCloseStore.getState().clear()
  // Persist immediately so the entry survives an app restart even if the app is
  // closed before the debounced session autosave fires (best-effort).
  if (entry) void persistSessionState()
}
