import { create } from 'zustand'
import { readSshEndRemoteResult } from '../../shared/ssh-end-result'
import { manualContainerStopCommand } from '../../shared/container-command'
import { randomId } from '../../shared/id'

// The one End outcome the user has to act on (live T24, 2026-09-25): the
// remote session was ended, but Claude may still be running inside a rootful
// container, because sudo could not run the container engine without a
// password and none was saved in the config when the session started. Every
// End call in the renderer goes through endRemoteAndReport, so the notice is
// raised in ONE place and shown by ONE surface (SshEndNoticeDialog),
// whichever action ended the session.

export interface SshEndNotice {
  id: string
  /** The SSH host the End exec dialled, when it can be shown as one plain
   *  token (readSshEndRemoteResult); absent, the notice says "the SSH host". */
  host?: string
  /** The validated container name. */
  container: string
  /** The command that stops this session's Claude in that container, run on
   *  the host: built here from the session id and the validated name only. */
  command: string
}

interface SshEndNoticeState {
  /** Oldest first; the dialog shows the first. */
  notices: SshEndNotice[]
  show: (n: SshEndNotice) => void
  dismiss: () => void
}

/** How long each notice ignores Escape and its own buttons after it appears
 *  (SshEndNoticeDialog). It opens 1 to 20 seconds after the tab closed,
 *  usually while the user is typing somewhere else, so a keystroke or a click
 *  meant for that must not dismiss it unread. */
export const SSH_END_NOTICE_ARM_MS = 800

export const useSshEndNoticeStore = create<SshEndNoticeState>((set) => ({
  notices: [],
  show: (n) => set((s) => ({ notices: [...s.notices, n] })),
  dismiss: () => set((s) => ({ notices: s.notices.slice(1) })),
}))

/**
 * Read what End did and, for 'container-needs-sudo', queue the notice. Every
 * other outcome, and any result that fails validation, shows nothing: End has
 * always been best-effort and silent when it finishes normally.
 */
export function reportSshEndResult(sessionId: string, result: unknown): void {
  const r = readSshEndRemoteResult(result)
  if (!r || r.outcome !== 'container-needs-sudo' || !r.container) return
  const command = manualContainerStopCommand(sessionId, r.container.engine, r.container.name)
  if (!command) return
  useSshEndNoticeStore.getState().show({
    id: randomId(),
    ...(r.container.host !== undefined ? { host: r.container.host } : {}),
    container: r.container.name,
    command,
  })
}

/**
 * Ask main to END a remote session, and report the outcome when it arrives.
 * Callers do not wait for it before tearing the local session down: main reads
 * the End target the moment the call arrives, and one renderer's IPC messages
 * reach main in order, so a local kill sent after this cannot lose it. That
 * is why every caller runs this BEFORE its pty kill (and before dropping a
 * resume entry): the order is the contract. Never throws (no preload in tests
 * or early boot, or a failed invoke).
 */
export function endRemoteAndReport(sessionId: string, target: string | { sessionId: string; configId?: string }): void {
  try {
    const pending = window.electronAPI?.ssh?.endRemote?.(target)
    void Promise.resolve(pending).then((r) => reportSshEndResult(sessionId, r)).catch(() => {})
  } catch {
    /* preload not available: the caller still closes */
  }
}
