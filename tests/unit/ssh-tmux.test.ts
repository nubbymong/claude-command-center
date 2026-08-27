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
import { buildTmuxLaunchCommand, buildSshClaudeFlags, shouldAddContinueFlag, ON_PATH_TMUX_BIN_EXPR, STAGED_TMUX_BIN_EXPR } from '../../src/main/ssh-tmux'

const base = {
  sessionId: 'sid-1',
  innerCmd: 'CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1 claude --settings ~/.claude/settings-sid-1.json',
  staged: false,
  reconnect: false,
}

describe('buildTmuxLaunchCommand', () => {
  it('builds the has-session wrapper (attach live, else fresh; attach falls through to fresh on a lost race) using ON_PATH_TMUX_BIN_EXPR for staged: false', () => {
    const cmd = buildTmuxLaunchCommand(base)
    const t = ON_PATH_TMUX_BIN_EXPR
    // #546: session-scoped mouse-off precedes claude in the fresh pane and
    // precedes attach on reconnect (see the dedicated mouse-off block below).
    const mo = `${t} set-option -t ccc-sid-1 mouse off 2>/dev/null`
    const fresh = `${t} new-session -s ccc-sid-1 '${mo}; ${base.innerCmd}'`
    expect(cmd).toBe(
      `if ${t} has-session -t ccc-sid-1 2>/dev/null; then ${mo}; ${t} attach -t ccc-sid-1 || ${fresh}; else ${fresh}; fi`,
    )
  })

  it('uses STAGED_TMUX_BIN_EXPR for staged: true', () => {
    const cmd = buildTmuxLaunchCommand({ ...base, staged: true })
    const t = STAGED_TMUX_BIN_EXPR
    const mo = `${t} set-option -t ccc-sid-1 mouse off 2>/dev/null`
    const fresh = `${t} new-session -s ccc-sid-1 '${mo}; ${base.innerCmd}'`
    expect(cmd).toBe(
      `if ${t} has-session -t ccc-sid-1 2>/dev/null; then ${mo}; ${t} attach -t ccc-sid-1 || ${fresh}; else ${fresh}; fi`,
    )
  })

  it('attaches an existing session and only creates fresh when it is gone', () => {
    const cmd = buildTmuxLaunchCommand(base)
    // Attach branch first (reattach a still-running claude), create second.
    expect(cmd).toMatch(/has-session\s+-t\s+ccc-sid-1/)
    expect(cmd).toMatch(/then\s+.*attach\s+-t\s+ccc-sid-1/)
    expect(cmd).toMatch(/else\s+.*new-session\s+-s\s+ccc-sid-1/)
  })

  // The attach is NOT atomic with has-session; a lost race (session dies in the
  // ~10ms gap) must self-heal, not strand the user (adversarial review,
  // 2026-08-18). Mutation to prove this can fail: drop the `|| <fresh>` from the
  // attach branch.
  it('falls the attach THROUGH to a fresh create when the reattach fails', () => {
    const cmd = buildTmuxLaunchCommand(base)
    // The live-reattach `attach -t X` is immediately backstopped by `|| <fresh>`.
    expect(cmd).toContain('attach -t ccc-sid-1 || ')
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
    expect(cmd).toContain('attach -t ccc-sid-1 || ')
    expect(cmd).not.toMatch(/attach -t ccc-sid-1 --continue/)
    const creates = cmd.split('new-session -s ccc-sid-1 ').slice(1)
    expect(creates.length).toBe(2)
    // #546: the fresh pane runs `<mouse-off>; <claude> --continue`, so --continue
    // still rides the fresh branch (never the live attach) — now after the
    // mouse-off prefix inside the quoted arg.
    const mo = `${ON_PATH_TMUX_BIN_EXPR} set-option -t ccc-sid-1 mouse off 2>/dev/null`
    for (const c of creates) expect(c.startsWith(`'${mo}; ${base.innerCmd} --continue'`)).toBe(true)
  })

  it('never adds --continue on a first connect (reconnect: false)', () => {
    const cmd = buildTmuxLaunchCommand({ ...base, reconnect: false })
    expect(cmd).not.toContain('--continue')
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
    // #546: the quoted pane command is `<mouse-off>; <innerCmd>`.
    const mo = `${ON_PATH_TMUX_BIN_EXPR} set-option -t ccc-sid-1 mouse off 2>/dev/null`
    const quotedArg = `'${mo}; ${base.innerCmd}'`
    const idx = cmd.indexOf(quotedArg)
    expect(idx).toBeGreaterThan(-1)
    // The CLAUDE env var only appears INSIDE the quoted argument (after the
    // opening quote + the mouse-off prefix), never as a bare leading token
    // before the tmux binary token.
    expect(cmd.indexOf('CLAUDE_CODE_DISABLE_MOUSE_CLICKS')).toBe(idx + 1 + `${mo}; `.length)
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
    // #546: the pane runs `<mouse-off>; <innerCmd>`; the innerCmd's own quotes
    // still round-trip through the POSIX single-quote escaping intact.
    const mo = `${ON_PATH_TMUX_BIN_EXPR} set-option -t ccc-sid-1 mouse off 2>/dev/null`
    expect(unescaped).toBe(`${mo}; ${innerCmd}`)
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
    // Attach branch: mouse-off from the outer shell before reattaching.
    expect(cmd).toContain(`then ${t} set-option -t ccc-sid-1 mouse off 2>/dev/null; ${t} attach`)
    // Fresh pane: mouse-off is the first thing the pane command runs, before claude.
    expect(cmd).toContain(`new-session -s ccc-sid-1 '${t} set-option -t ccc-sid-1 mouse off 2>/dev/null; `)
    // Never global — that would clobber the user's own tmux sessions.
    expect(cmd).not.toContain('set-option -g mouse')
    expect(cmd).not.toContain('-g mouse off')
  })

  it('uses the staged token for the mouse-off on a staged tier', () => {
    const cmd = buildTmuxLaunchCommand({ ...base, staged: true })
    const t = STAGED_TMUX_BIN_EXPR
    expect(cmd).toContain(`then ${t} set-option -t ccc-sid-1 mouse off 2>/dev/null; ${t} attach`)
    expect(cmd).toContain(`new-session -s ccc-sid-1 '${t} set-option -t ccc-sid-1 mouse off 2>/dev/null; `)
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
    expect(cmd.startsWith('if command tmux has-session -t ccc-sid-1 ')).toBe(true)
    // #546: the mouse-off (same literal token) precedes attach on this branch.
    expect(cmd).toContain('then command tmux set-option -t ccc-sid-1 mouse off 2>/dev/null; command tmux attach -t ccc-sid-1 || command tmux new-session -s ccc-sid-1 ')
    expect(cmd).toContain('else command tmux new-session -s ccc-sid-1 ')
    // The alias-expandable substitution form must never come back, anywhere
    // in the command.
    expect(cmd).not.toContain('$(command -v')
    expect(cmd).not.toContain('command -v tmux')
  })

  it('the staged (tier-2/3/4) launch command carries the literal `"$HOME"/.claude/bin/tmux` token and no `$(command -v` either', () => {
    const cmd = buildTmuxLaunchCommand({ ...base, staged: true })
    expect(cmd.startsWith('if "$HOME"/.claude/bin/tmux has-session -t ccc-sid-1 ')).toBe(true)
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
