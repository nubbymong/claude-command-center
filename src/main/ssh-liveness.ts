/**
 * ssh-liveness.ts — pure builders + parser for the SSH Persistent "is the remote
 * still alive?" probe, kept out of pty-manager (mirroring ssh-tmux.ts / ssh-args.ts)
 * so the remote command and its output parse are unit-testable without the native
 * ssh/pty stack. No default export (project convention).
 *
 * A detached remote is no longer in `sshTargetBySession`, so the resume flow must
 * ask the host directly whether the `ccc-<safeSid(sessionId)>` tmux session it left
 * running is still there before offering (or auto-resuming) it — never offer a dead
 * session. This module owns the exact remote command and the parse; the exec itself
 * (execFile / prompt-answering PTY, mirroring endSshRemote) lives in pty-manager.
 */
import { stripAnsiForSentinel } from './ansi-strip'
import { ON_PATH_TMUX_BIN_EXPR, STAGED_TMUX_BIN_EXPR, safeSid } from './ssh-tmux'

/**
 * Completion sentinels bracketing the tmux-name region. They exist to tell a
 * COMPLETED probe (host answered, shell ran the command — maybe with zero tmux
 * sessions) apart from a CONNECTION FAILURE (auth/unreachable/timeout). `tmux ls`
 * legitimately exits non-zero when no server is running, so exit code cannot make
 * that distinction; a trailing sentinel that only prints if the shell reached the
 * end of the command can. Fixed literals — never interpolated with a wire value.
 */
export const TMUX_LIVENESS_BEGIN = '__CCC_TMUX_LIVE_BEGIN__'
export const TMUX_LIVENESS_END = '__CCC_TMUX_LIVE_END__'

/**
 * The remote command run over a one-shot ssh exec. HOST-AUTHORED LITERAL with
 * ZERO wire-supplied operands (the #242 argv/command posture): it lists tmux
 * session NAMES from both the tier-1 on-PATH tmux (`command tmux`) and the
 * tier-2/3/4 staged tmux (`"$HOME"/.claude/bin/tmux`) — the SAME two fixed tokens
 * the launch wrapper embeds — bracketed by the completion sentinels. Errors from
 * either tmux (not installed at that tier, or no server) are swallowed
 * (`2>/dev/null`) so a missing tier never masks the sentinel. `#{session_name}` is
 * single-quoted so the remote shell does not treat the leading `#` as a comment.
 *
 * The candidate session ids are NOT in this command: they are matched LOCALLY
 * (computeLiveSessionIds) against the returned names via safeSid, so no untrusted
 * value ever reaches the remote shell.
 */
/**
 * Every place a tmux binary can live on a host we support, as HOST-AUTHORED
 * LITERALS (rc.14 review F11, aicc_planning#55). The probe runs over a
 * NON-LOGIN ssh exec whose PATH is minimal: on macOS a Homebrew tmux lives in
 * /opt/homebrew/bin (arm64) or /usr/local/bin (intel), which only a login shell
 * adds to PATH -- so `command tmux` alone came back empty there, the probe
 * still printed its completion sentinel, and a VERIFIED-EMPTY answer pruned
 * live Remote Resumable entries. The End command (buildRemoteTmuxKillCommand in
 * providers/claude/ssh-shim.ts) already tries these same locations for the
 * same reason; a test pins the two lists to each other so they cannot drift
 * apart again.
 */
export const TMUX_LIVENESS_BIN_EXPRS: readonly string[] = [
  ON_PATH_TMUX_BIN_EXPR,
  '/opt/homebrew/bin/tmux',
  '/usr/local/bin/tmux',
  '/usr/bin/tmux',
  STAGED_TMUX_BIN_EXPR,
]

export function buildTmuxListCommand(): string {
  const lists = TMUX_LIVENESS_BIN_EXPRS.map((bin) => `${bin} ls -F '#{session_name}' 2>/dev/null; `).join('')
  return (
    `echo ${TMUX_LIVENESS_BEGIN}; ` +
    lists +
    `echo ${TMUX_LIVENESS_END}`
  )
}

/**
 * Parse the probe's raw stdout/PTY output. `completed` is true iff the END
 * sentinel came back (the shell ran the whole command) — the caller reads that as
 * "verified", its absence as "unverified" (fail-open). `names` are the tmux
 * session names between the sentinels, ANSI-stripped, trimmed, de-duped (both tmux
 * tiers can list the same session). Robust to a login banner before BEGIN and to
 * CR/LF and ANSI noise over a PTY.
 */
export function parseTmuxLivenessOutput(raw: string): { completed: boolean; names: string[] } {
  const clean = stripAnsiForSentinel(raw)
  const lines = clean.split(/\r?\n/).map((l) => l.trim())
  const endIdx = lines.lastIndexOf(TMUX_LIVENESS_END)
  if (endIdx === -1) return { completed: false, names: [] }
  const beginIdx = lines.indexOf(TMUX_LIVENESS_BEGIN)
  const from = beginIdx === -1 ? 0 : beginIdx + 1
  const names = lines
    .slice(from, endIdx)
    .filter((l) => l.length > 0 && l !== TMUX_LIVENESS_BEGIN && l !== TMUX_LIVENESS_END)
  return { completed: true, names: Array.from(new Set(names)) }
}

/**
 * Given the queried CCC session ids and the tmux session NAMES the host reported,
 * return the subset of ids whose `ccc-<safeSid(id)>` target is alive. safeSid is
 * the SAME sanitization the launch wrapper uses to name the tmux session, so the
 * names line up exactly. Pure set intersection — a hostile/garbage id simply fails
 * to match any live name (it can never reach the remote shell).
 */
export function computeLiveSessionIds(sessionIds: string[], liveNames: Iterable<string>): string[] {
  const alive = liveNames instanceof Set ? liveNames : new Set(liveNames)
  return sessionIds.filter((id) => alive.has(`ccc-${safeSid(id)}`))
}
