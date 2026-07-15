/**
 * Unit tests for buildClaudeLocalSpawn env-var injection related to
 * classicTerminalCopyPaste (CLAUDE_CODE_DISABLE_MOUSE + CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).
 *
 * Contract:
 *   - classic on (true or undefined = default) → BOTH vars set to '1'.
 *   - classic off (false) → NEITHER var is set (by this function).
 *   - shell-only sessions → NEITHER var is set, regardless of classicTerminalCopyPaste.
 *
 * We use vi.stubEnv to ensure the host environment's own CLAUDE_CODE_DISABLE_MOUSE
 * value (which may be set on the developer machine) does not interfere with the
 * "neither var is set" assertions.
 *
 * This is a pure unit test — buildClaudeLocalSpawn has no Electron deps and
 * returns a plain { cmd, args, env } object.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildClaudeLocalSpawn } from '../../../src/main/providers/claude/spawn'
import type { SpawnOptions } from '../../../src/main/providers/types'

const BASE: SpawnOptions = {
  sessionId: 'test-session',
  cwd: 'C:\\work',
}

// Stub out the two env vars before each test so the host environment can't
// leak in (developer machines may run CCC with CLAUDE_CODE_DISABLE_MOUSE=1).
beforeEach(() => {
  delete process.env.CLAUDE_CODE_DISABLE_MOUSE
  delete process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN
})

afterEach(() => {
  delete process.env.CLAUDE_CODE_DISABLE_MOUSE
  delete process.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN
})

describe('buildClaudeLocalSpawn — classic copy/paste env vars', () => {
  it('classic on (undefined = default): sets BOTH DISABLE_MOUSE and DISABLE_ALTERNATE_SCREEN', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBe('1')
    expect(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe('1')
  })

  it('classic on (true): sets BOTH DISABLE_MOUSE and DISABLE_ALTERNATE_SCREEN', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE, classicTerminalCopyPaste: true })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBe('1')
    expect(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe('1')
  })

  it('classic off (false): sets NEITHER env var', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE, classicTerminalCopyPaste: false })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBeUndefined()
    expect(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBeUndefined()
  })

  it('shell-only: NEITHER var is set (classic default)', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE, shellOnly: true })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBeUndefined()
    expect(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBeUndefined()
  })

  it('shell-only: NEITHER var is set even when classicTerminalCopyPaste is true', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE, shellOnly: true, classicTerminalCopyPaste: true })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBeUndefined()
    expect(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBeUndefined()
  })

  it('shell-only elevated: NEITHER var is set', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE, shellOnly: true, elevated: true })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBeUndefined()
    expect(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBeUndefined()
  })
})
