/**
 * ssh-tmux.ts — pure builder for the tmux launch wrapper that gives SSH
 * Claude sessions reconnect-safe persistence (#242), extracted from
 * pty-manager (mirroring the #241 ssh-args.ts pattern) so the argv/command
 * shape is unit-testable without the full pty-manager dependency graph.
 *
 * `tmux new-session -A -s ccc-<safeSid> <cmd>` — `-A` means "attach if a
 * session by this name already exists, else create it", so a fresh SSH
 * connection and a reconnect run through the EXACT SAME command. There is
 * no separate "reconnect" code path to keep in sync with the first launch.
 *
 * No default export (project convention).
 */

/**
 * Allowlist for a tmux binary path (adversarial review, #242 BLOCKER).
 *
 * #242 round-3 correction (I3): the tier-1/2 `tmux=` sentinel field this
 * guard used to gate (`setup ok ... tmux=(\S+)`, pty-manager.ts's
 * parseTmuxSentinel) no longer carries a path at all -- generateRemoteSetupScript
 * (ssh-shim.ts) now emits a fixed CLASS (`path`/`home`/`none`), and
 * buildTmuxLaunchCommand below never reads a wire-reported path for either
 * tier-1 or the staged tiers (see ON_PATH_TMUX_BIN_EXPR/STAGED_TMUX_BIN_EXPR).
 * This allowlist's remaining job is the tier-3/4 stage/push "ok path=..."
 * sentinel (parseTmuxStageSentinel, pty-manager.ts) -- a value kept ONLY for
 * logging/diagnostics (buildTmuxLaunchCommand never reads it either), still
 * raw remote PTY output an attacker able to write to the terminal (a
 * MOTD/profile hook, another user's `wall`/`write` on a shared host) can
 * plant. A DENYLIST for a value that ends up in log/IPC text must anticipate
 * every metacharacter and a miss is silent; this mirrors the codebase's own
 * precedent for the same shape of problem — `SAFE_REMOTE_PATH_RE` in
 * ssh-shim.ts — which is an ALLOWLIST.
 */
export const SAFE_TMUX_BIN_RE = /^[A-Za-z0-9_./-]+$/

/**
 * Boolean form of the allowlist guard, for callers that need to degrade a
 * hostile value safely (parseTmuxStageSentinel, pty-manager.ts) rather than
 * throw.
 */
export function isSafeTmuxBin(tmuxBin: string): boolean {
  return !tmuxBin.startsWith('-') && SAFE_TMUX_BIN_RE.test(tmuxBin)
}

/**
 * The one and only path a LEGITIMATELY staged/pushed tmux binary can ever be
 * at: `buildTmuxStageScript`/`buildTmuxPushControlScript` both install to
 * this exact shell-expanded location (`$HOME/.claude/bin/tmux`), nowhere
 * else. Round-2 correction (#242 finding F1(a)): an earlier version of this
 * module accepted whatever path a tier-3/4 "ok" sentinel REPORTED, as long
 * as it ended with "/.claude/bin/tmux" -- insufficient, because
 * `mkdir -p /tmp/.claude/bin` succeeds for any co-tenant on a shared host, so
 * both `/tmp/.claude/bin/tmux` and the double-slash `/tmp/x//.claude/bin/tmux`
 * satisfy an ends-with test while pointing at attacker-controlled bytes
 * (demonstrated end to end in adversarial review round 5, WITH a valid
 * nonce). There is no ends-with/denylist fix for that -- "ends with the
 * right suffix" and "is under the user's home" are different questions, and
 * answering the second one for real would need a `realpath` round trip this
 * app has no way to run before deciding what to write.
 *
 * The actual fix: for a staged tier, the remote-reported path is never
 * trusted for command construction at all. `buildTmuxLaunchCommand` below
 * embeds THIS literal token instead and lets the REMOTE shell expand
 * `$HOME` for the account the SSH session actually authenticated as -- the
 * sentinel that comes back over the wire then carries no
 * attacker-controllable operand for the staged tier, so this control holds
 * even against an attacker who can ALSO read the tty (can copy the nonce
 * verbatim, but there is nothing left to substitute). `"$HOME"` is quoted
 * (handles a home directory containing whitespace) while the fixed suffix
 * is not (a compile-time literal with no shell metacharacters, safe
 * unquoted) -- standard partial-quoting.
 */
export const STAGED_TMUX_BIN_EXPR = '"$HOME"/.claude/bin/tmux'

