/**
 * ssh-tmux.ts — pure builder for the tmux launch wrapper that gives SSH
 * Claude sessions reconnect-safe persistence (#242), extracted from
 * pty-manager (mirroring the #241 ssh-args.ts pattern) so the argv/command
 * shape is unit-testable without the full pty-manager dependency graph.
 *
 * The wrapper is a has-session conditional: `if tmux has-session -t
 * =ccc-<safeSid>; then tmux attach; else tmux new-session -s ccc-<safeSid>
 * <cmd>; fi`. The attach branch reattaches a still-running claude; the
 * fresh branch (reached when the session is gone, e.g. after a remote
 * reboot) creates a new one, resuming the conversation via `--continue`
 * on a reconnect. See buildTmuxLaunchCommand for why the earlier
 * `new-session -A` one-liner could not tell those two cases apart and so
 * launched a blank chat on reconnect-after-reboot (item 6).
 *
 * No default export (project convention).
 */

import {
  TMUX_WHEEL_UP_KEYNAME,
  TMUX_WHEEL_DOWN_KEYNAME,
  TMUX_WHEEL_EXIT_KEYNAME,
  TMUX_WHEEL_LINES_PER_NOTCH,
  TMUX_WHEEL_NOOP_COMMAND,
} from '../shared/tmux-wheel'

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
 * #85 — the tmux key bindings that turn CCC's private wheel keys into
 * copy-mode scrollback movement. See src/shared/tmux-wheel.ts for the whole
 * design (why the wheel breaks under tmux, why `mouse on` is not the fix, and
 * which bytes the renderer writes).
 *
 * Ten commands across three key tables:
 *
 *   root           every key -> no-op  (nothing can leak to the pane; the
 *                                       down/exit keys keep this binding, and
 *                                       the up key's is overwritten last)
 *   copy-mode      exit -> `send -X cancel`
 *                  up   -> `send -X -N 3 scroll-up`
 *                  down -> `send -X -N 3 scroll-down`
 *   copy-mode-vi   the same three (see `inCopyMode` below for why both tables)
 *   root           up   -> `copy-mode -e`  (ENTER the scrollback view; `-e`
 *                                           leaves it again on its own once
 *                                           the user is back at the live
 *                                           bottom) -- LAST, see the ordering
 *                                           note on `commands`
 *
 * Each binding is a SINGLE tmux command. A multi-command binding needs a `\;`
 * INSIDE the binding, and a `;` that reaches tmux unescaped does not bind — it
 * ends the bind-key command and RUNS the rest immediately (`not in a mode`,
 * observed against tmux 3.4 on 2026-09-20). The renderer compensates for the
 * root binding being entry-only by sending the up-key twice on the first notch.
 *
 * WHY THESE RUN BESIDE THE SESSION OPTIONS, NOT ONCE UP FRONT. `bind-key` is
 * server-scoped and needs no target, so hoisting it ahead of the whole
 * has-session conditional looks free — and silently does nothing: a tmux server
 * with no sessions EXITS as soon as its last client leaves, so each hoisted
 * `bind-key` started a server, bound the key, and took the binding down with it
 * (verified 2026-09-20 — the keys arrived at the pane as raw bytes). They have
 * to run where a session already exists: the attach branch's pre-attach options
 * and the fresh pane's own options.
 *
 * That means three copies on one command line, so the six bindings ride ONE
 * tmux invocation, separated by `\;` arguments, and use tmux's standard short
 * aliases (`bind`/`set`/`send`). The line is read by the remote tty in
 * canonical mode, where anything past ~4 KiB is silently truncated — with the
 * full names and one invocation each this fix alone added ~1.4 KiB.
 *
 * The `\;` survives both quoting levels: the outer login shell (attach branch)
 * and tmux's own `sh -c` inside `new-session` (fresh branch, where the whole
 * inner command is singleQuote'd and the backslash therefore reaches that
 * inner shell intact) each turn `\;` into a lone `;` ARGUMENT, which is what
 * tmux's parser splits commands on.
 *
 * SCOPE. Unlike the session options beside them these bindings are visible to
 * the user's other tmux sessions on the same host. Accepted deliberately: the
 * keys are ctrl+alt+F10/F11/F12, which nothing else binds, and tmux has no
 * session-scoped binding table — the `key-table` session option REPLACES the
 * root table rather than adding to it, which would silently drop every other
 * root binding the user has.
 *
 * Trust posture is unchanged from the options beside it (#242): `tmuxBinToken`
 * is one of the two compile-time binary expressions, every other operand is a
 * compile-time literal, and no wire-reported value reaches the command. Errors
 * are swallowed (`2>/dev/null`) so an old tmux that rejects a binding still
 * falls through to launching claude — the wheel is worth less than the session.
 */
export function buildTmuxWheelBindings(tmuxBinToken: string): string {
  const bind = (table: string, key: string, command: string): string =>
    `bind -T ${table} ${key} ${command}`
  const scroll = (direction: 'up' | 'down'): string =>
    `send -X -N ${TMUX_WHEEL_LINES_PER_NOTCH} scroll-${direction}`
  // BOTH copy-mode tables, not just the one `mode-keys emacs` should have
  // selected. That option is set with an error-swallowed `set-option -w`, and a
  // swallowed failure here does not degrade gracefully -- it strands the user
  // IN copy-mode with the leave key unbound, eating every keystroke. Observed
  // for real on the attach branch (2026-09-20), where the window target had to
  // be corrected; covering both tables means the wheel no longer depends on
  // that option landing at all.
  const inCopyMode = (table: string): string[] => [
    bind(table, TMUX_WHEEL_EXIT_KEYNAME, 'send -X cancel'),
    bind(table, TMUX_WHEEL_UP_KEYNAME, scroll('up')),
    bind(table, TMUX_WHEEL_DOWN_KEYNAME, scroll('down')),
  ]
  // ORDER IS THE SAFETY PROPERTY (adversarial review, 2026-09-20). tmux runs a
  // `\;` list until the FIRST failure and KEEPS what already ran -- it is not
  // all-or-nothing, and `2>/dev/null` hides which command stopped it. Two
  // partial states were reproduced on tmux 3.4:
  //   - nothing bound at all      -> tmux forwards the keys to the PANE, i.e.
  //                                  raw `ESC [ 24;7~` typed at claude.
  //   - root bound, copy-mode not -> the user ENTERS the scrollback view with
  //                                  no leave key, and CCC has the status line
  //                                  off, so their typing vanishes with no hint.
  // So the list is ordered worst-last: every key is first bound to the silent
  // no-op (nothing can leak from here on), then the copy-mode tables get their
  // leave key BEFORE their scroll keys, and only the very last command turns
  // the up-key into the copy-mode ENTRY. Any prefix of this list is safe: the
  // wheel does less, never more, and it can never open a view it cannot close.
  const commands = [
    bind('root', TMUX_WHEEL_EXIT_KEYNAME, TMUX_WHEEL_NOOP_COMMAND),
    bind('root', TMUX_WHEEL_DOWN_KEYNAME, TMUX_WHEEL_NOOP_COMMAND),
    bind('root', TMUX_WHEEL_UP_KEYNAME, TMUX_WHEEL_NOOP_COMMAND),
    ...inCopyMode('copy-mode'),
    ...inCopyMode('copy-mode-vi'),
    bind('root', TMUX_WHEEL_UP_KEYNAME, 'copy-mode -e'),
  ].join(' \\; ')
  return `${tmuxBinToken} ${commands} 2>/dev/null`
}

/**
 * #85 — the hard ceiling on the launch line, and what CCC drops to stay under
 * it (adversarial review, 2026-09-20).
 *
 * The line is typed into the remote shell through a PTY. A tty in CANONICAL
 * mode has a 4096-byte line limit and TRUNCATES silently past it; an
 * interactive bash with readline reads it raw and survives, but `/bin/sh`
 * (dash) and a non-readline bash do not — and `sh` is a first-class choice for
 * a container runtime (`<engine> exec -it <name> sh`), where an Alpine image
 * has no bash at all. A truncation lands mid-line, plausibly inside the
 * single-quoted inner command, leaving the remote shell sitting at a `> `
 * continuation prompt forever. Neither tmux-launch-failure regex in
 * pty-manager matches a `> ` prompt, so nothing recovers it: the session
 * reports claude-running and claude never starts.
 *
 * Measured on this builder: pre-#85 the worst case (every flag the app
 * composes, plus `--extra-args` at its enforced 512-char maximum) was 2837
 * bytes — under the limit and therefore never a problem. #85's bindings ride
 * the line THREE times (once before the attach, once in each of the two fresh
 * creates), and that same worst case became 4473: past the ceiling, entirely
 * because of this feature. So the bindings — by far the most expendable thing
 * on the line — are what goes when the result would come close, and such a
 * session launches with pre-#85 wheel behaviour instead of not launching.
 *
 * 3800 keeps the wheel for every ordinary command (a full flag set with no
 * extra args measures ~3200) while leaving ~300 bytes under the 4096 ceiling.
 */
export const TMUX_LAUNCH_LINE_BUDGET = 3800

/**
 * Sanitize a CCC session id into a tmux-safe session name. Mirrors the
 * `safeSid` rule in ssh-shim.ts (generateRemoteSetupScript / getSshSettingsPath)
 * so the same sessionId maps to the same identifier everywhere it is
 * embedded on the remote host, and so a session id containing shell
 * metacharacters or spaces can't break out of the `-s <name>` argument.
 */
export function safeSid(sessionId: string): string {
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
 * `command tmux set-option -t =ccc-<sid> mouse off 2>/dev/null`):
 *   `if command tmux has-session -t =ccc-<sid> 2>/dev/null; then`
 *   ` <mo>; command tmux attach -t =ccc-<sid> || <fresh>;`
 *   ` else <fresh>; fi`   where <fresh> =
 *   ` command tmux new-session -s ccc-<sid> '<mo>; <innerCmd[ --continue]>'`
 * Every `-t` operand carries tmux's `=` EXACT-match prefix; the `-s` NAME does
 * not (see `name` / `target` below).
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
  /**
   * The session NAME — what `new-session -s` creates. A name is a literal, so
   * it never carries the `=` exact-match prefix: `-s =ccc-x` would create a
   * session literally called `=ccc-x`, which nothing would ever find again.
   */
  const name = `ccc-${sid}`
  /**
   * The EXACT-match TARGET — what every `-t` operand takes (adversarial review,
   * 2026-09-01 — MAJOR; the sibling of the same fix in
   * buildRemoteTmuxKillCommand, ssh-shim.ts).
   *
   * safeSid proves the id is metacharacter-free, not that it is NARROW, and a
   * bare `-t ccc-a` is resolved by tmux in three widening steps: exact name,
   * then PREFIX, then fnmatch. A short session id therefore ATTACHES to some
   * other `ccc-…` session on the host — the same widening class as a wrong
   * kill, and arguably worse, because the user then drives somebody else's live
   * agent believing it is theirs. tmux's `=` prefix takes only an exact match
   * and is standard target syntax on every tmux the fleet runs (3.x across the
   * fleet, plus the pinned static build tiers 3/4 stage).
   */
  const target = `=${name}`
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
  // Also force the tmux STATUS BAR off for CCC's own session (owner call
  // 2026-08-31: happy to lose the bar so the watchdog works). A visible status
  // bar REPAINTS on tmux's `status-interval` (default 15s), and every repaint is
  // PTY output that resets the watchdog's silence clock, so the sleep indicator
  // would never fire over a tmux-wrapped SSH session. Session-scoped
  // (`-t ${target}`, no `-g`) and error-swallowed, exactly like the mouse-off
  // beside it, and independent of the `attach` that follows (a `;`, not `&&`).
  // The session options CCC forces on its own tmux session, built once and
  // rendered two ways: `-t ${target}` for the attach branch (run from the outer
  // shell BEFORE attach, so it needs an explicit target — has-session proved the
  // `=`-exact target resolves), and TARGETLESS for the fresh pane (the option
  // runs INSIDE `new-session`, where the current session already IS ours, so no
  // `-t` can miss). Every operand is a literal or the safeSid target — #242 sink
  // posture unchanged; all error-swallowed and `;`-joined so the launch always
  // falls through to claude.
  //   mouse off      — #546, classic drag-select even under `set -g mouse on`.
  //   status off     — hide the status bar (owner call 2026-08-31).
  //   status-interval 0 — the DECISIVE one for the watchdog: even if the bar is
  //     visible (a remote `~/.tmux.conf` re-enabling `status on`, an old option
  //     name, a swallowed error), interval 0 stops the timed CLOCK REPAINT that
  //     is PTY output resetting the watchdog's silence clock every ~15s. The bar
  //     no longer flashes the session "working". Belt-and-braces to `status off`.
  //   mode-keys emacs — #85, pins WHICH copy-mode key table the wheel bindings
  //     below have to cover. A remote `~/.tmux.conf` with `set -g mode-keys vi`
  //     would route copy-mode keys to `copy-mode-vi` instead, and the wheel
  //     would stop scrolling on exactly those hosts. Window-scoped (`-w`), so
  //     the user's other sessions keep their own mode-keys.
  //
  // `w` is the WINDOW-target prefix, and it is NOT the session one with `-w`
  // bolted on: `set-option -w -t =ccc-<sid>` fails outright ("no such window",
  // observed 2026-09-20 — a session name is not a window target, and the error
  // is swallowed, so the option silently did not land on the attach branch).
  // The window form is the same `=`-exact session plus a trailing `:`, which
  // resolves to that session's CURRENT window while keeping the exact-match
  // guarantee #242 added to every other `-t` here.
  //   key-table root — #85, and the reason the wheel bindings are reachable at
  //     all. `key-table` is a SESSION option naming which table tmux consults
  //     for an un-prefixed key; a remote `~/.tmux.conf` that builds a modal
  //     setup with `set -g key-table <custom>` means the `root` table is never
  //     consulted, so every wheel key would be forwarded to the pane as raw
  //     escape bytes — the #85 bug restored, on exactly the hosts whose owner
  //     customised tmux most. Session-scoped, so their other sessions keep
  //     their custom table.
  const sessionOpts = (t: string, w: string, wheel: boolean): string =>
    `${tmuxBinToken} set-option ${t}mouse off 2>/dev/null; ` +
    `${tmuxBinToken} set-option ${t}status off 2>/dev/null; ` +
    `${tmuxBinToken} set-option ${t}status-interval 0 2>/dev/null` +
    (wheel
      ? `; ${tmuxBinToken} set-option ${t}key-table root 2>/dev/null; ` +
        `${tmuxBinToken} set-option -w ${w}mode-keys emacs 2>/dev/null; ` +
        buildTmuxWheelBindings(tmuxBinToken)
      : '')
  /**
   * #85 — leave copy-mode before attaching. copy-mode is PANE state, not client
   * state: it survives a dropped connection, an app restart and the detach, and
   * the renderer's own "are we scrolled back" belief starts false in a new
   * process. Reproduced on tmux 3.4 — scroll up, drop the link, reattach, and
   * every keystroke goes to the scrollback viewer with the status line off and
   * nothing on screen to say why. #85 is what makes this the NORMAL case: the
   * wheel now opens copy-mode, where it used to take a deliberate `C-b [`.
   * `-X cancel` on a pane that is not in a mode is an error, swallowed.
   */
  const leaveCopyMode = `${tmuxBinToken} send-keys -t ${target}: -X cancel 2>/dev/null`
  const buildAttachOpts = (wheel: boolean): string =>
    `${sessionOpts(`-t ${target} `, `-t ${target}: `, wheel)}${wheel ? `; ${leaveCopyMode}` : ''}`
  // Fresh-create branch only: resume the prior conversation on a reconnect
  // where the remote session was gone. Appended to innerCmd BEFORE quoting so
  // it rides inside tmux's single `<shell-cmd>` argument, next to `claude`.
  const claudeInner = input.reconnect ? `${input.innerCmd} --continue` : input.innerCmd
  // The mouse-off runs INSIDE the freshly-created pane (where the session is
  // live and addressable), then claude; both ride tmux's single quoted arg.
  const buildFresh = (wheel: boolean): string =>
    `${tmuxBinToken} new-session -s ${name} ${singleQuote(`${sessionOpts('', '', wheel)}; ${claudeInner}`)}`
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
  const assemble = (wheel: boolean): string => {
    const fresh = buildFresh(wheel)
    return (
      `if ${tmuxBinToken} has-session -t ${target} 2>/dev/null; ` +
      `then ${buildAttachOpts(wheel)}; ${tmuxBinToken} attach -t ${target} || ${fresh}; ` +
      `else ${fresh}; fi`
    )
  }
  // #85: the wheel is the most expendable thing on this line, so it is what
  // goes when the line would come close to the remote tty's canonical-mode
  // truncation (see TMUX_LAUNCH_LINE_BUDGET). Dropping it costs the user
  // pre-#85 wheel behaviour on a session with an unusually long claude
  // command; keeping it would cost them the session.
  const withWheel = assemble(true)
  return withWheel.length <= TMUX_LAUNCH_LINE_BUDGET ? withWheel : assemble(false)
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
