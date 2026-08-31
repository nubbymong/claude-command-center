import React from 'react'
import { useSessionStore } from '../stores/sessionStore'
import { useRestartSession } from '../hooks/useRestartSession'
import { DialogButton } from './ui/Dialog'

// SSH Persistent (resume liveness) — the app-restart notice. On relaunch a
// persistent SSH session auto-reattaches; if the liveness probe confirms the
// remote tmux it was coming back to is GONE, this session is really a fresh start,
// not the one left running. Rather than silently hand the user a blank session
// that looks like their old one, surface a compact, dismissible notice with an
// explicit "Start new". Sits in the top-right of the pane like SshFlowOverlay (not
// a modal — the terminal underneath stays live).
//
// SELF-SUBSCRIBING (by sessionId, the SshFlowOverlay pattern): the flag is
// ephemeral and flips asynchronously AFTER restore, and it is not a structural
// field the app shell re-renders on — so this component reads it straight from the
// store and renders nothing until it is set. App mounts it for every SSH pane.
export default function SshReattachGoneNotice({ sessionId }: { sessionId: string }) {
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId))
  const updateSession = useSessionStore((s) => s.updateSession)
  const { restart } = useRestartSession(session)

  if (!session || !session.sshRemoteReattachGone) return null

  const dismiss = () => updateSession(sessionId, { sshRemoteReattachGone: undefined })
  const startNew = () => {
    // Clear the notice AND the reconnect latch, then re-spawn: a genuinely new
    // session (the fresh-create branch launches claude WITHOUT --continue), which
    // is what "Start new" means — not a resume of the gone conversation.
    updateSession(sessionId, { sshRemoteReattachGone: undefined, sshReachedClaudeRunning: false })
    restart({ sshReachedClaudeRunning: false, sshRemoteReattachGone: undefined })
  }

  return (
    <div
      className="absolute top-2 right-2 z-30 w-[320px] max-w-[70%] rounded-lg shadow-xl backdrop-blur-sm px-3 py-2.5 text-xs"
      style={{
        background: 'color-mix(in srgb, var(--surface-raised) 96%, transparent)',
        border: '1px solid color-mix(in srgb, var(--status-warning) 40%, transparent)',
        color: 'var(--text-primary)',
      }}
      data-testid="ssh-reattach-gone-notice"
    >
      <div className="font-medium mb-1" style={{ color: 'var(--status-warning)' }}>
        Remote session ended
      </div>
      <p className="text-[11px] leading-snug mb-2" style={{ color: 'var(--text-muted)' }}>
        The session you left running on the host is gone — it may have ended or the machine
        rebooted. This is a fresh start.
      </p>
      <div className="flex gap-1.5 justify-end">
        <DialogButton variant="ghost" onClick={dismiss} testId="ssh-reattach-gone-dismiss">Dismiss</DialogButton>
        <DialogButton variant="primary" onClick={startNew} testId="ssh-reattach-gone-startnew">Start new</DialogButton>
      </div>
    </div>
  )
}
