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
 * `~/.codex` and is NOT profile-scoped, so a Codex launch must never show the
 * Claude account picker. The old gate checked only `shellOnly` + a session
 * record + `profileCount >= 2` and so fired for Codex sessions whenever a
 * second Claude account profile existed (BUG-1). Provider-gating fixes that.
 */
export function shouldGateAccountChoice(opts: {
  shellOnly?: boolean
  hasSession: boolean
  profileCount: number
  provider?: ProviderId
}): boolean {
  const provider = opts.provider ?? 'claude'
  return !opts.shellOnly && opts.hasSession && opts.profileCount >= 2 && provider === 'claude'
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
