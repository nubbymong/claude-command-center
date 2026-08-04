import { describe, it, expect } from 'vitest'
import { buildClaudeLocalSpawn } from '../../../src/main/providers/claude/spawn'
import { buildTerminalLaunchLine } from '../../../src/main/terminal-launch-line'

/**
 * 2.1.0-beta.6 — Terminal-only secret argument.
 *
 * SECURITY CONTRACT: the secret VALUE goes into the spawn ENV only. It must
 * never be interpolated into the command text, because CCC writes that text
 * into the PTY and every submitted line is recorded by the shell's persistent
 * history (PSReadLine's ConsoleHost_history.txt on Windows) — a plaintext
 * credential on disk, forever. The launch line references $env:CCC_ARG_SECRET
 * instead; substitution is asserted in the sibling test below.
 */
describe('terminal-only secret argument → spawn env', () => {
  const base = { sessionId: 's1', cols: 80, rows: 24 } as any

  it('puts the secret in CCC_ARG_SECRET for a shell-only spawn', () => {
    const { env } = buildClaudeLocalSpawn({ ...base, shellOnly: true, terminalSecret: 'sk-supersecret' })
    expect(env.CCC_ARG_SECRET).toBe('sk-supersecret')
  })

  it('never sets the secret env for a NON shell-only (Claude) spawn', () => {
    const { env } = buildClaudeLocalSpawn({ ...base, shellOnly: false, terminalSecret: 'sk-supersecret' })
    expect(env.CCC_ARG_SECRET).toBeUndefined()
  })

  it('sets nothing when no secret is stored', () => {
    const { env } = buildClaudeLocalSpawn({ ...base, shellOnly: true })
    expect(env.CCC_ARG_SECRET).toBeUndefined()
  })

  it('keeps the secret out of the spawn command and argv entirely', () => {
    const { cmd, args } = buildClaudeLocalSpawn({ ...base, shellOnly: true, terminalSecret: 'sk-supersecret' })
    expect(cmd).not.toContain('sk-supersecret')
    expect(args.join(' ')).not.toContain('sk-supersecret')
  })

  it('still elevates when asked (gsudo/sudo wraps the shell)', () => {
    const { cmd, args } = buildClaudeLocalSpawn({ ...base, shellOnly: true, elevated: true })
    expect(cmd).toMatch(/^(gsudo|sudo)$/)
    expect(args.length).toBeGreaterThan(0)
  })
})

/** Exercises the REAL builder used by the shell-only spawn path — not a copy. */
describe('buildTerminalLaunchLine — {secret} substitution', () => {
  const win = (o: any) => buildTerminalLaunchLine(o, true)
  const posix = (o: any) => buildTerminalLaunchLine(o, false)

  it('substitutes an env REFERENCE, never the value (Windows)', () => {
    const out = win({ command: 'openclaw', args: '--token {secret}', hasSecretArg: true })
    expect(out).toBe('openclaw --token $env:CCC_ARG_SECRET')
  })

  it('substitutes a quoted env reference on POSIX', () => {
    expect(posix({ command: 'openclaw', args: '--token {secret}', hasSecretArg: true }))
      .toBe('openclaw --token "$CCC_ARG_SECRET"')
  })

  it('collapses the token to empty when no secret is stored (no dangling var)', () => {
    expect(win({ command: 'openclaw', args: '--token {secret}' })).toBe('openclaw --token')
  })

  it('replaces every occurrence', () => {
    expect(win({ command: 'x', args: '{secret} and {secret}', hasSecretArg: true }))
      .toBe('x $env:CCC_ARG_SECRET and $env:CCC_ARG_SECRET')
  })

  it('leaves arguments without the token untouched', () => {
    expect(win({ command: 'openclaw', args: '--port 4310' })).toBe('openclaw --port 4310')
  })

  it('returns the bare command when there are no arguments', () => {
    expect(win({ command: 'openclaw' })).toBe('openclaw')
  })

  it('returns EMPTY when no command is set (a plain shell, nothing typed)', () => {
    expect(win({ args: '--port 4310', hasSecretArg: true })).toBe('')
    expect(win(undefined)).toBe('')
    expect(win({ command: '   ' })).toBe('')
  })
})
