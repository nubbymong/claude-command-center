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
    const fresh = `${t} new-session -s ccc-sid-1 '${base.innerCmd}'`
    expect(cmd).toBe(
      `if ${t} has-session -t ccc-sid-1 2>/dev/null; then ${t} attach -t ccc-sid-1 || ${fresh}; else ${fresh}; fi`,
    )
  })

  it('uses STAGED_TMUX_BIN_EXPR for staged: true', () => {
    const cmd = buildTmuxLaunchCommand({ ...base, staged: true })
    const t = STAGED_TMUX_BIN_EXPR
    const fresh = `${t} new-session -s ccc-sid-1 '${base.innerCmd}'`
    expect(cmd).toBe(
      `if ${t} has-session -t ccc-sid-1 2>/dev/null; then ${t} attach -t ccc-sid-1 || ${fresh}; else ${fresh}; fi`,
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
    for (const c of creates) expect(c.startsWith(`'${base.innerCmd} --continue'`)).toBe(true)
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
    const quotedArg = `'${base.innerCmd}'`
    const idx = cmd.indexOf(quotedArg)
    expect(idx).toBeGreaterThan(-1)
    // Nothing before the tmux binary token, and the env var itself only
    // appears inside the quoted argument (never as a bare leading token).
    expect(cmd.indexOf('CLAUDE_CODE_DISABLE_MOUSE_CLICKS')).toBe(idx + 1)
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
    expect(unescaped).toBe(innerCmd)
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