/**
 * #242 round-3 correction (I3): the tier-1/2 sibling of STAGED_TMUX_BIN_EXPR.
 * `isPinnedTmuxPath`/`assertPinnedTmuxPath` used to let a validated-but-still
 * wire-reported absolute path reach this sink for tier 1/2 (the "found on
 * PATH" case) -- a validate-then-trust gate the two functions' own doc
 * comments already admitted does NOT defeat an attacker-controlled absolute
 * path with no traversal (e.g. "/tmp/.x/tmux"), because a real PATH tmux can
 * legitimately live almost anywhere. Deleted rather than patched: the fix
 * available for the staged tier (never read the wire value at all) applies
 * here just as well. `command -v tmux` re-run on the remote, at launch time,
 * by the SAME authenticated shell the setup probe ran in, answers the exact
 * question tier 1 needs ("is tmux on this user's PATH") with no
 * wire-reported operand in the sink at all -- generateRemoteSetupScript
 * (ssh-shim.ts) now emits a CLASS (`path`/`home`/`none`), never a path, for
 * exactly this reason. Quoted as a single command-substitution token so a
 * PATH entry containing whitespace can't split the argument.
 */
export const ON_PATH_TMUX_BIN_EXPR = '"$(command -v tmux)"'

/**
 * Sanitize a CCC session id into a tmux-safe session name. Mirrors the
 * `safeSid` rule in ssh-shim.ts (generateRemoteSetupScript / getSshSettingsPath)
 * so the same sessionId maps to the same identifier everywhere it is
 * embedded on the remote host, and so a session id containing shell
 * metacharacters or spaces can't break out of the `-s <name>` argument.
 */
function safeSid(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')
}

/**
 * POSIX single-quote a shell argument: wrap in `'…'`, and for every literal
 * `'` inside, close the quote, emit an escaped literal quote, reopen the
 * quote (`'\''`). `innerCmd` is built from CCC-controlled/config-derived
 * fragments (see writeClaudeCmd in pty-manager.ts) — this exists so a
 * config value that happens to contain a single quote (e.g. --extra-args)
 * can't break out of tmux's single argument.
 */
function singleQuote(str: string): string {
  return `'${str.replace(/'/g, `'\\''`)}'`
}

export interface TmuxLaunchInput {
  /** CCC session id — sanitized into the tmux session name `ccc-<safeSid>`. */
  sessionId: string
  /**
   * #242 round-3 correction (I3): selects which entry of a fixed,
   * host-authored literal table to embed as the leading token -- NEVER a
   * value read off the wire. `true` for a tier-2/3/4 binary at (or staged
   * to) `$HOME/.claude/bin/tmux` -- embeds `STAGED_TMUX_BIN_EXPR`. `false`
   * for a tier-1 binary found on the remote's PATH -- embeds
   * `ON_PATH_TMUX_BIN_EXPR` (`"$(command -v tmux)"`), which re-resolves PATH
   * in the remote shell at launch time rather than trusting any
   * remote-reported path string. Both literals are evaluated by the REMOTE
   * shell in the authenticated user's own environment, so there is no
   * attacker-controllable operand in this sink for either case (see
   * generateRemoteSetupScript's `tmux=path|home|none` CLASS sentinel,
   * ssh-shim.ts, and parseTmuxSentinel, pty-manager.ts, which is all this
   * module now needs to know to pick between the two).
   */
  staged: boolean
  /**
   * The full inner command to run inside the tmux session — the CLAUDE_*
   * env-var prefix followed by `claude` and its flags, exactly as
   * pty-manager would have written it directly to the PTY without tmux.
   * Passed as tmux's single `<shell-cmd>` argument (single-quoted) so
   * tmux's `sh -c` carries the env vars through to claude — they must NOT
   * be exported as separate tokens before the tmux binary token, because
   * tmux's own launch environment does not come from this command line.
   */
  innerCmd: string
}

/**
 * Build the tmux wrapper around a Claude launch command for an SSH session.
 *
 * Produces, for a tier-1 (`staged: false`) binary:
 *   `"$(command -v tmux)" new-session -A -s ccc-<safeSid> '<innerCmd>'`
 * and for a tier-2/3/4 (`staged: true`) binary:
 *   `"$HOME"/.claude/bin/tmux new-session -A -s ccc-<safeSid> '<innerCmd>'`
 * -- literally `ON_PATH_TMUX_BIN_EXPR` / `STAGED_TMUX_BIN_EXPR`, NEVER a
 * value this function receives from the caller. #242 round-3 correction
 * (I3): an earlier version took a `tmuxBin` string here for the `staged:
 * false` case, validated it (`isPinnedTmuxPath`) against exactly the same
 * "absolute, no traversal" shape STAGED_TMUX_BIN_EXPR's own doc comment
 * already admitted was insufficient for the staged case -- a real PATH tmux
 * can legitimately live almost anywhere, so that check could not rule out
 * an attacker-controlled absolute path either. Deleted rather than patched:
 * neither branch needs a wire-reported path at all. `isPinnedTmuxPath`/
 * `assertPinnedTmuxPath` are gone with it.
 *
 * Statusline finding + decision (adversarial review, #242 MAJOR): once
 * claude runs inside a tmux pane, its controlling terminal is the PTY tmux
 * allocated for that PANE, not the outer ssh/sshd PTY the local Conductor
 * reads from. The statusline shim's existing `/dev/tty` + ancestor-pts
 * fallback (ssh-shim.ts) would land on that pane pty, and tmux does not
 * relay an unrecognised OSC sequence from a pane to its client unless
 * `allow-passthrough` is on AND the sequence is wrapped in tmux's DCS
 * passthrough form — neither of which this codebase did before #242, so the
 * statusline would silently stop updating for every SSH session the moment
 * this wrapper shipped.
 *
 * DECISION: rather than opt in to allow-passthrough + DCS wrapping (fragile:
 * depends on the remote's tmux version and config, and every future OSC use
 * would need the same wrapping), the shim instead BYPASSES the pane pty
 * entirely. When `$TMUX` is set, it asks the tmux server itself for
 * `#{client_tty}` — the device path of the tty the ATTACHED CLIENT (the
 * outer ssh session) is on — and writes the sentinel straight to that
 * device. That is the same physical PTY the local Conductor already reads
 * from pre-#242, so no tmux forwarding/passthrough is involved at all. See
 * the `$TMUX` branch in SSH_STATUSLINE_SHIM (ssh-shim.ts).
 */
