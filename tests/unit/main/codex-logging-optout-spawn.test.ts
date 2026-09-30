/**
 * P3.12 (row 31): a Codex config's indexing opt-out reaches the run gate the
 * way Claude's does. The config's codexOptions ride to pty:spawn whole (its
 * loggingEnabled among them, which the schema passes over), and the session's
 * top-level loggingEnabled, set from codexOptions at launch and on restore, is
 * what the gate reads. Driven through the REAL pty:spawn schema, the fail-open
 * restore sanitizer and the real gate.
 */
import { describe, it, expect } from 'vitest'
import { spawnOptionsSchema } from '../../../src/main/ipc/pty-handlers'
import { sanitizeRestoredSpawnOptions } from '../../../src/main/sanitize-restored-spawn-options'
import { shouldRegisterRun } from '../../../src/main/logging/should-register-run'

const spawn = (loggingEnabled: boolean | undefined) => ({
  cwd: 'C:/work',
  provider: 'codex',
  codexOptions: { permissionsPreset: 'read-only', ...(loggingEnabled === undefined ? {} : { loggingEnabled }) },
  ...(loggingEnabled === undefined ? {} : { loggingEnabled }),
})

describe('a Codex spawn and its indexing opt-out (P3.12)', () => {
  it('the schema takes a Codex spawn carrying its config\'s opt-out, and keeps the top-level value the gate reads', () => {
    for (const v of [false, true, undefined]) {
      const r = spawnOptionsSchema.safeParse(spawn(v))
      expect(r.success).toBe(true)
      expect(r.success ? r.data?.loggingEnabled : 'refused').toBe(v === undefined ? undefined : v)
    }
  })

  it('the restore sanitizer drops nothing of it', () => {
    const out = sanitizeRestoredSpawnOptions(spawn(false) as never, () => {}) as { loggingEnabled?: boolean }
    expect(out.loggingEnabled).toBe(false)
  })

  it('the gate: a Codex run is recorded by default and not when its config opted out', () => {
    const parsed = (v: boolean | undefined) => spawnOptionsSchema.parse(spawn(v)) as { provider?: 'claude' | 'codex'; loggingEnabled?: boolean }
    expect(shouldRegisterRun(parsed(undefined), {})).toBe(true)
    expect(shouldRegisterRun(parsed(true), {})).toBe(true)
    expect(shouldRegisterRun(parsed(false), {})).toBe(false)
    expect(shouldRegisterRun(parsed(undefined), { loggingEnabled: false })).toBe(false)
  })
})
