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
 * Printed once per tmux binary that actually EXISTS on the host, right before
 * that binary's listing (rc.14 review F11). Without it, a host whose tmux lives
 * somewhere none of the candidates cover produced BEGIN..END with nothing in
 * between -- indistinguishable from "tmux ran and found no sessions" -- and the
 * store took that verified-empty answer as proof of death. A run that reached
 * END but printed no FOUND is now "the shell ran, but no authoritative probe
 * did": unverified, and the entries stay.
 */
export const TMUX_LIVENESS_FOUND = '__CCC_TMUX_FOUND__'

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
  // Each candidate is probed for existence FIRST, and only an existing binary
  // prints the FOUND marker and lists. `command -v` for the on-PATH form, `-x`
  // for the fixed paths; both are POSIX sh. Everything stays a literal.
  //
  // rc.15 review R8 (aicc_planning#55 adjacent): `ls` runs FIRST, with its exit
  // status and its output (stdout AND stderr) captured; only then is FOUND
  // printed, carrying the status, followed by the captured lines. FOUND used to
  // precede the listing with stderr discarded, so a client that existed but
  // could not talk to a still-running server (a protocol mismatch after a tmux
  // upgrade, a permission error) printed FOUND and nothing else -- exactly the
  // shape of "no sessions" -- and a live detached session was pruned as dead.
  // The parser now classifies each frame from its status and text.
  const lists = TMUX_LIVENESS_BIN_EXPRS.map((bin) => {
    const exists = bin === ON_PATH_TMUX_BIN_EXPR ? 'command -v tmux >/dev/null 2>&1' : `[ -x ${bin} ]`
    return `${exists} && { __ccc_o=$(${bin} ls -F '#{session_name}' 2>&1); __ccc_s=$?; echo "${TMUX_LIVENESS_FOUND} $__ccc_s"; printf '%s\\n' "$__ccc_o"; }; `
  }).join('')
  return (
    `echo ${TMUX_LIVENESS_BEGIN}; ` +
    lists +
    `echo ${TMUX_LIVENESS_END}`
  )
}

/**
 * Parse the probe's raw stdout/PTY output. `completed` is true iff the run is
 * AUTHORITATIVE: the END sentinel came back (the shell ran the whole command)
 * AND at least one tmux binary printed FOUND (an actual tmux answered). The
 * caller reads that as "verified", anything else as "unverified" (fail-open):
 * no END is a connection/auth failure; END without FOUND is a host where none
 * of the candidate binaries exist, which must never read as "no sessions".
 * `shellCompleted` / `tmuxFound` are exposed for logging. `names` are the tmux
 * session names between the sentinels, ANSI-stripped, trimmed, de-duped (several
 * binaries can list the same session). Robust to a login banner before BEGIN and
 * to CR/LF and ANSI noise over a PTY.
 */
/** What one found tmux binary reported (rc.15 review R8). */
export interface TmuxCandidateFrame {
  /** The `ls` exit status; null when the FOUND line carried none or garbage. */
  status: number | null
  /** 'names': status 0, `lines` are session names (possibly none) -- authoritative.
   *  'no-server': a non-zero status whose text is tmux saying no server exists --
   *  authoritative empty. 'error': anything else (a protocol mismatch, a
   *  permission error, a crash, a malformed frame) -- an operational failure
   *  that says nothing about the sessions: the host is UNVERIFIED. */
  outcome: 'names' | 'no-server' | 'error'
  lines: string[]
}

/** tmux's own words for "there is no server", the ONLY non-zero exits that count
 *  as an authoritative empty answer. Anchored to the phrasings tmux uses (3.x
 *  `no server running on <path>`; older `error connecting to <path> (No such
 *  file or directory)` / `failed to connect to server: No such file or
 *  directory`). A permission error, a protocol mismatch or a lost server never
 *  match: the server may well be alive with the user's sessions in it. */
