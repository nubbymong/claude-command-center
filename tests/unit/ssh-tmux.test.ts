// tests/unit/ssh-tmux.test.ts
//
// #242 + SSH tmux enhancement (item 6): tmux persistence wrapper. The
// wrapper is a has-session conditional (attach if the session is alive,
// else create a fresh one) so a reconnect after the remote rebooted can
// resume the conversation (`--continue` on the fresh branch) instead of
// launching a blank chat -- the silent-blank-chat bug the old `new-session
// -A` one-liner could not fix, because -A cannot tell attach from create.
//
// #242 round-3 correction (I3): buildTmuxLaunchCommand no longer takes a
// wire-reported `tmuxBin` at all -- it picks ONE of two fixed, host-authored
// literal tokens (ON_PATH_TMUX_BIN_EXPR / STAGED_TMUX_BIN_EXPR) purely off
// the `staged` boolean. `isPinnedTmuxPath`/`assertPinnedTmuxPath` (the
// validate-then-trust gate that used to sit in front of a tier-1/2 tmuxBin)
// are deleted along with their tests -- there is no longer a wire-reported
// path reaching this sink for either tier to validate.
import { describe, it, expect } from 'vitest'
import { buildTmuxLaunchCommand, buildSshClaudeFlags, shouldAddContinueFlag, buildTmuxWheelBindings, TMUX_LAUNCH_LINE_BUDGET, ON_PATH_TMUX_BIN_EXPR, STAGED_TMUX_BIN_EXPR } from '../../src/main/ssh-tmux'
import { TMUX_WHEEL_UP_KEYNAME, TMUX_WHEEL_DOWN_KEYNAME, TMUX_WHEEL_EXIT_KEYNAME, TMUX_WHEEL_LINES_PER_NOTCH, TMUX_WHEEL_NOOP_COMMAND } from '../../src/shared/tmux-wheel'

const base = {
  sessionId: 'sid-1',
  innerCmd: 'CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1 claude --settings ~/.claude/settings-sid-1.json',
  staged: false,
  reconnect: false,
}

// The three session options CCC forces on its own tmux session, rendered the two
// ways buildTmuxLaunchCommand's `sessionOpts` renders them (ssh-tmux.ts):
//   mouse off        — #546, classic drag-select even under `set -g mouse on`.
//   status off       — hide the status bar (owner call 2026-08-31).
//   status-interval 0 — the watchdog fix: stop the timed CLOCK REPAINT (PTY
//     output that reset the watchdog's silence clock every ~15s) even if a
//     remote ~/.tmux.conf re-enables `status on`. Belt-and-braces to `status off`.
// TARGETED (`-t =ccc-<sid> `) on the ATTACH branch (run from the outer shell
// before `attach`, where has-session just proved the =-exact target resolves);
// TARGETLESS inside the fresh `new-session` pane (the current session already IS
// ours there, so an exact `-t` could silently miss).
function optsTargeted(t: string, sid: string): string {
  return (
    `${t} set-option -t '=ccc-${sid}' mouse off 2>/dev/null; ` +
    `${t} set-option -t '=ccc-${sid}' status off 2>/dev/null; ` +
    `${t} set-option -t '=ccc-${sid}' status-interval 0 2>/dev/null; ` +
    `${t} set-option -t '=ccc-${sid}' key-table root 2>/dev/null; ` +
    `${t} set-option -w -t '=ccc-${sid}:' mode-keys emacs 2>/dev/null; ` +
    buildTmuxWheelBindings(t) + `; ` +
    `${t} send-keys -t '=ccc-${sid}:' -X cancel 2>/dev/null`
  )
}
function optsPane(t: string): string {
  return (
    `${t} set-option mouse off 2>/dev/null; ` +
    `${t} set-option status off 2>/dev/null; ` +
    `${t} set-option status-interval 0 2>/dev/null; ` +
    `${t} set-option key-table root 2>/dev/null; ` +
    `${t} set-option -w mode-keys emacs 2>/dev/null; ` +
    buildTmuxWheelBindings(t)
  )
}

