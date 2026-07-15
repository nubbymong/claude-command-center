/**
 * Regression: the IPC `pty:spawn` zod schema must accept ALL SIX effort levels
 * (low/medium/high/xhigh/max/ultracode), not just the original three. The live
 * effort can be xhigh/max/ultracode (set via /effort, shown on the session card)
 * and is persisted (session-persistence.ts); restoring such a session passes its
 * effortLevel to pty.spawn. If the schema only allowed low/medium/high, parse()
 * would throw "Invalid parameters" and the session would fail to respawn.
 *
 * PERMISSIVE contract (spec 2026-06-11 §4): the schema is now a bounded string,
 * not an enum. Unknown future effort levels are accepted and flow to the Sentinel
 * observe seam in effort-tracker rather than being rejected at spawn.
 *
 * SECURITY (code-review finding): effortLevel and model are both shell-interpolated
 * UNQUOTED into the PTY spawn command. The charset guard (/^[a-zA-Z0-9_-]+$/ for
 * effort, /^[a-zA-Z0-9._[\]-]+$/ for model) rejects shell metacharacters while
 * keeping every legitimate value accepted. Mirror of the resume.uuid UUID guard.
 */
import { describe, it, expect } from 'vitest'
import { spawnOptionsSchema } from '../../../src/main/ipc/pty-handlers'

describe('pty-handlers spawnOptionsSchema -- effortLevel (all 6 levels)', () => {
  const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'] as const

  it('accepts and preserves every effort level through parse', () => {
    for (const level of LEVELS) {
      const parsed = spawnOptionsSchema.parse({ cwd: 'C:/work', effortLevel: level })
      expect(parsed?.effortLevel).toBe(level)
    }
  })

  it('parses cleanly when effortLevel is omitted', () => {
    const parsed = spawnOptionsSchema.parse({ cwd: 'C:/work' })
    expect(parsed?.effortLevel).toBeUndefined()
  })

  it('accepts an unknown effort level (permissive: flows to Sentinel observe, not rejected at spawn)', () => {
    const parsed = spawnOptionsSchema.parse({ cwd: 'C:/work', effortLevel: 'turbo' as never })
    expect(parsed?.effortLevel).toBe('turbo')
  })
})

describe('pty-handlers spawnOptionsSchema -- effortLevel charset guard (shell-injection defense)', () => {
  it('rejects a semicolon-injected effort level', () => {
    expect(() =>
      spawnOptionsSchema.parse({ cwd: 'C:/work', effortLevel: 'high; calc.exe' }),
    ).toThrow()
  })

  it('rejects a backtick-injected effort level', () => {
    expect(() =>
      spawnOptionsSchema.parse({ cwd: 'C:/work', effortLevel: 'high`calc`' }),
    ).toThrow()
  })

  it('rejects a dollar-sign subshell effort level', () => {
    expect(() =>
      spawnOptionsSchema.parse({ cwd: 'C:/work', effortLevel: '$(calc.exe)' }),
    ).toThrow()
  })
})

describe('pty-handlers spawnOptionsSchema -- model charset guard (shell-injection defense)', () => {
  it('accepts the standard model aliases', () => {
    const VALID_MODELS = ['opus', 'opus[1m]', 'fable', 'sonnet', 'haiku', 'claude-opus-4-8']
    for (const m of VALID_MODELS) {
      const parsed = spawnOptionsSchema.parse({ cwd: 'C:/work', model: m })
      expect(parsed?.model).toBe(m)
    }
  })

  it('parses cleanly when model is omitted', () => {
    const parsed = spawnOptionsSchema.parse({ cwd: 'C:/work' })
    expect(parsed?.model).toBeUndefined()
  })

  it('accepts model: "" — the default "no override" every session without an explicit model sends', () => {
    // Regression (re-review blocker): sessionStore.model is non-optional and defaults
    // to ''; TerminalView passes it verbatim to pty.spawn. Rejecting '' bricks every
    // default-model spawn/restore. Emission already skips empty (if (options?.model)).
    const parsed = spawnOptionsSchema.parse({ cwd: 'C:/work', model: '' })
    expect(parsed?.model).toBe('')
  })

  it('rejects a semicolon-injected model value', () => {
    expect(() =>
      spawnOptionsSchema.parse({ cwd: 'C:/work', model: 'opus; calc.exe' }),
    ).toThrow()
  })

  it('rejects a shell-subshell model value', () => {
    expect(() =>
      spawnOptionsSchema.parse({ cwd: 'C:/work', model: '$(rm -rf /)' }),
    ).toThrow()
  })
})

describe('pty-handlers spawnOptionsSchema -- resume.uuid format (FIX 4)', () => {
  const VALID_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const CWD = 'C:/work'

  it('accepts a canonical UUID resume target', () => {
    const parsed = spawnOptionsSchema.parse({ cwd: CWD, resume: { uuid: VALID_UUID, cwd: CWD } })
    expect(parsed?.resume?.uuid).toBe(VALID_UUID)
  })

  it('rejects a non-UUID resume.uuid (shell-injection shaped string)', () => {
    expect(() =>
      spawnOptionsSchema.parse({ cwd: CWD, resume: { uuid: '$(rm -rf /)', cwd: CWD } }),
    ).toThrow()
  })

  it('rejects a plausible-but-malformed resume.uuid', () => {
    expect(() =>
      spawnOptionsSchema.parse({ cwd: CWD, resume: { uuid: 'not-a-uuid', cwd: CWD } }),
    ).toThrow()
  })
})