export function buildTmuxLaunchCommand(input: TmuxLaunchInput): string {
  const sid = safeSid(input.sessionId)
  const tmuxBinToken = input.staged ? STAGED_TMUX_BIN_EXPR : ON_PATH_TMUX_BIN_EXPR
  return `${tmuxBinToken} new-session -A -s ccc-${sid} ${singleQuote(input.innerCmd)}`
}

/**
 * Tier 5 degradation (#242): whether THIS write of the claude launch
 * command should carry `--continue`.
 *
 * `--continue` resumes the most recent conversation for the launch cwd —
 * the only way a user gets their conversation back on a reconnect when NO
 * tmux tier (1-4) is in play, since without tmux the previous `claude`
 * process (if the connection merely dropped rather than the process
 * exiting) is gone and a fresh one starts with no history.
 *
 * `tmuxInPlay` gates this OFF, not just `reconnect` gating it ON: when a
 * tmux binary is available, `buildTmuxLaunchCommand`'s `-A` already
 * reattaches to whatever `claude` is still running inside the named
 * session — that IS the reconnect path, and it needs no `--continue` at
 * all. Adding it anyway would run a SECOND `claude` inside the SAME
 * attached tmux pane (the first one, if still alive, never exited), which
 * is wrong regardless of `reconnect`. See buildTmuxLaunchCommand's own doc
 * comment for why `-A` makes reconnect and first-connect the identical
 * command — this function is the deliberate exception to that story: the
 * bare (non-tmux) launch has NO such single code path, so reconnect has to
 * be signalled explicitly via a flag instead.
 */
export interface SshContinueFlagInput {
  /** SSHOptions.reconnect (#242) — true when this spawn respawns a session
   *  that had previously reached claude-running, set by the renderer. */
  reconnect: boolean
  /** True when THIS write wraps the launch in `tmux new-session -A`
   *  (pty-manager's `tmuxWrapped`) — i.e. a usable binary was detected,
   *  staged, or pushed for this session. */
  tmuxInPlay: boolean
}

/**
 * Pure predicate extracted so the gating logic is unit-testable without
 * pty-manager's dependency graph (mirrors why buildTmuxLaunchCommand itself
 * lives here rather than inline in pty-manager.ts). Both directions matter:
 * dropping the `reconnect` check would add `--continue` to every bare
 * first-connect launch (wrong — nothing to continue yet); dropping the
 * `!tmuxInPlay` check would add it even when `-A` already reattaches
 * (wrong — a second claude in an already-live pane).
 */
export function shouldAddContinueFlag(input: SshContinueFlagInput): boolean {
  return input.reconnect && !input.tmuxInPlay
}

/**
 * Build the extra claude CLI flags (currently just `--continue`, when
 * applicable) pty-manager appends to the bare (non-tmux-wrapped) launch
 * command on a write. Returns `''` when nothing should be added, so callers
 * can splice it in with the same `filter(Boolean).join(' ')` shape the rest
 * of pty-manager's claudeFlags assembly already uses.
 */
export function buildSshClaudeFlags(input: SshContinueFlagInput): string {
  return shouldAddContinueFlag(input) ? '--continue' : ''
}
