/**
 * Regression: the IPC `pty:spawn` zod schema must accept ALL SIX effort levels
 * (low/medium/high/xhigh/max/ultracode), not just the original three. The live
 * effort can be xhigh/max/ultracode (set via /effort, shown on the session card)
 * and is persisted (session-persistence.ts); restoring such a session passes its
 * effortLevel to pty.spawn. If the schema only allowed low/medium/high, parse()
 * would throw "Invalid parameters" and the session would fail to respawn.
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

  it('rejects an unknown effort level', () => {
    expect(() =>
      spawnOptionsSchema.parse({ cwd: 'C:/work', effortLevel: 'turbo' as never }),
    ).toThrow()
  })
})
