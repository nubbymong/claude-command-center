import React from 'react'
import { useSshCloseStore, endRemoteAndClose, leaveRunningAndClose } from '../stores/sshCloseStore'

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
    <div className="absolute inset-0 bg-base/80 z-[60] flex items-center justify-center" role="dialog" aria-modal="true" aria-labelledby="ssh-close-heading">
      <div className="bg-surface0 border border-surface1 rounded-lg shadow-2xl p-6 max-w-sm w-full mx-4">
        <h2 id="ssh-close-heading" className="text-lg font-semibold text-text mb-2">
          Close “{pending.label}”?
        </h2>
        <p className="text-sm text-overlay1 mb-1">
          This session is running <span className="text-text font-medium">persistently</span> on the remote host
          {pending.host ? <> (<span className="font-mono text-xs">{pending.host}</span>)</> : null}.
        </p>
        <p className="text-xs text-overlay0 mb-4">
          End it to stop the remote tmux session and clean up, or leave it running so you can
          reattach later{pending.remoteAccount ? <> — signed in as <span className="font-mono">{pending.remoteAccount}</span></> : null}.
        </p>
        <div className="flex flex-col gap-2">
          <button
            onClick={end}
            disabled={busy}
            className="w-full py-2 px-4 text-sm font-medium rounded bg-red hover:bg-red/85 text-crust transition-colors disabled:opacity-50"
            data-testid="ssh-close-end"
          >
            {busy ? 'Ending…' : 'End remote session'}
          </button>
          <button
            onClick={leave}
            disabled={busy}
            className="w-full py-2 px-4 text-sm font-medium rounded bg-surface1 hover:bg-surface2 text-text transition-colors disabled:opacity-50"
            data-testid="ssh-close-leave"
          >
            Leave running (reattach later)
          </button>
          <button
            onClick={clear}
            disabled={busy}
            className="w-full py-1.5 px-4 text-xs text-overlay0 hover:text-overlay1 transition-colors disabled:opacity-50"
            data-testid="ssh-close-cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
