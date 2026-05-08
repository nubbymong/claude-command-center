/**
 * P6.10.1 regression: the IPC `pty:spawn` zod schema must accept and
 * preserve `enableCodexReview` so the field reaches `pty-manager.spawnPty`
 * and the renderer-side propagation chain (Sidebar -> Session -> TerminalView
 * -> pty.spawn payload) is not silently undone at the main-process boundary.
 *
 * Why this exists: the original P6 cluster wired the field through 13 sites
 * but missed the schema. Without this test, a future schema refactor could
 * drop the field again and the only signal would be a manual smoke failure.
 */
import { describe, it, expect } from 'vitest'
import { spawnOptionsSchema } from '../../../src/main/ipc/pty-handlers'

describe('pty-handlers spawnOptionsSchema -- enableCodexReview (P6.10.1)', () => {
  it('preserves enableCodexReview=true through parse', () => {
    const parsed = spawnOptionsSchema.parse({
      cwd: 'C:/work',
      shellOnly: false,
      enableCodexReview: true,
      provider: 'claude',
    })
    expect(parsed?.enableCodexReview).toBe(true)
  })

  it('accepts enableCodexReview=false', () => {
    const parsed = spawnOptionsSchema.parse({
      cwd: 'C:/work',
      enableCodexReview: false,
    })
    expect(parsed?.enableCodexReview).toBe(false)
  })

  it('parses cleanly when enableCodexReview is omitted', () => {
    const parsed = spawnOptionsSchema.parse({
      cwd: 'C:/work',
    })
    expect(parsed?.enableCodexReview).toBeUndefined()
  })

  it('rejects non-boolean values', () => {
    expect(() =>
      spawnOptionsSchema.parse({
        cwd: 'C:/work',
        enableCodexReview: 'yes' as unknown as boolean,
      }),
    ).toThrow()
  })
})