const TMUX_NO_SERVER_RE = /no server running on|error connecting to \S+ \(No such file or directory\)|failed to connect to server: No such file or directory/

function classifyFrame(status: number | null, lines: string[]): TmuxCandidateFrame['outcome'] {
  if (status === 0) return 'names'
  if (status === null) return 'error'
  return TMUX_NO_SERVER_RE.test(lines.join('\n')) ? 'no-server' : 'error'
}

export function parseTmuxLivenessOutput(raw: string): {
  completed: boolean
  shellCompleted: boolean
  tmuxFound: boolean
  names: string[]
  frames: TmuxCandidateFrame[]
  /** Why the run is not authoritative, for the log; null when it is. */
  unverifiedReason: string | null
} {
  const clean = stripAnsiForSentinel(raw)
  const lines = clean.split(/\r?\n/).map((l) => l.trim())
  const endIdx = lines.lastIndexOf(TMUX_LIVENESS_END)
  if (endIdx === -1) return { completed: false, shellCompleted: false, tmuxFound: false, names: [], frames: [], unverifiedReason: 'no completion sentinel (connection or auth failure)' }
  // The LAST BEGIN before that END, not the first in the buffer (adversarial
  // pass on #598): BEGIN and END are matched symmetrically, so text printed
  // BEFORE the command ran -- a login banner, a MOTD, anything a host-side
  // actor can author -- cannot contribute a forged FOUND marker and session
  // names to the body. Only what the shell printed between the probe's own
  // sentinels counts. (A session NAMED like the BEGIN sentinel empties the body
  // and reads as unverified -- fail-open, never a false "live".)
  const beginIdx = lines.lastIndexOf(TMUX_LIVENESS_BEGIN, endIdx)
  const from = beginIdx === -1 ? 0 : beginIdx + 1
  const body = lines.slice(from, endIdx)
  // Frames: each FOUND line (with the status the builder appends) opens one;
  // the non-empty lines after it, up to the next FOUND, are that binary's
  // output. A FOUND with no status, or one the builder could not have written,
  // is a malformed frame and reads as an error (fail-open), never as empty.
  const frames: TmuxCandidateFrame[] = []
  let current: { status: number | null; lines: string[] } | null = null
  for (const line of body) {
    if (line === TMUX_LIVENESS_FOUND || line.startsWith(TMUX_LIVENESS_FOUND + ' ')) {
      const tail = line.slice(TMUX_LIVENESS_FOUND.length).trim()
      current = { status: /^\d{1,3}$/.test(tail) ? Number(tail) : null, lines: [] }
      frames.push({ ...current, outcome: 'error' })
      continue
    }
    if (!current || line.length === 0 || line === TMUX_LIVENESS_BEGIN) continue
    current.lines.push(line)
    frames[frames.length - 1].lines = current.lines
  }
  for (const f of frames) f.outcome = classifyFrame(f.status, f.lines)
  const tmuxFound = frames.length > 0
  if (!tmuxFound) return { completed: false, shellCompleted: true, tmuxFound: false, names: [], frames, unverifiedReason: 'no tmux binary answered at any candidate path' }
  // ANY operational failure makes the host unverified, even beside a candidate
  // that answered: a client that cannot talk to a running server is evidence
  // that a server the other client did not see may exist.
  const failed = frames.find((f) => f.outcome === 'error')
  if (failed) {
    const why = failed.status === null ? 'malformed FOUND frame' : `tmux ls exited ${failed.status}: ${failed.lines.join(' | ').slice(0, 200) || '(no output)'}`
    return { completed: false, shellCompleted: true, tmuxFound: true, names: [], frames, unverifiedReason: why }
  }
  const names = frames.filter((f) => f.outcome === 'names').flatMap((f) => f.lines)
  return { completed: true, shellCompleted: true, tmuxFound: true, names: Array.from(new Set(names)), frames, unverifiedReason: null }
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
