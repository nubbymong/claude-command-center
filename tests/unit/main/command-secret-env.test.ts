/**
 * Command-button secrets reach the SHELL spawn's environment, one variable per
 * command, and nowhere else. Same contract as the terminal-config secret
 * (terminal-secret-env.test.ts), extended to buttons.
 */
import { describe, it, expect } from 'vitest'
import { buildClaudeLocalSpawn } from '../../../src/main/providers/claude/spawn'

const base = { sessionId: 's1', cols: 80, rows: 24 } as any

describe('command secrets -> spawn env', () => {
  it('sets CCC_CMD_SECRET_<id> for each command, on a shell-only spawn', () => {
    const { env } = buildClaudeLocalSpawn({
      ...base, shellOnly: true,
      commandSecrets: { aaa111: 'tok-a', bbb222: 'tok-b' },
    })
    expect(env.CCC_CMD_SECRET_aaa111).toBe('tok-a')
    expect(env.CCC_CMD_SECRET_bbb222).toBe('tok-b')
  })

  it('sets NONE of them for a Claude spawn -- a reference typed into the TUI is just text', () => {
    const { env } = buildClaudeLocalSpawn({
      ...base, shellOnly: false,
      commandSecrets: { aaa111: 'tok-a' },
    })
    expect(Object.keys(env).filter((k) => k.startsWith('CCC_CMD_SECRET_'))).toEqual([])
  })

  it('refuses an id that cannot be a variable name, even if main let one through', () => {
    const { env } = buildClaudeLocalSpawn({
      ...base, shellOnly: true,
      commandSecrets: { 'a b': 'x', 'ok1': 'y' } as Record<string, string>,
    })
    expect(Object.keys(env).filter((k) => k.startsWith('CCC_CMD_SECRET_'))).toEqual(['CCC_CMD_SECRET_ok1'])
  })

  it('skips an empty or non-string value', () => {
    const { env } = buildClaudeLocalSpawn({
      ...base, shellOnly: true,
      commandSecrets: { aaa111: '', bbb222: 7 as unknown as string },
    })
    expect(Object.keys(env).filter((k) => k.startsWith('CCC_CMD_SECRET_'))).toEqual([])
  })

  it('keeps every value out of the spawn command and argv', () => {
    const { cmd, args } = buildClaudeLocalSpawn({
      ...base, shellOnly: true,
      commandSecrets: { aaa111: 'tok-a-very-unique' },
    })
    expect(cmd).not.toContain('tok-a-very-unique')
    expect(args.join(' ')).not.toContain('tok-a-very-unique')
  })
})
