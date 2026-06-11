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
