/**
 * ssh-tmux.ts — pure builder for the tmux launch wrapper that gives SSH
 * Claude sessions reconnect-safe persistence (#242), extracted from
 * pty-manager (mirroring the #241 ssh-args.ts pattern) so the argv/command
 * shape is unit-testable without the full pty-manager dependency graph.
 *
 * The wrapper is a has-session conditional: `if tmux has-session -t
 * ccc-<safeSid>; then tmux attach; else tmux new-session -s ccc-<safeSid>
 * <cmd>; fi`. The attach branch reattaches a still-running claude; the
 * fresh branch (reached when the session is gone, e.g. after a remote
 * reboot) creates a new one, resuming the conversation via `--continue`
 * on a reconnect. See buildTmuxLaunchCommand for why the earlier
 * `new-session -A` one-liner could not tell those two cases apart and so
 * launched a blank chat on reconnect-after-reboot (item 6).
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
 * exactly this reason.
 *
 * Follow-up adversarial pass (fail-posture MAJOR): this used to be
 * `"$(command -v tmux)"`. The DETECTION probe runs `command -v tmux` through
 * `execSync` (a non-interactive `sh -c`, where aliases do not exist), but this
 * token is expanded by the remote's INTERACTIVE login shell -- and there
 * `command -v` prints an alias DEFINITION (`alias tmux='tmux -2'`) rather than a
 * path for anyone who aliases tmux in their rc file. Quoted as one word that is
 * exit 127 and no claude, on every connect, where the pre-#242 bare launch
 * always worked. `command tmux` is the alias- AND function-proof form: `command`
 * is a POSIX special builtin that bypasses shell functions, and `tmux` sits in
 * argument position where alias expansion never applies. It remains a
 * compile-time literal with no wire-reported operand, which is the property
 * this constant exists to guarantee, and the remote's own PATH lookup still
 * happens in the authenticated user's shell at launch time.
 */
export const ON_PATH_TMUX_BIN_EXPR = 'command tmux'

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
   *
   * IMPORTANT: pass the BARE claude command WITHOUT `--continue`. This
   * builder appends `--continue` itself, and ONLY on the fresh-create
   * branch of the has-session wrapper (see `reconnect` below and
   * buildTmuxLaunchCommand's doc comment) -- never on the attach branch,
   * where a second claude in an already-live pane would be wrong.
   */
  innerCmd: string
  /**
   * SSH tmux enhancement (item 6 — silent-blank-chat fix): true when this
   * spawn respawns a session that had previously reached claude-running
   * (SSHOptions.reconnect). Gates whether the wrapper's FRESH-create branch
   * appends `--continue` to `innerCmd`.
   *
   * The bug this closes: the pre-enhancement wrapper was `new-session -A`,
   * which cannot tell "attach to the still-running claude" from "the tmux
   * server/session is gone (remote reboot), create a fresh one" -- and
   * `--continue` was statically suppressed whenever tmux was in play. So a
   * reconnect after the remote rebooted created a fresh session and launched
   * claude with NO `--continue`, i.e. a blank chat even though the remote
   * transcript still existed. The has-session wrapper splits those two cases
   * apart: the attach branch reattaches the live claude (no flag, correct),
   * and the fresh branch — reached only when the session is genuinely gone —
   * launches with `--continue` on a reconnect so the conversation resumes.
   */
  reconnect: boolean
}