describe('buildTmuxLaunchCommand', () => {
  it('builds the has-session wrapper (attach live, else fresh; attach falls through to fresh on a lost race) using ON_PATH_TMUX_BIN_EXPR for staged: false', () => {
    const cmd = buildTmuxLaunchCommand(base)
    const t = ON_PATH_TMUX_BIN_EXPR
    // #546 + watchdog: session-scoped options precede claude in the fresh pane
    // (TARGETLESS) and precede attach on reconnect (TARGETED) — see the
    // dedicated blocks below.
    const attachOpts = optsTargeted(t, 'sid-1')
    const paneOpts = optsPane(t)
    const fresh = `${t} new-session -s ccc-sid-1 '${paneOpts}; ${base.innerCmd}'`
    expect(cmd).toBe(
      `if ${t} has-session -t '=ccc-sid-1' 2>/dev/null; then ${attachOpts}; ${t} attach -t '=ccc-sid-1' || ${fresh}; else ${fresh}; fi`,
    )
  })

  it('uses STAGED_TMUX_BIN_EXPR for staged: true', () => {
    const cmd = buildTmuxLaunchCommand({ ...base, staged: true })
    const t = STAGED_TMUX_BIN_EXPR
    const attachOpts = optsTargeted(t, 'sid-1')
    const paneOpts = optsPane(t)
    const fresh = `${t} new-session -s ccc-sid-1 '${paneOpts}; ${base.innerCmd}'`
    expect(cmd).toBe(
      `if ${t} has-session -t '=ccc-sid-1' 2>/dev/null; then ${attachOpts}; ${t} attach -t '=ccc-sid-1' || ${fresh}; else ${fresh}; fi`,
    )
  })

  it('attaches an existing session and only creates fresh when it is gone', () => {
    const cmd = buildTmuxLaunchCommand(base)
    // Attach branch first (reattach a still-running claude), create second.
    expect(cmd).toMatch(/has-session\s+-t\s+'=ccc-sid-1'/)
    expect(cmd).toMatch(/then\s+.*attach\s+-t\s+'=ccc-sid-1'/)
    expect(cmd).toMatch(/else\s+.*new-session\s+-s\s+ccc-sid-1/)
  })

  // The attach is NOT atomic with has-session; a lost race (session dies in the
  // ~10ms gap) must self-heal, not strand the user (adversarial review,
  // 2026-08-18). Mutation to prove this can fail: drop the `|| <fresh>` from the
  // attach branch.
  it('falls the attach THROUGH to a fresh create when the reattach fails', () => {
    const cmd = buildTmuxLaunchCommand(base)
    // The live-reattach `attach -t X` is immediately backstopped by `|| <fresh>`.
    expect(cmd).toContain("attach -t '=ccc-sid-1' || ")
    // Two identical create paths: the attach fallback and the else branch.
    const creates = cmd.split('new-session -s ccc-sid-1 ').length - 1
    expect(creates).toBe(2)
  })

  // Item 6 (silent-blank-chat fix): --continue rides every FRESH-create (the
  // attach fallback AND the else), and only on a reconnect; a LIVE reattach
  // (`attach -t X` before the `||`) never gets it -- relaunching a running
  // claude would be wrong. Mutation to prove this can fail: append --continue to
  // innerCmd unconditionally, or to the attach op -- the assertions below fail.
  it('adds --continue to every fresh-create branch, never to a live attach, on a reconnect', () => {
    const cmd = buildTmuxLaunchCommand({ ...base, reconnect: true })
    expect(cmd).toContain("attach -t '=ccc-sid-1' || ")
    expect(cmd).not.toMatch(/attach -t '=ccc-sid-1' --continue/)
    const creates = cmd.split('new-session -s ccc-sid-1 ').slice(1)
    expect(creates.length).toBe(2)
    // #546 + watchdog: the fresh pane runs `<session-opts>; <claude> --continue`,
    // so --continue still rides the fresh branch (never the live attach) — now
    // after the TARGETLESS session-options prefix, inside the ONE quoted arg
    // that both create sites expand (#85).
    const paneOpts = optsPane(ON_PATH_TMUX_BIN_EXPR)
    for (const c of creates) expect(c.startsWith(`'${paneOpts}; ${base.innerCmd} --continue'`)).toBe(true)
  })

  it('never adds --continue on a first connect (reconnect: false)', () => {
    const cmd = buildTmuxLaunchCommand({ ...base, reconnect: false })
    expect(cmd).not.toContain('--continue')
  })

  // ── EXACTNESS: every `-t` operand, never the `-s` NAME ────────────────────
  //
  // safeSid proves the id is metacharacter-free. It does NOT prove it is narrow,
  // and tmux resolves a bare `-t ccc-a` by exact match, then PREFIX, then
  // fnmatch — so a one-character session id (schema-valid: the IPC id floor is
  // 1) ATTACHES to whichever other `ccc-…` session on the host starts with `a`,
  // handing the user somebody else's live agent. `=` is tmux's exact-match
  // prefix; it belongs on a TARGET and never on `new-session -s`, where it would
  // become part of the session's own name.
  //
  // Mutation to prove these can fail: set `const target = name` in
  // buildTmuxLaunchCommand (ssh-tmux.ts), or put the `=` on the `-s` operand.
  it('every -t operand carries tmux`s = EXACT-match prefix, for a one-character id too', () => {
    const cmd = buildTmuxLaunchCommand({ ...base, sessionId: 'a' })
    const targets = [...cmd.matchAll(/-t (\S+)/g)].map((m) => m[1])
    expect(targets.length).toBeGreaterThan(0)
    // Two shapes, both `=`-exact: the SESSION target every verb here has always
    // used, and (#85) the WINDOW target `mode-keys` needs — the same session,
    // `:`-suffixed to name its current window. `set-option -w -t =ccc-a` is not
    // a window target and fails with "no such window".
    for (const t of targets) expect(["'=ccc-a'", "'=ccc-a:'"]).toContain(t)
    // The pre-fix, prefix-matching form is gone from every target verb.
    expect(cmd).not.toMatch(/(has-session|attach|set-option) -t ccc-a\b/)
  })

  it('the -s NAME stays bare — `=` is target syntax and would become part of the name', () => {
    const cmd = buildTmuxLaunchCommand({ ...base, sessionId: 'a' })
    const names = [...cmd.matchAll(/new-session -s (\S+)/g)].map((m) => m[1])
    expect(names.length).toBe(2)
    for (const n of names) expect(n).toBe('ccc-a')
    expect(cmd).not.toContain('new-session -s =')
    // ...and the name the fresh branch creates is exactly what the target
    // resolves to, minus the prefix — a mismatch would mean a session that is
    // created and then never found again.
    expect(cmd).toContain("has-session -t '=ccc-a' ")
  })

  it('sanitizes a session id containing spaces/quotes into the tmux session name', () => {
    const cmd = buildTmuxLaunchCommand({ ...base, sessionId: `sid with 'quote' and space` })
    // Same [^a-zA-Z0-9_-] -> '_' rule as safeSid in ssh-shim.ts.
    expect(cmd).toContain('-s ccc-sid_with__quote__and_space ')
    // No raw space or quote reached the -s argument itself.
    const sName = cmd.split('-s ')[1].split(' ')[0]
    expect(sName).toBe('ccc-sid_with__quote__and_space')
    expect(sName).not.toMatch(/['"\s]/)
  })

  it('keeps the env prefix INSIDE the single-quoted tmux command argument', () => {
    // The env vars must reach claude via tmux's own `sh -c`, not as bare
    // tokens preceding the tmux binary token (tmux's launch environment is
    // NOT sourced from this command line).
    const cmd = buildTmuxLaunchCommand(base)
    // #546 + watchdog: the quoted pane command is `<session-opts (targetless)>; <innerCmd>`.
    const paneOpts = optsPane(ON_PATH_TMUX_BIN_EXPR)
    const quotedArg = `'${paneOpts}; ${base.innerCmd}'`
    const idx = cmd.indexOf(quotedArg)
    expect(idx).toBeGreaterThan(-1)
    // The CLAUDE env var only appears INSIDE the quoted argument (after the
    // opening quote + the session-options prefix), never as a bare leading token
    // before the tmux binary token.
    expect(cmd.indexOf('CLAUDE_CODE_DISABLE_MOUSE_CLICKS')).toBe(idx + 1 + `${paneOpts}; `.length)
    expect(cmd.startsWith(`if ${ON_PATH_TMUX_BIN_EXPR} has-session`)).toBe(true)
  })

  it('single-quotes an innerCmd containing a single quote without breaking out of the argument', () => {
    const innerCmd = `echo 'hi' && say "done"`
    const cmd = buildTmuxLaunchCommand({ ...base, innerCmd })
    // The else-branch fresh-create quoted argument (after the LAST
    // '-s ccc-sid-1 ' -- the attach fallback also creates fresh, so use
    // lastIndexOf to land uniquely on the else branch's operand, terminated
    // only by '; fi').
    const marker = 'new-session -s ccc-sid-1 '
    const quotedArg = cmd.slice(cmd.lastIndexOf(marker) + marker.length).replace(/; fi$/, '')
    expect(quotedArg.startsWith("'")).toBe(true)
    expect(quotedArg.endsWith("'")).toBe(true)
    // Reverse the POSIX single-quote escaping (strip outer quotes, undo
    // every '\'' -> literal ') to prove the remote shell parses this back
    // into the ORIGINAL string, rather than hand-writing the expected
    // escaped form (fragile and easy to get wrong by hand).
    const unescaped = quotedArg.slice(1, -1).split(`'\\''`).join(`'`)
    // #546 + watchdog: the pane runs `<session-opts (targetless)>; <innerCmd>`;
    // the innerCmd's own quotes still round-trip through the POSIX single-quote
    // escaping intact.
    const paneOpts = optsPane(ON_PATH_TMUX_BIN_EXPR)
    expect(unescaped).toBe(`${paneOpts}; ${innerCmd}`)
  })
})

// #546: force tmux's own mouse mode OFF for CCC's session so classic
// drag-selection survives a remote `set -g mouse on` (tmux would otherwise grab
// the drag before xterm ever sees it, defeating CLAUDE_CODE_DISABLE_MOUSE). It
// must be SESSION-scoped (`-t ccc-<sid>`, never `-g`) so it overrides the user's
// global for OUR session only, present on BOTH the fresh-create pane and the
// reattach branch, and use only the fixed launch token + safeSid target (no
// wire operand — the #242 sink posture is unchanged).
describe('buildTmuxLaunchCommand forces session-scoped mouse off (#546)', () => {
  it('runs set-option mouse off in the fresh pane AND before attach, session-scoped, not global', () => {
    const cmd = buildTmuxLaunchCommand(base)
    const t = ON_PATH_TMUX_BIN_EXPR
    // Attach branch: session options from the outer shell before reattaching (TARGETED).
    expect(cmd).toContain(`then ${optsTargeted(t, 'sid-1')}; ${t} attach`)
    // Fresh pane: the options are the first thing the pane command runs (TARGETLESS), before claude.
    expect(cmd).toContain(`new-session -s ccc-sid-1 '${optsPane(t)}; `)
    // Never global — that would clobber the user's own tmux sessions.
    expect(cmd).not.toContain('set-option -g mouse')
    expect(cmd).not.toContain('-g mouse off')
    expect(cmd).not.toContain('set-option -g status')
  })

  // Owner (2026-08-31): the tmux STATUS BAR is forced off for CCC's session so
  // its status-interval repaints don't reset the watchdog's silence clock.
  it('also forces the tmux status bar off, session-scoped, on both branches', () => {
    const cmd = buildTmuxLaunchCommand(base)
    const t = ON_PATH_TMUX_BIN_EXPR
    expect(cmd).toContain(`${t} set-option -t '=ccc-sid-1' status off 2>/dev/null`)
    // Attach branch + the fresh pane (which appears twice — attach fallback and
    // else), so three occurrences, matching the mouse-off it rides beside.
    expect(cmd.split('status off 2>/dev/null').length - 1).toBe(3)
    expect(cmd.split('mouse off 2>/dev/null').length - 1).toBe(3)
    expect(cmd).not.toContain('set-option -g status')
  })

  it('uses the staged token for the session options on a staged tier', () => {
    const cmd = buildTmuxLaunchCommand({ ...base, staged: true })
    const t = STAGED_TMUX_BIN_EXPR
    expect(cmd).toContain(`then ${optsTargeted(t, 'sid-1')}; ${t} attach`)
    expect(cmd).toContain(`new-session -s ccc-sid-1 '${optsPane(t)}; `)
  })
})

// Watchdog regression (owner call 2026-08-31, THIS change): the tmux status
// bar's ~15s timed clock REPAINT is PTY output that reset the watchdog's silence
// clock, so a tmux-wrapped SSH session never went to sleep. `status off` alone
// is not enough — a remote ~/.tmux.conf can turn the bar back on — so CCC also
// sets `status-interval 0`, which stops the timed repaint even when the bar is
// visible. And the fresh pane's options dropped their `-t` target: inside
// new-session the current session already IS ours, so an exact `-t =ccc-<sid>`
// (the =-exact form the 2026-09-01 security fix introduced) could silently miss;
// the attach branch keeps `-t =ccc-<sid>` (run from the outer shell, where
// has-session just proved the =-exact target resolves).
describe('buildTmuxLaunchCommand freezes the tmux status clock for the watchdog', () => {
  // (a) status-interval 0 rides BOTH the attach branch (targeted) and the fresh
  // pane (targetless). Mutation to prove this can fail: drop the
  // `status-interval 0` set-option from sessionOpts in ssh-tmux.ts — every
  // assertion below then fails.
  it('sets status-interval 0 on the attach branch (targeted) AND the fresh pane (targetless)', () => {
    const cmd = buildTmuxLaunchCommand(base)
    const t = ON_PATH_TMUX_BIN_EXPR
    // Attach branch: targeted at the =-exact session.
    expect(cmd).toContain(`${t} set-option -t '=ccc-sid-1' status-interval 0 2>/dev/null`)
    // Fresh pane: targetless (the current session already is ours).
    expect(cmd).toContain(`${t} set-option status-interval 0 2>/dev/null`)
    // Three occurrences total — attach branch once, the fresh pane twice (attach
    // fallback + else), matching the mouse-off/status-off it rides beside.
    expect(cmd.split('status-interval 0 2>/dev/null').length - 1).toBe(3)
  })

  // (b) The fresh new-session pane's set-options are TARGETLESS. Mutation to
  // prove this can fail: pass a `-t =ccc-<sid> ` target into the fresh-pane
  // sessionOpts call (mouseOffInPane) in ssh-tmux.ts — the quoted pane command
  // would then carry `set-option -t =ccc-sid-1 …`, and the no-`-t` check fails.
  it('runs the fresh pane`s set-options TARGETLESS (no -t between set-option and the option)', () => {
    const cmd = buildTmuxLaunchCommand(base)
    const t = ON_PATH_TMUX_BIN_EXPR
    const marker = `new-session -s ccc-sid-1 '`
    // The quoted pane command of the else branch (terminated by `'; fi`).
    const pane = cmd.slice(cmd.lastIndexOf(marker) + marker.length).replace(/'; fi$/, '')
    expect(pane.startsWith(`${t} set-option mouse off 2>/dev/null`)).toBe(true)
    expect(pane).toContain(`${t} set-option status off 2>/dev/null`)
    expect(pane).toContain(`${t} set-option status-interval 0 2>/dev/null`)
    // No `-t` targets the fresh pane's set-options.
    expect(pane).not.toMatch(/set-option -t /)
  })

  // (c) The attach-branch set-options carry `-t =ccc-<sid>` (run from the OUTER
  // shell before attach, so they need an explicit target; has-session proved it
  // resolves). Mutation to prove this can fail: drop the target from the
  // attach-branch sessionOpts call (mouseOff) in ssh-tmux.ts.
  it('runs the attach branch`s set-options TARGETED at =ccc-<sid>', () => {
    const cmd = buildTmuxLaunchCommand(base)
    const t = ON_PATH_TMUX_BIN_EXPR
    // Everything between `then ` and the live `attach` is the attach-branch opts.
    const attachSeg = cmd.slice(cmd.indexOf('then ') + 'then '.length, cmd.indexOf(`${t} attach`))
    expect(attachSeg).toContain(`${t} set-option -t '=ccc-sid-1' mouse off 2>/dev/null`)
    expect(attachSeg).toContain(`${t} set-option -t '=ccc-sid-1' status off 2>/dev/null`)
    expect(attachSeg).toContain(`${t} set-option -t '=ccc-sid-1' status-interval 0 2>/dev/null`)
    // No targetless set-option leaks onto the attach branch.
    expect(attachSeg).not.toMatch(/set-option (mouse|status)/)
  })
})

// #242 round-3 correction (I3), BLOCKER. Round-2's fix already established
// that a staged (tier-3/4) path is never read off the wire for this sink;
// this generalizes the SAME principle to tier 1/2 -- `isPinnedTmuxPath`'s
// own doc comment admitted it could not defeat an attacker-controlled
// absolute path with no traversal (a real PATH tmux can legitimately live
// almost anywhere), so validating THEN trusting a wire-reported path was
// never a durable fix for tier 1/2 either. Mutation to prove this can fail:
// change buildTmuxLaunchCommand to accept and embed a caller-supplied
// tmuxBin again for `staged: false` -- both assertions below then fail,
// because the command would no longer be independent of any operand the
// caller passes.
describe('buildTmuxLaunchCommand never reads a caller-supplied tmux path (#242 finding I3, BLOCKER)', () => {
  it('ignores anything extra on the input object -- staged: false always emits ON_PATH_TMUX_BIN_EXPR', () => {
    const cmd = buildTmuxLaunchCommand({ ...base, staged: false, tmuxBin: '/tmp/.x/tmux' } as never)
    expect(cmd).not.toContain('/tmp/.x/tmux')
    expect(cmd.startsWith(`if ${ON_PATH_TMUX_BIN_EXPR} has-session`)).toBe(true)
  })

  it('ignores anything extra on the input object -- staged: true always emits STAGED_TMUX_BIN_EXPR', () => {
    const cmd = buildTmuxLaunchCommand({ ...base, staged: true, tmuxBin: '/tmp/.claude/bin/tmux' } as never)
    expect(cmd).not.toContain('/tmp/.claude/bin/tmux')
    expect(cmd.startsWith(`if ${STAGED_TMUX_BIN_EXPR} has-session`)).toBe(true)
  })
})

// Follow-up adversarial pass (fail-posture MAJOR): the tier-1 launch token
// must be the alias- AND function-proof form `command tmux`, never the old
// `"$(command -v tmux)"`. The detection probe runs `command -v tmux` through
// execSync (non-interactive `sh -c`, alias-blind), but the launch token is
// expanded by the remote's INTERACTIVE login shell -- where `command -v tmux`
// prints an alias DEFINITION (`alias tmux='tmux -2'`) for anyone who aliases
// tmux in their rc file, quoted into one word that exits 127: no claude, on
// every connect. `command` is a POSIX special builtin that bypasses shell
// functions, and `tmux` sits in argument position where alias expansion never
// applies.
//
// WHY THE LITERAL TEXT IS ASSERTED, NOT THE IMPORTED CONSTANT: every other
// test in this file compares buildTmuxLaunchCommand's output against
// ON_PATH_TMUX_BIN_EXPR / STAGED_TMUX_BIN_EXPR themselves, so a regression
// INSIDE the constant (e.g. back to `"$(command -v tmux)"`) changes both
// sides of the comparison at once and every such test stays green -- proven:
// NO existing test failed when the constant's value changed for this very
// fix. A self-referential expectation cannot catch a change to the value it
// re-derives; only the literal can.
describe('launch-token literals are alias/function-proof (fail-posture follow-up)', () => {
  it('ON_PATH_TMUX_BIN_EXPR is literally `command tmux` (not a $(command -v) substitution)', () => {
    expect(ON_PATH_TMUX_BIN_EXPR).toBe('command tmux')
  })

  it('STAGED_TMUX_BIN_EXPR is literally `"$HOME"/.claude/bin/tmux`', () => {
    expect(STAGED_TMUX_BIN_EXPR).toBe('"$HOME"/.claude/bin/tmux')
  })

  it('a tier-1 (staged: false) launch command uses exactly `command tmux` as every tmux token and contains no `$(command -v` anywhere', () => {
    const cmd = buildTmuxLaunchCommand({ ...base, staged: false })
    // All three invocation sites carry the literal token (has-session guard,
    // live attach, and the fresh create used by both the attach fallback and
    // the else branch).
    expect(cmd.startsWith("if command tmux has-session -t '=ccc-sid-1' ")).toBe(true)
    // #546 + watchdog: the three session options (same literal token, TARGETED)
    // precede attach on this branch.
    // (#85 appends mode-keys + the wheel bindings to the same run of options,
    // asserted in their own block below; this one still owns the literal token.)
    expect(cmd).toContain(`then ${optsTargeted('command tmux', 'sid-1')}; command tmux attach -t '=ccc-sid-1' || command tmux new-session -s ccc-sid-1 `)
    expect(cmd).toContain('else command tmux new-session -s ccc-sid-1 ')
    // The alias-expandable substitution form must never come back, anywhere
    // in the command.
    expect(cmd).not.toContain('$(command -v')
    expect(cmd).not.toContain('command -v tmux')
  })

  it('the staged (tier-2/3/4) launch command carries the literal `"$HOME"/.claude/bin/tmux` token and no `$(command -v` either', () => {
    const cmd = buildTmuxLaunchCommand({ ...base, staged: true })
    expect(cmd.startsWith(`if "$HOME"/.claude/bin/tmux has-session -t '=ccc-sid-1' `)).toBe(true)
    expect(cmd).not.toContain('$(command -v')
  })
})

// #242 tier 5: `--continue` on the BARE (non-tmux) launch on a reconnect,
// gated OFF whenever tmux is in play -- there the has-session wrapper owns
// the --continue decision itself (fresh branch only), so this flag going ON
// too would double it. Both directions are separate mutations a
// single test cannot catch: dropping the `!tmuxInPlay` gate only shows up
// with tmux present, and dropping the `reconnect` gate only shows up with
// tmux absent -- hence two dedicated tests rather than one table-driven one.
describe('buildSshClaudeFlags / shouldAddContinueFlag (#242 tier 5)', () => {
  it('adds --continue on a reconnect with no tmux in play', () => {
    expect(shouldAddContinueFlag({ reconnect: true, tmuxInPlay: false })).toBe(true)
    expect(buildSshClaudeFlags({ reconnect: true, tmuxInPlay: false })).toBe('--continue')
  })

  // Mutation this catches: dropping `!input.tmuxInPlay` from the gate (e.g.
  // `return input.reconnect`) would make this fail -- the tmux wrapper's
  // fresh-create branch already carries --continue on a reconnect, so this
  // bare-launch flag going ON too would append a second one.
  it('does NOT add --continue on a reconnect when tmux IS in play', () => {
    expect(shouldAddContinueFlag({ reconnect: true, tmuxInPlay: true })).toBe(false)
    expect(buildSshClaudeFlags({ reconnect: true, tmuxInPlay: true })).toBe('')
  })

  // Mutation this catches: dropping `input.reconnect` from the gate (e.g.
  // `return !input.tmuxInPlay`) would make this fail -- a session's FIRST
  // connect has no prior conversation to continue.
  it('does NOT add --continue on a first connect (reconnect: false), tmux or not', () => {
    expect(shouldAddContinueFlag({ reconnect: false, tmuxInPlay: false })).toBe(false)
    expect(shouldAddContinueFlag({ reconnect: false, tmuxInPlay: true })).toBe(false)
    expect(buildSshClaudeFlags({ reconnect: false, tmuxInPlay: false })).toBe('')
  })
})

// #85 — the wheel bindings that give an SSH/tmux session real scrollback.
//
// The behaviour these assert is NOT provable in a unit test: whether tmux
// parses `ESC [ 24 ; 7 ~` as C-M-F12, whether `send -X -N 3 scroll-up` moves
// three lines, whether a `;` reaching tmux unescaped splits the bind. All three
// were verified end-to-end against tmux 3.4 on 2026-09-20 by driving this exact
// generated command through a real pty client (copy-mode entered, scroll_position
// 3 -> 9 -> 6, keystrokes leaving copy-mode with no escape bytes reaching the
// pane). What these tests pin is the SHAPE that verification was done against,
// so it cannot drift silently.
describe('buildTmuxWheelBindings (#85)', () => {
  it('binds all ten commands in ONE tmux invocation, separated by escaped semicolons', () => {
    const cmd = buildTmuxWheelBindings(ON_PATH_TMUX_BIN_EXPR)
    // One invocation: the token appears exactly once, at the front.
    expect(cmd.startsWith(`${ON_PATH_TMUX_BIN_EXPR} bind `)).toBe(true)
    expect(cmd.split(ON_PATH_TMUX_BIN_EXPR)).toHaveLength(2)
    expect(cmd.split(' \\; ')).toHaveLength(10)
    // A BARE `;` would end the bind-key command and run the rest immediately
    // (observed: `not in a mode`), so every separator must carry its backslash.
    expect(/[^\\]; /.test(cmd.replace(' 2>/dev/null', ''))).toBe(false)
  })

  it('enters copy-mode from the root table and scrolls from BOTH copy-mode tables', () => {
    const cmd = buildTmuxWheelBindings(ON_PATH_TMUX_BIN_EXPR)
    expect(cmd).toContain(`bind -T root ${TMUX_WHEEL_UP_KEYNAME} copy-mode -e`)
    // copy-mode-vi is covered too: `mode-keys emacs` is set with an
    // error-swallowed `set-option -w`, and it silently did NOT land on the
    // attach branch until the window target was corrected (2026-09-20). A miss
    // there routes copy-mode keys to the vi table, where an uncovered leave key
    // strands the user with their typing disappearing.
    for (const table of ['copy-mode', 'copy-mode-vi']) {
      expect(cmd).toContain(`bind -T ${table} ${TMUX_WHEEL_UP_KEYNAME} send -X -N ${TMUX_WHEEL_LINES_PER_NOTCH} scroll-up`)
      expect(cmd).toContain(`bind -T ${table} ${TMUX_WHEEL_DOWN_KEYNAME} send -X -N ${TMUX_WHEEL_LINES_PER_NOTCH} scroll-down`)
      expect(cmd).toContain(`bind -T ${table} ${TMUX_WHEEL_EXIT_KEYNAME} send -X cancel`)
    }
  })

  it('is safe at EVERY prefix: nothing can leak, and no entry key outlives its exit key', () => {
    // tmux runs a `\;` list until the first failure and KEEPS what already ran
    // -- an old tmux rejecting one command leaves a PARTIAL binding set, and
    // `2>/dev/null` hides which. Two partial states were reproduced on 3.4:
    // nothing bound (tmux forwards the keys to the pane, i.e. raw escape bytes
    // typed at claude) and root-bound-but-copy-mode-not (the user enters the
    // scrollback view with no way out, status line off, typing vanishing).
    // Ordering is the whole defense, so it is asserted directly.
    const commands = buildTmuxWheelBindings(ON_PATH_TMUX_BIN_EXPR)
      .replace(`${ON_PATH_TMUX_BIN_EXPR} `, '')
      .replace(' 2>/dev/null', '')
      .split(' \\; ')
    const at = (needle: string): number => commands.findIndex((c) => c.includes(needle))
    // Every key is silenced in the root table before anything else happens.
    for (const key of [TMUX_WHEEL_EXIT_KEYNAME, TMUX_WHEEL_DOWN_KEYNAME, TMUX_WHEEL_UP_KEYNAME]) {
      expect(at(`bind -T root ${key} ${TMUX_WHEEL_NOOP_COMMAND}`)).toBeLessThan(3)
    }
    // Each copy-mode table can be left before it can be scrolled.
    for (const table of ['copy-mode', 'copy-mode-vi']) {
      expect(at(`bind -T ${table} ${TMUX_WHEEL_EXIT_KEYNAME}`)).toBeLessThan(at(`bind -T ${table} ${TMUX_WHEEL_UP_KEYNAME}`))
    }
    // And the one command that can OPEN copy-mode runs dead last.
    expect(at(`bind -T root ${TMUX_WHEEL_UP_KEYNAME} copy-mode -e`)).toBe(commands.length - 1)
  })

  it('binds the down/leave keys to a silent no-op in the root table', () => {
    // An UNBOUND key is forwarded to the pane -- i.e. raw escape bytes typed at
    // claude, which is the #85 bug in a different costume. The renderer only
    // sends these two out of copy-mode when its belief went stale (tmux's `-e`
    // auto-exit at the bottom, which the renderer cannot observe).
    const cmd = buildTmuxWheelBindings(ON_PATH_TMUX_BIN_EXPR)
    expect(cmd).toContain(`bind -T root ${TMUX_WHEEL_DOWN_KEYNAME} ${TMUX_WHEEL_NOOP_COMMAND}`)
    expect(cmd).toContain(`bind -T root ${TMUX_WHEEL_EXIT_KEYNAME} ${TMUX_WHEEL_NOOP_COMMAND}`)
  })

  it('swallows errors so an old tmux that rejects a binding still launches claude', () => {
    expect(buildTmuxWheelBindings(ON_PATH_TMUX_BIN_EXPR).endsWith(' 2>/dev/null')).toBe(true)
  })

  it('carries no wire-reported operand: every token is compile-time literal (#242 sink posture)', () => {
    const staged = buildTmuxWheelBindings(STAGED_TMUX_BIN_EXPR)
    expect(staged.startsWith(`${STAGED_TMUX_BIN_EXPR} `)).toBe(true)
    // Nothing session-derived: no session id, no target, no `-t`.
    expect(staged).not.toContain('-t ')
    expect(staged).not.toContain('ccc-sid')
  })

  it('rides BOTH launch branches, because bindings made with no session do not survive', () => {
    // A tmux server with no sessions exits with its last client, taking any
    // hoisted binding with it (verified 2026-09-20). So the bindings have to
    // run where a session exists: before the attach, and inside the fresh pane.
    const cmd = buildTmuxLaunchCommand(base)
    const bindings = buildTmuxWheelBindings(ON_PATH_TMUX_BIN_EXPR)
    // Attach branch (once) + fresh pane (twice: the attach fall-through and the else).
    expect(cmd.split(bindings)).toHaveLength(4)
    // ...and always AFTER `mouse off`, which is what keeps #546's drag-select.
    expect(cmd.indexOf('mouse off')).toBeLessThan(cmd.indexOf(bindings))
  })

  it('forces mode-keys emacs so the copy-mode bindings are the table actually consulted', () => {
    // A remote ~/.tmux.conf with `set -g mode-keys vi` would route copy-mode
    // keys to `copy-mode-vi` instead and the wheel would stop scrolling there.
    const cmd = buildTmuxLaunchCommand(base)
    expect(cmd).toContain(`${ON_PATH_TMUX_BIN_EXPR} set-option -w -t '=ccc-sid-1:' mode-keys emacs 2>/dev/null`)
    expect(cmd).toContain(`${ON_PATH_TMUX_BIN_EXPR} set-option -w mode-keys emacs 2>/dev/null`)
  })
})

// #85 — the launch line is typed into the remote shell through a PTY, and a tty
// in CANONICAL mode truncates past 4096 bytes silently. An interactive bash
// with readline survives; `/bin/sh` (dash) and a non-readline bash do not, and
// `sh` is a first-class container-runtime choice (an Alpine image has no bash
// at all). A truncation lands mid-line, plausibly inside the single-quoted
// inner command, leaving the remote shell at a `> ` continuation prompt
// forever — and neither tmux-launch-failure regex in pty-manager matches a `> `
// prompt, so nothing recovers it. Measured pre-#85 worst case: 2837 bytes.
// Measured with the bindings on all three copies: 4473.
describe('buildTmuxLaunchCommand stays under the remote tty line limit (#85)', () => {
  const longInner =
    'CLAUDE_CODE_DISABLE_MOUSE=1 CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1 ' +
    'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 claude --settings "$HOME"/.claude/settings-1a2b3c4d5e6f7890.json ' +
    '--mcp-config "$HOME"/.claude/mcp-1a2b3c4d5e6f7890.json --model opus --permission-mode acceptEdits'

  it('keeps the wheel bindings for an ordinary launch', () => {
    const cmd = buildTmuxLaunchCommand({ sessionId: '1a2b3c4d5e6f7890', innerCmd: longInner, staged: false, reconnect: true })
    expect(cmd).toContain(TMUX_WHEEL_UP_KEYNAME)
    expect(cmd.length).toBeLessThanOrEqual(TMUX_LAUNCH_LINE_BUDGET)
  })

  it('drops the wheel bindings rather than the session when the line would run long', () => {
    // --extra-args at its enforced 512-char maximum is the reachable worst case.
    const cmd = buildTmuxLaunchCommand({
      sessionId: '1a2b3c4d5e6f7890',
      innerCmd: `${longInner} ${'x'.repeat(512)}`,
      staged: true,
      reconnect: true,
    })
    expect(cmd).not.toContain(TMUX_WHEEL_UP_KEYNAME)
    expect(cmd.length).toBeLessThanOrEqual(TMUX_LAUNCH_LINE_BUDGET)
    // Degraded, not broken: everything #546 and the watchdog rely on is still
    // there, and claude still launches on both branches.
    expect(cmd).toContain('mouse off')
    expect(cmd).toContain('status-interval 0')
    expect(cmd.split('new-session -s ccc-1a2b3c4d5e6f7890 ').length - 1).toBe(2)
  })

  it('leaves a real margin under the 4096-byte canonical-mode ceiling', () => {
    expect(TMUX_LAUNCH_LINE_BUDGET).toBeLessThan(4096)
    expect(4096 - TMUX_LAUNCH_LINE_BUDGET).toBeGreaterThanOrEqual(256)
  })
})

// #85 — a remote `~/.tmux.conf` that builds a modal setup with
// `set -g key-table <custom>` means tmux never consults the `root` table, so
// every wheel key would be forwarded to the pane as raw escape bytes: the #85
// bug restored, on exactly the hosts whose owner customised tmux most
// (reproduced on tmux 3.4, adversarial review 2026-09-20).
describe('buildTmuxLaunchCommand pins the key table the bindings live in (#85)', () => {
  it('forces key-table root on CCC’s own session, both branches', () => {
    const cmd = buildTmuxLaunchCommand(base)
    const t = ON_PATH_TMUX_BIN_EXPR
    expect(cmd).toContain(`${t} set-option -t '=ccc-sid-1' key-table root 2>/dev/null`)
    expect(cmd).toContain(`${t} set-option key-table root 2>/dev/null`)
    // Session-scoped (no `-g`): the user's other sessions keep their own table.
    expect(cmd).not.toContain('set-option -g key-table')
  })
})

// #85 — copy-mode is PANE state, not client state: it survives a dropped
// connection, an app restart and the detach, while the renderer's belief starts
// false in a new process. Reproduced on tmux 3.4 — scroll up, drop the link,
// reattach, and every keystroke goes to the scrollback viewer with the status
// line off and nothing on screen to say why.
describe('buildTmuxLaunchCommand leaves copy-mode before reattaching (#85)', () => {
  it('cancels any copy-mode on the attach branch, before the attach', () => {
    const cmd = buildTmuxLaunchCommand(base)
    const t = ON_PATH_TMUX_BIN_EXPR
    const cancel = `${t} send-keys -t '=ccc-sid-1:' -X cancel 2>/dev/null`
    expect(cmd).toContain(cancel)
    expect(cmd.indexOf(cancel)).toBeLessThan(cmd.indexOf(`${t} attach -t '=ccc-sid-1'`))
  })

  it('does not run it on the fresh branch, where the pane is new', () => {
    const cmd = buildTmuxLaunchCommand(base)
    expect(cmd.split('-X cancel 2>/dev/null').length - 1).toBe(1)
  })
})
