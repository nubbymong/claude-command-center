import React, { useEffect, useState } from 'react'
import { isSshPersistenceFailureReason, formatPersistenceUnavailableMessage } from '../../shared/ssh-tmux-persistence'
import { parseDockerPostCommand, isContainerRuntime } from '../../shared/container-command'
import { useSessionStore } from '../stores/sessionStore'
import { DialogButton } from './ui/Dialog'

interface Props {
  sessionId: string
  hasPostCommand: boolean
  shellOnly: boolean
  /** When true, skip the overlay entirely and let pty-manager run the
   * legacy auto state machine. Local sessions also skip via not-mounting. */
  enabled: boolean
  /** item 5 (resume cascade): respawn the whole session. Used by the "no host"
   *  connection-failure branch's Retry, which cannot recover by re-writing the
   *  claude command (the PTY is dead) -- only a full re-spawn reconnects. */
  onRetry?: () => void
}

type FlowState =
  | 'connecting'
  | 'awaiting-postcommand'
  | 'awaiting-claude'
  | 'running-postcommand'
  | 'running-setup'
  | 'running-claude'
  | 'claude-running'
  | 'shell-only'
  | 'skipped'
  | 'failed'

/**
 * In-pane overlay shown over an SSH terminal pane while in manual flow.
 * Each stage offers a single primary button and an "I'll do it myself"
 * skip — the user decides exactly when setup blobs / postCommand /
 * claudeCmd are written. Eliminates the prompt-detection guessing
 * that has caused multiple paste-leak bugs.
 *
 * Auto-hides once Claude is running, or on `skipped`. The terminal
 * remains fully interactive at all times — the overlay sits in a
 * top-right corner of the pane, not over the whole pane.
 *
 * NOT a modal: there is no backdrop and the terminal underneath stays live,
 * so this keeps its own positioned card (and its z-30) rather than taking
 * DialogOverlay/DialogPanel. Only the colours move onto the tokens, and the
 * real buttons become DialogButtons (#360).
 */
