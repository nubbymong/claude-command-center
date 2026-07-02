/**
 * CLAUDE_CODE_DISABLE_MOUSE_CLICKS env injection (clickable question options).
 *
 * Claude Code >= 2.1.195 renders question options as clickable targets and the
 * official opt-out is CLAUDE_CODE_DISABLE_MOUSE_CLICKS=1 (disables click/drag/
 * hover, keeps wheel scroll). CCC defaults the feature OFF: the var must be
 * present unless the user explicitly enables clickableQuestions in Settings.
 *
 * Shell-only sessions receive no CLAUDE env vars (same contract as
 * CLAUDE_CODE_DISABLE_MOUSE). process.env is cleared per test because a dev
 * machine may run with the var set, bleeding through the spread.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildClaudeLocalSpawn } from '../../../../src/main/providers/claude/spawn'

const BASE_OPTS = { sessionId: 'ses-1', cwd: '/work', cols: 80, rows: 24 }

beforeEach(() => {
  delete process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS
})

afterEach(() => {
  delete process.env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS
})

describe('buildClaudeLocalSpawn — CLAUDE_CODE_DISABLE_MOUSE_CLICKS', () => {
  it('sets the var when clickableQuestions is undefined (CCC default: clicks off)', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS).toBe('1')
  })

  it('sets the var when clickableQuestions is false', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS, clickableQuestions: false })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS).toBe('1')
  })

  it('omits the var when clickableQuestions is true (user opted back in)', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS, clickableQuestions: true })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS).toBeUndefined()
  })

  it('does NOT set the var for shell-only sessions', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS, shellOnly: true })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS).toBeUndefined()
  })

  it('is independent of classicTerminalCopyPaste (both vars coexist)', () => {
    const { env } = buildClaudeLocalSpawn({ ...BASE_OPTS, classicTerminalCopyPaste: false })
    expect(env.CLAUDE_CODE_DISABLE_MOUSE).toBeUndefined()
    expect(env.CLAUDE_CODE_DISABLE_MOUSE_CLICKS).toBe('1')
  })
})
