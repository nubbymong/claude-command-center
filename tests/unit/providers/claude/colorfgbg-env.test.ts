/**
 * TDD: COLORFGBG env injection (light/dark signal for Claude Code theme detection)
 *
 * Claude Code reads COLORFGBG first to auto-detect the terminal background and
 * pick its light/dark theme. A host (CCC) flipped to light mode but never told
 * Claude, so Claude kept rendering its user-message blocks with dark backgrounds
 * (black on a light terminal). We now stamp COLORFGBG from the host's resolved
 * scheme so a session LAUNCHED in light mode themes light.
 *
 * Format is "foreground;background" by ANSI index; Claude reads the background
 * field (7 or 9-15 = light, 0-6/8 = dark). dark -> "15;0" matches the prior
 * default behavior, so dark mode is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildClaudeLocalSpawn, resolveHostColorScheme } from '../../../../src/main/providers/claude/spawn'

const BASE_OPTS = { sessionId: 'ses-1', cwd: '/work', cols: 80, rows: 24 }

beforeEach(() => {
  delete process.env.COLORFGBG
})
afterEach(() => {
  delete process.env.COLORFGBG
})

describe('buildClaudeLocalSpawn — COLORFGBG', () => {
  it('stamps a light background value when the host is light', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS, hostColorScheme: 'light' })
    expect(env.COLORFGBG).toBe('0;15')
  })

  it('stamps a dark background value when the host is dark', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS, hostColorScheme: 'dark' })
    expect(env.COLORFGBG).toBe('15;0')
  })

  it('does not set COLORFGBG when the host scheme is unspecified', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS })
    expect(env.COLORFGBG).toBeUndefined()
  })

  it('applies to shell-only sessions too (the terminal IS that theme)', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS, shellOnly: true, hostColorScheme: 'light' })
    expect(env.COLORFGBG).toBe('0;15')
  })
})

describe('resolveHostColorScheme', () => {
  it('maps explicit light / dark directly (OS preference ignored)', () => {
    expect(resolveHostColorScheme('light', true)).toBe('light')
    expect(resolveHostColorScheme('dark', false)).toBe('dark')
  })

  it('follows the OS preference for the system theme', () => {
    expect(resolveHostColorScheme('system', true)).toBe('dark')
    expect(resolveHostColorScheme('system', false)).toBe('light')
  })

  it('defaults to dark when unset (matches the app default theme)', () => {
    expect(resolveHostColorScheme(undefined, false)).toBe('dark')
  })
})