export default function SshFlowOverlay({ sessionId, hasPostCommand, shellOnly, enabled, onRetry }: Props) {
  const [state, setState] = useState<FlowState>('connecting')
  const [info, setInfo] = useState<string | undefined>(undefined)
  // Copilot review, #298: only a session main has REPORTED as tmux-wrapped has
  // something running on the far side to come back to.
  const isPersistent = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId)?.sshTmuxPersistent) === true
  // Persistence-unavailable warning gate (owner UX, 2026-08-31): only warn when
  // persistence was actually WANTED. Main forces it OFF for a standard session
  // (detachable === false) or a container runtime (runtime.type === 'container'),
  // so probe=none is the NORMAL, expected outcome there — not a failure. Mirror
  // main's gate (pty-manager writeClaudeCmd: detachable !== false && !container)
  // so the overlay never alarms a session that never tried to persist.
  const sshConfig = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId)?.sshConfig)
  // effectiveRuntime mirrors pty-manager's SSH spawn EXACTLY (incl. the #572
  // legacy-docker fallback): a free-text `postCommand: 'sudo docker exec …'`
  // with no structured runtime is ALSO a container session for which main
  // forces persistence off — so probe=none is normal there too and must not
  // alarm. Checking only runtime?.type missed that class.
  const effectiveRuntime = sshConfig?.runtime ?? parseDockerPostCommand(sshConfig?.postCommand ?? '') ?? undefined
  const wantedPersistence = sshConfig?.detachable !== false && !isContainerRuntime(effectiveRuntime)
  const [busy, setBusy] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    const off = window.electronAPI.ssh.onFlowState(sessionId, (msg) => {
      setState(msg.state as FlowState)
      setInfo(msg.info)
      // Reset busy on state changes that follow our action.
      if (msg.state !== 'running-postcommand' && msg.state !== 'running-setup' && msg.state !== 'running-claude') {
        setBusy(false)
      }
      if (msg.state === 'failed') setErrorText(msg.info ?? 'See app.log for details.')
      else setErrorText(null)
    })

    // Catch-up: query main for the current state in case the controller
    // already emitted before this useEffect ran. Polls every 500 ms while
    // we're still 'connecting' so we don't sit there forever showing
    // "Waiting for SSH login" if a push got missed. Stops as soon as the
    // state advances OR the catch-up window runs out (~30 s).
    let attempt = 0
    const MAX_ATTEMPTS = 60
    let timer: number | null = null
    const tryFetch = async () => {
      if (cancelled) return
      attempt += 1
      try {
        const cur = await window.electronAPI.ssh.getState(sessionId)
        if (cancelled) return
        if (cur && cur.state) {
          setState(cur.state as FlowState)
          setInfo(cur.info)
          // Stop polling as soon as we see a non-connecting state — the
          // push channel will drive subsequent transitions.
          if (cur.state !== 'connecting') return
        }
      } catch { /* noop */ }
      if (attempt < MAX_ATTEMPTS && !cancelled) {
        timer = window.setTimeout(tryFetch, 500)
      }
    }
    tryFetch()

    return () => {
      cancelled = true
      if (timer != null) window.clearTimeout(timer)
      off()
    }
  }, [sessionId, enabled])

  if (!enabled) return null

  // Hide overlay once we're past the user-action stages.
  if (
    state === 'claude-running'
    || state === 'shell-only'
    || state === 'skipped'
  ) {
    return null
  }

  const isRunning = state === 'running-postcommand' || state === 'running-setup' || state === 'running-claude'
  const isAwaitingPostCommand = state === 'awaiting-postcommand'
  const isAwaitingClaude = state === 'awaiting-claude'

  const runPostCommand = async () => {
    setBusy(true)
    setErrorText(null)
    try { await window.electronAPI.ssh.runPostCommand(sessionId) } catch { setBusy(false) }
  }
  const launchClaude = async () => {
    setBusy(true)
    setErrorText(null)
    try { await window.electronAPI.ssh.launchClaude(sessionId) } catch { setBusy(false) }
  }
  const skip = async () => {
    try { await window.electronAPI.ssh.skip(sessionId) } catch { /* noop */ }
  }

  // item 1/2 honesty: a tmux stage/push IS an install on the host -- say so
  // plainly rather than the cryptic "Injecting statusline (tmux-stage)".
  const isTmuxInstall = state === 'running-setup' && (info === 'tmux-stage' || info === 'tmux-push' || (typeof info === 'string' && info.startsWith('staging tmux')))
  const headline =
    state === 'connecting' ? 'Connecting…' :
    isAwaitingPostCommand ? (hasPostCommand ? 'Run post-connect command?' : 'Launch Claude?') :
    isAwaitingClaude ? (info === 'inner' ? 'Inner shell ready — launch Claude?' : 'Launch Claude?') :
    state === 'running-postcommand' ? 'Running post-connect command…' :
    isTmuxInstall ? 'Installing a lightweight tmux…' :
    state === 'running-setup' ? `Injecting statusline (${info || 'host'})…` :
    // item 7: distinguish a reconnect-reattach from a first launch.
    state === 'running-claude' ? (info === 'reattach' ? 'Reconnecting to your session…' : 'Launching Claude…') :
    state === 'failed' ? (info === 'connection' ? 'Couldn’t reach the host' : 'Setup failed') :
    ''

  const mutedStyle: React.CSSProperties = { color: 'var(--text-muted)' }

  return (
    <div
      className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-30 w-[460px] max-w-[80%] rounded-lg shadow-xl backdrop-blur-sm px-4 py-3 text-xs"
      style={{
        background: 'color-mix(in srgb, var(--surface-raised) 95%, transparent)',
        border: '1px solid var(--border-subtle)',
        color: 'var(--text-primary)',
      }}
    >
      <div className="flex items-center gap-2 mb-1.5">
        <span className="font-medium" style={{ color: 'var(--text-primary)' }}>{headline}</span>
        {isRunning && (
          <span className="inline-block w-2 h-2 rounded-full animate-pulse" style={{ background: 'var(--brand)' }} aria-hidden />
        )}
      </div>
      {state === 'connecting' && (
        <div className="text-[11px]" style={mutedStyle}>Waiting for SSH login.</div>
      )}
      {isAwaitingPostCommand && (
        <div className="space-y-1.5">
          <p className="text-[11px] leading-snug" style={mutedStyle}>
            {hasPostCommand
              ? 'Pre-commands you want to run by hand? Do them in the terminal first, then click below.'
              : (shellOnly
                  ? 'You\'re configured for a shell-only session. Click skip to drop into the shell.'
                  : 'Click below to inject the statusline shim and launch Claude.')}
          </p>
          <div className="flex gap-1.5">
            {hasPostCommand ? (
              <>
                <DialogButton
                  variant="primary"
                  onClick={runPostCommand}
                  disabled={busy}
                >
                  Run post-connect command
                </DialogButton>
                {!shellOnly && (
                  <DialogButton
                    variant="secondary"
                    onClick={launchClaude}
                    disabled={busy}
                    title="Skip the post-connect command and launch Claude on the host"
                  >
                    Launch Claude on host
                  </DialogButton>
                )}
              </>
            ) : (
              <DialogButton
                variant="primary"
                onClick={launchClaude}
                disabled={busy}
              >
                Launch Claude
              </DialogButton>
            )}
            <DialogButton
              variant="ghost"
              onClick={skip}
              title="Manage manually — no auto writes"
            >
              Skip
            </DialogButton>
          </div>
        </div>
      )}
      {isAwaitingClaude && (
        <div className="space-y-1.5">
          <p className="text-[11px] leading-snug" style={mutedStyle}>
            {info === 'inner'
              ? 'You\'re inside the post-connect shell (e.g. docker container). Clicking will re-run setup here so Claude finds its settings, then launch Claude.'
              : 'Inject statusline shim and launch Claude.'}
          </p>
          <div className="flex gap-1.5">
            <DialogButton
              variant="primary"
              onClick={launchClaude}
              disabled={busy}
            >
              Launch Claude
            </DialogButton>
            <DialogButton
              variant="ghost"
              onClick={skip}
              title="Manage manually — no auto writes"
            >
              Skip
            </DialogButton>
          </div>
        </div>
      )}
      {state === 'running-claude' && info === 'reattach' && (
        <div className="text-[11px] leading-snug mb-1" style={mutedStyle}>
          Your remote session was still alive — reattaching. If it had ended, we resume your
          conversation automatically.
        </div>
      )}
      {isTmuxInstall && (
        <div className="text-[11px] leading-snug mb-1" style={mutedStyle}>
          The host doesn’t have tmux, so we’re installing a small static copy under
          <span className="font-mono"> ~/.claude/bin</span> to keep this session alive if the
          connection drops. Nothing is installed system-wide.
        </div>
      )}
      {/* #242 tier 5: every tmux-ladder tier that gave up already forwards its
          reason onto this SAME 'running-claude' info field (tmux-stage-fail:*,
          tmux-push-fail:*, or the probe=none default) -- this was previously
          rendered nowhere, so the ladder degrading to a bare claude launch was
          indistinguishable from it succeeding. Shown only for the narrow
          'running-claude' window before the idle-fallback latches
          claude-running and the whole overlay unmounts (see the hide check
          above) -- brief, but the alternative was never showing it at all. */}
      {state === 'running-claude' && wantedPersistence && isSshPersistenceFailureReason(info) && (
        <div className="text-[11px] leading-snug mb-1" style={{ color: 'var(--status-warning)' }}>
          {formatPersistenceUnavailableMessage(info!)}
        </div>
      )}
      {isRunning && (
        <div className="text-[11px]" style={mutedStyle}>
          Watching for completion sentinel. App.log has step-by-step trace.
        </div>
      )}
      {state === 'failed' && info === 'connection' && (
        <div className="space-y-1.5">
          {/* Copilot review, #298: the reassurance is only TRUE when this
              session is known to have reached a persistent (tmux-wrapped)
              remote. On a first connect that never got that far, or one that
              died before tmux started, there is nothing on the far side to pick
              back up, and promising otherwise is worse than saying nothing. */}
          <p className="text-[11px] leading-snug" style={{ color: 'var(--status-danger)' }}>
            {isPersistent
              ? 'Couldn’t reach the host — it may be offline or asleep. Nothing was lost: your remote session is still running there, and reconnecting will pick it back up.'
              : 'Couldn’t reach the host — it may be offline or asleep. Check the address and that the machine is awake, then retry.'}
          </p>
          <div className="flex gap-1.5">
            <DialogButton
              variant="primary"
              onClick={() => onRetry?.()}
              disabled={!onRetry}
              testId="ssh-retry-connection"
            >
              Retry connection
            </DialogButton>
          </div>
        </div>
      )}
      {state === 'failed' && info !== 'connection' && (
        <div className="space-y-1.5">
          <p className="text-[11px]" style={{ color: 'var(--status-danger)' }}>{errorText || 'Step did not complete.'}</p>
          <div className="flex gap-1.5">
            <DialogButton
              variant="primary"
              onClick={launchClaude}
            >
              Retry Launch
            </DialogButton>
            <DialogButton
              variant="ghost"
              onClick={skip}
            >
              Skip
            </DialogButton>
          </div>
        </div>
      )}
    </div>
  )
}