/**
 * Build the tmux wrapper around a Claude launch command for an SSH session.
 *
 * SSH tmux enhancement (item 6): the wrapper is now an explicit has-session
 * conditional rather than `new-session -A`, so a reconnect can tell "the
 * session is still alive, attach to it" apart from "the session is gone
 * (remote reboot), create a fresh one and resume the conversation". Produces,
 * for a tier-1 (`staged: false`) binary (#546 mouse-off elided as `<mo>` =
 * `command tmux set-option -t ccc-<sid> mouse off 2>/dev/null`):
 *   `if command tmux has-session -t ccc-<sid> 2>/dev/null; then`
 *   ` <mo>; command tmux attach -t ccc-<sid> || <fresh>;`
 *   ` else <fresh>; fi`   where <fresh> =
 *   ` command tmux new-session -s ccc-<sid> '<mo>; <innerCmd[ --continue]>'`
 * and for a tier-2/3/4 (`staged: true`) binary the identical shape with
 * `"$HOME"/.claude/bin/tmux` as the token. The leading token is literally
 * `ON_PATH_TMUX_BIN_EXPR` / `STAGED_TMUX_BIN_EXPR`, NEVER a value this
 * function receives from the caller (the #242 RCE sink is unchanged: no
 * wire-reported path reaches the command). `has-session`/`attach`/
 * `new-session`/`then`/`else`/`fi`/`2>/dev/null` are all compile-time
 * literals with no operand an attacker controls; `ccc-<sid>` is safeSid-
 * sanitized; `<innerCmd>` is single-quoted exactly as before.
 *
 * `--continue` is appended to the FRESH-create branch's inner command only
 * (never the attach branch, never on a first connect) — see TmuxLaunchInput.
 * reconnect. That is the whole silent-blank-chat fix: on a reconnect where
 * the remote session vanished, the fresh claude resumes the conversation;
 * on an attach it does not double-launch.
 *
 * #242 round-3 correction (I3): an earlier version took a `tmuxBin` string
 * here for the `staged:
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
  const target = `ccc-${sid}`
  // #546: force mouse mode OFF for CCC's own tmux session so classic
  // drag-selection works even when the remote user's ~/.tmux.conf has
  // `set -g mouse on` -- with mouse on, tmux captures the drag and xterm never
  // sees it, defeating CLAUDE_CODE_DISABLE_MOUSE. This is SESSION-scoped (no
  // `-g`) and `-t ${target}`, so it overrides the user's global for OUR session
  // only and never touches their other tmux sessions. Every operand is a
  // compile-time literal or the safeSid-sanitized target -- no wire-reported
  // value reaches this command (the #242 sink posture is unchanged). Errors are
  // swallowed (old tmux with no `mouse` option, or the server briefly gone) so
  // the launch always falls through to claude -- fail-open toward running.
  // Also force the tmux STATUS BAR off for CCC's own session. Two reasons, both
  // CCC-specific: it is visual clutter inside CCC's embedded terminal (CCC draws
  // its own session chrome), and — the reason it lives here — a visible status
  // bar REPAINTS on tmux's `status-interval` (default 15s), and every repaint is
  // PTY output that resets the watchdog's silence clock, so the sleep indicator
  // would never fire over a tmux-wrapped SSH session (owner, 2026-08-31: the
  // watchdog must track CLAUDE movement, not tmux heartbeats). Session-scoped
  // (`-t ${target}`, no `-g`) and error-swallowed, exactly like the mouse-off
  // beside it — it never touches the user's other sessions and always falls
  // through to claude.
  const mouseOff =
    `${tmuxBinToken} set-option -t ${target} mouse off 2>/dev/null; ` +
    `${tmuxBinToken} set-option -t ${target} status off 2>/dev/null`
  // Fresh-create branch only: resume the prior conversation on a reconnect
  // where the remote session was gone. Appended to innerCmd BEFORE quoting so
  // it rides inside tmux's single `<shell-cmd>` argument, next to `claude`.
  const claudeInner = input.reconnect ? `${input.innerCmd} --continue` : input.innerCmd
  // The mouse-off runs INSIDE the freshly-created pane (where the session is
  // live and addressable), then claude; both ride tmux's single quoted arg.
  const freshInner = `${mouseOff}; ${claudeInner}`
  const fresh = `${tmuxBinToken} new-session -s ${target} ${singleQuote(freshInner)}`
  // has-session/attach is NOT atomic: the session can die (claude exits, remote
  // reboots) in the gap between `has-session` returning 0 and `attach` running
  // (measured ~10ms on a real host), and a bare `attach` then fails with
  // "no sessions"/"can't find session", leaving NO claude while CCC's idle
  // fallback still latches claude-running -- a blank remote shell reported as a
  // live session (adversarial review, 2026-08-18). Fall the attach THROUGH to a
  // fresh create (with --continue on a reconnect, exactly like the else branch)
  // so a lost race self-heals instead of stranding the user.
  // Attach branch: the session already exists, so set the option from the outer
  // shell (server reachable — has-session just returned 0) BEFORE attaching, so
  // a reattach to a session created by an older CCC (or before this fix) is also
  // forced mouse-off.
  return (
    `if ${tmuxBinToken} has-session -t ${target} 2>/dev/null; ` +
    `then ${mouseOff}; ${tmuxBinToken} attach -t ${target} || ${fresh}; ` +
    `else ${fresh}; fi`
  )
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
 * tmux binary is available, `buildTmuxLaunchCommand`'s has-session wrapper
 * OWNS the `--continue` decision itself — its attach branch reattaches the
 * still-running `claude` (no flag) and its fresh-create branch appends
 * `--continue` on a reconnect. So the bare-launch flag this function
 * computes must stay OFF whenever tmux is in play, or a reconnect would get
 * `--continue` twice (once here, once inside the wrapper's fresh branch).
 * The bare (non-tmux) launch has no such internal branch, so reconnect has
 * to be signalled explicitly via this flag instead.
 */
export interface SshContinueFlagInput {
  /** SSHOptions.reconnect (#242) — true when this spawn respawns a session
   *  that had previously reached claude-running, set by the renderer. */
  reconnect: boolean
  /** True when THIS write wraps the launch in the tmux has-session wrapper
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
