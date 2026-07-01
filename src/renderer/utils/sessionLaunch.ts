// src/renderer/utils/sessionLaunch.ts
//
// Small pure helpers for the session-launch path in TerminalView, extracted so
// the launch decisions are unit-testable (TerminalView itself is xterm-bound).
import type { ProviderId } from '../../shared/types'

/**
 * Whether a session launch should pop the multi-account picker
 * (AccountLaunchGate) before spawning.
 *
 * Account isolation is a CLAUDE-only concept: each Claude account gets a
 * private `~/.claude` home via `withProfileHome`. Codex auth lives in
 * `~/.codex` and is NOT profile-scoped, and an SSH session runs under the
 * REMOTE host's own login, so neither must ever show the Claude account picker.
 * The old gate checked only `shellOnly` + a session record + `profileCount >= 2`
 * and so fired for Codex (BUG-1) and SSH (BUG-13) sessions whenever a second
 * Claude account profile existed. Provider- + SSH-gating fixes that.
 */
export function shouldGateAccountChoice(opts: {
  shellOnly?: boolean
  hasSession: boolean
  profileCount: number
  provider?: ProviderId
  isSsh?: boolean
}): boolean {
  const provider = opts.provider ?? 'claude'
  return !opts.shellOnly && opts.hasSession && opts.profileCount >= 2 && provider === 'claude' && !opts.isSsh
}

/**
 * Whether the mid-session "Switch Account" control applies to a session (the
 * Sidebar context menu + the SessionStatusStrip pill). Same rule as the launch
 * gate minus the launch-only conditions: account profiles are LOCAL Claude only,
 * so Codex (own OpenAI login) and SSH (remote host's login) sessions can never
 * switch a local CCC profile even when 2+ profiles exist (BUG-13).
 */
export function canSwitchAccountForSession(opts: {
  provider?: ProviderId
  isSsh?: boolean
  profileCount: number
}): boolean {
  const provider = opts.provider ?? 'claude'
  return opts.profileCount >= 2 && provider === 'claude' && !opts.isSsh
}

/**
 * Render a PTY-spawn failure into a readable, single-line terminal message.
 *
 * The renderer used to fire `pty.spawn` without catching, so a main-process
 * throw (e.g. "Codex CLI not found on PATH") became a silent unhandled
 * rejection and a blank terminal (BUG-2). We now surface it in the terminal;
 * this strips the IPC `invoke` wrapper noise so the user sees the real cause.
 */
export function formatSpawnError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? 'unknown error')
  const cleaned = raw
    .replace(/^Error invoking remote method '[^']*':\s*/i, '')
    .replace(/^(Uncaught )?Error:\s*/i, '')
    .trim()
  return cleaned || 'unknown error'
}
