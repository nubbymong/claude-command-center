/**
 * Unit tests for buildClaudeLocalSpawn env-var injection related to
 * classicTerminalCopyPaste (CLAUDE_CODE_DISABLE_MOUSE + CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).
 *
 * Contract:
 *   - classic on (true or undefined = default) → BOTH vars set to '1'.
 *   - classic off (false) → NEITHER var is set (by this function).
 *   - shell-only sessions (elevated included) follow the SAME rule as Claude
 *     sessions. The old exemption ("shell-only → never set") pinned a live
 *     defect: the vars only matter to a `claude` process, and shell-only
 *     sessions are where users start one by hand (the re-auth flow's /login
 *     prompt) — that claude kept mouse tracking, so right-click pasted (and at
 *     a shell prompt executed) the clipboard instead of copying.
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

  it('shell-only: BOTH vars are set (classic default) — hand-run claude must not keep mouse tracking', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE, shellOnly: true })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBe('1')
    expect(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe('1')
  })

  it('shell-only: BOTH vars are set when classicTerminalCopyPaste is true', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE, shellOnly: true, classicTerminalCopyPaste: true })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBe('1')
    expect(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe('1')
  })

  it('shell-only: classic off (false) still sets NEITHER var', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE, shellOnly: true, classicTerminalCopyPaste: false })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBeUndefined()
    expect(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBeUndefined()
  })

  it('shell-only elevated: BOTH vars are set', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE, shellOnly: true, elevated: true })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBe('1')
    expect(env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe('1')
  })
})
