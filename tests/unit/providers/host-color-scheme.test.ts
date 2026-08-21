/**
 * One definition of the host light/dark signal for every launch path (book
 * item 34): the local Claude env, the Codex env, and the SSH remote launch
 * line, where the value's `;` would end a POSIX command unless quoted.
 */
import { describe, it, expect } from 'vitest'
import { colorFgBgValue, colorFgBgEnvToken, resolveHostColorScheme } from '../../../src/main/providers/host-color-scheme'
import { buildTmuxLaunchCommand } from '../../../src/main/ssh-tmux'
import { buildWindowsClaudeCommand } from '../../../src/main/providers/claude/ssh-shim'

describe('colorFgBgValue', () => {
  it('light -> "0;15", dark -> "15;0" (Claude reads the background field)', () => {
    expect(colorFgBgValue('light')).toBe('0;15')
    expect(colorFgBgValue('dark')).toBe('15;0')
  })
})

describe('colorFgBgEnvToken -- the remote launch-line form', () => {
  it('POSIX: single-quoted, because `;` ends a command', () => {
    expect(colorFgBgEnvToken('light', 'posix')).toBe(`COLORFGBG='0;15'`)
    expect(colorFgBgEnvToken('dark', 'posix')).toBe(`COLORFGBG='15;0'`)
  })
  it('Windows cmd: bare, because buildWindowsClaudeCommand wraps it as set "NAME=value"', () => {
    expect(colorFgBgEnvToken('light', 'windows-cmd')).toBe('COLORFGBG=0;15')
    const line = buildWindowsClaudeCommand({ sessionId: 's1', envPrefixVars: [colorFgBgEnvToken('light', 'windows-cmd')], extraFlags: '', continueFlag: '' })
    expect(line).toContain('set "COLORFGBG=0;15"&& claude ')
  })
  it('survives the tmux wrap: the inner command is single-quoted and the embedded quotes are escaped', () => {
    const inner = `${colorFgBgEnvToken('light', 'posix')} claude --settings x`
    const wrapped = buildTmuxLaunchCommand({ sessionId: 's1', innerCmd: inner, staged: false, reconnect: false })
    // '\'' is how a single quote is written inside a single-quoted sh string;
    // the remote sh unwraps it back to COLORFGBG='0;15'.
    expect(wrapped).toContain(`COLORFGBG='\\''0;15'\\'' claude`)
  })
})

describe('resolveHostColorScheme (moved here from the Claude provider; same table)', () => {
  it.each([
    ['light', true, 'light'],
    ['light', false, 'light'],
    ['dark', false, 'dark'],
    ['dark', true, 'dark'],
    ['system', true, 'dark'],
    ['system', false, 'light'],
    [undefined, true, 'dark'],
    [undefined, false, 'dark'],
  ] as const)('theme=%s systemDark=%s -> %s', (theme, sysDark, want) => {
    expect(resolveHostColorScheme(theme, sysDark)).toBe(want)
  })
})
