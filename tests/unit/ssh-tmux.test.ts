// tests/unit/ssh-tmux.test.ts
//
// #242: tmux persistence wrapper. `-A` makes reconnect the IDENTICAL code
// path (attach if the session exists, else create it) — dropping it would
// make every reconnect spawn a SECOND claude inside a brand-new session
// instead of resuming the live one.
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
}

describe('buildTmuxLaunchCommand', () => {
  it('builds new-session -A -s ccc-<sid> <cmd>, using ON_PATH_TMUX_BIN_EXPR for staged: false', () => {
    const cmd = buildTmuxLaunchCommand(base)
    expect(cmd).toBe(`${ON_PATH_TMUX_BIN_EXPR} new-session -A -s ccc-sid-1 '${base.innerCmd}'`)
  })

  it('uses STAGED_TMUX_BIN_EXPR for staged: true', () => {
    const cmd = buildTmuxLaunchCommand({ ...base, staged: true })
    expect(cmd).toBe(`${STAGED_TMUX_BIN_EXPR} new-session -A -s ccc-sid-1 '${base.innerCmd}'`)
  })

  it('carries -A so reconnect attaches instead of creating a second session', () => {
    const cmd = buildTmuxLaunchCommand(base)
    expect(cmd).toMatch(/new-session\s+-A\s+-s\s+ccc-/)
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
    expect(cmd.startsWith(ON_PATH_TMUX_BIN_EXPR)).toBe(true)
  })

  it('single-quotes an innerCmd containing a single quote without breaking out of the argument', () => {
    const innerCmd = `echo 'hi' && say "done"`
    const cmd = buildTmuxLaunchCommand({ ...base, innerCmd })
    const marker = '-s ccc-sid-1 '
    const quotedArg = cmd.slice(cmd.indexOf(marker) + marker.length)
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
    expect(cmd.startsWith(ON_PATH_TMUX_BIN_EXPR)).toBe(true)
  })

  it('ignores anything extra on the input object -- staged: true always emits STAGED_TMUX_BIN_EXPR', () => {
    const cmd = buildTmuxLaunchCommand({ ...base, staged: true, tmuxBin: '/tmp/.claude/bin/tmux' } as never)
    expect(cmd).not.toContain('/tmp/.claude/bin/tmux')
    expect(cmd.startsWith(STAGED_TMUX_BIN_EXPR)).toBe(true)
  })
})

// #242 tier 5: `--continue` on a reconnect, gated OFF whenever tmux is in
// play (the `-A` reattach already IS the reconnect path in that case; see
// buildSshClaudeFlags's doc comment for why a second claude inside the same
// attached pane would be wrong). Both directions are separate mutations a
// single test cannot catch: dropping the `!tmuxInPlay` gate only shows up
// with tmux present, and dropping the `reconnect` gate only shows up with
// tmux absent -- hence two dedicated tests rather than one table-driven one.
describe('buildSshClaudeFlags / shouldAddContinueFlag (#242 tier 5)', () => {
  it('adds --continue on a reconnect with no tmux in play', () => {
    expect(shouldAddContinueFlag({ reconnect: true, tmuxInPlay: false })).toBe(true)
    expect(buildSshClaudeFlags({ reconnect: true, tmuxInPlay: false })).toBe('--continue')
  })

  // Mutation this catches: dropping `!input.tmuxInPlay` from the gate (e.g.
  // `return input.reconnect`) would make this fail -- tmux's own `-A` already
  // reattaches to the live claude process, so a SECOND `--continue` would
  // start a second claude inside that same attached pane.
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
