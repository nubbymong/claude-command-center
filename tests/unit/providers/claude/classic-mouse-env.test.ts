/**
 * TDD: CLAUDE_CODE_DISABLE_MOUSE env injection
 *
 * When classicTerminalCopyPaste is true (or undefined/unset), the Claude local
 * spawn env must include CLAUDE_CODE_DISABLE_MOUSE=1 so xterm owns the mouse
 * instead of CC (classic selection + right-click copy/paste).
 *
 * When false the var must be absent so CC's mouse mode is preserved.
 *
 * SSH and shell-only sessions are handled separately (SSH goes through a
 * different path; shell-only receives no CLAUDE env vars in buildClaudeLocalSpawn).
 *
 * Note: we clear CLAUDE_CODE_DISABLE_MOUSE from process.env before each test
 * because the developer machine (and CI) may run with this var set, which would
 * bleed through the `{ ...process.env }` spread into the "should be absent"
 * assertions and produce false failures.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildClaudeLocalSpawn } from '../../../../src/main/providers/claude/spawn'

const BASE_OPTS = { sessionId: 'ses-1', cwd: '/work', cols: 80, rows: 24 }

beforeEach(() => {
  delete process.env.CLAUDE_CODE_DISABLE_MOUSE
  delete process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN
})

afterEach(() => {
  delete process.env.CLAUDE_CODE_DISABLE_MOUSE
  delete process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN
})

describe('buildClaudeLocalSpawn — CLAUDE_CODE_DISABLE_MOUSE', () => {
  it('sets CLAUDE_CODE_DISABLE_MOUSE=1 when classicTerminalCopyPaste is true', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS, classicTerminalCopyPaste: true })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBe('1')
  })

  it('sets CLAUDE_CODE_DISABLE_MOUSE=1 when classicTerminalCopyPaste is undefined (default-on)', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBe('1')
  })

  it('omits CLAUDE_CODE_DISABLE_MOUSE when classicTerminalCopyPaste is false', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS, classicTerminalCopyPaste: false })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBeUndefined()
  })

  it('does NOT set CLAUDE_CODE_DISABLE_MOUSE for shell-only sessions (true)', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS, shellOnly: true, classicTerminalCopyPaste: true })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBeUndefined()
  })

  it('does NOT set CLAUDE_CODE_DISABLE_MOUSE for shell-only sessions (undefined)', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS, shellOnly: true })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBeUndefined()
  })
})
