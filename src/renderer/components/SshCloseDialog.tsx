import React from 'react'
import { useSshCloseStore, endRemoteAndClose, leaveRunningAndClose } from '../stores/sshCloseStore'
import { DialogOverlay, DialogPanel, DialogHeader, DialogBody, DialogFooter, DialogButton, useDialogEscape } from './ui/Dialog'

// SSH tmux enhancement (items 4 + 11): the confirmation shown when closing a
// PERSISTENT remote session. "End remote session" runs tmux kill-session +
// sidecar cleanup on the host (over a separate ssh exec) then closes the tab.
// "Leave running" detaches only — the remote stays alive so it can be
// reattached later. Closing straight away (the old behaviour) silently
// stranded the remote, which is the exact wart this closes.
export default function SshCloseDialog() {
  const pending = useSshCloseStore((s) => s.pending)
  const clear = useSshCloseStore((s) => s.clear)
  const [busy, setBusy] = React.useState(false)
  useDialogEscape(pending ? clear : undefined, !busy)

  if (!pending) return null

  const end = async () => {
    setBusy(true)
    try {
      await endRemoteAndClose(pending.sessionId)
    } finally {
      setBusy(false)
    }
  }
  const leave = () => leaveRunningAndClose(pending.sessionId)

  return (
    <DialogOverlay position="absolute" z="z-[60]" testId="ssh-close-dialog">
      <DialogPanel width="w-[440px]" labelledBy="ssh-close-heading">
        <DialogHeader
          titleId="ssh-close-heading"
          title={<>Close “{pending.label}”?</>}
          subtitle={<>
            This session is running <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>persistently</span> on the remote host
            {pending.host ? <> (<span className="font-mono text-[11px]">{pending.host}</span>)</> : null}.
          </>}
        />
        <DialogBody>
          <p className="text-xs leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
            End it to stop the remote tmux session and clean up, or leave it running so you can
            reattach later{pending.remoteAccount ? <> — signed in as <span className="font-mono">{pending.remoteAccount}</span></> : null}.
          </p>
        </DialogBody>
        {/* "End remote session" kills the remote tmux session, so it leads on
            the left with a solid danger fill and is deliberately NOT in the
            rightmost slot -- that is where every other confirm in the app puts
            its SAFE default, and muscle memory would otherwise end the remote
            instead of leaving it running. "Leave running" is the safe default
            and takes the focus. */}
        <DialogFooter
          left={
            <DialogButton variant="danger-solid" onClick={end} disabled={busy} testId="ssh-close-end">
              {busy ? 'Ending…' : 'End remote session'}
            </DialogButton>
          }
        >
          <DialogButton variant="ghost" onClick={clear} disabled={busy} testId="ssh-close-cancel">Cancel</DialogButton>
          <DialogButton variant="secondary" onClick={leave} disabled={busy} autoFocus testId="ssh-close-leave">Leave running (reattach later)</DialogButton>
        </DialogFooter>
      </DialogPanel>
    </DialogOverlay>
  )
}
