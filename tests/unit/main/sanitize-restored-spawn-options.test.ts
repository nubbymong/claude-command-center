import { describe, it, expect, vi } from 'vitest'
import { sanitizeRestoredSpawnOptions } from '../../../src/main/sanitize-restored-spawn-options'

// #397 Group 5: a corrupt persisted resume/codex field must not abort the spawn.
// The sanitizer repairs fail-open (drop resume / floor codex preset) BEFORE the
// strict schema parse, and never widens what that schema accepts.

const goodUuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

describe('sanitizeRestoredSpawnOptions', () => {
  it('passes a valid resume target through unchanged', () => {
    const out = sanitizeRestoredSpawnOptions({ resume: { uuid: goodUuid, cwd: 'C:/p' } })
    expect(out.resume).toEqual({ uuid: goodUuid, cwd: 'C:/p' })
  })

  it('drops a resume with a non-UUID uuid (falls back to the picker) and logs', () => {
    const log = vi.fn()
    const out = sanitizeRestoredSpawnOptions({ resume: { uuid: 'not-a-uuid', cwd: 'C:/p' } }, log)
    expect(out.resume).toBeUndefined()
    expect(log).toHaveBeenCalledOnce()
  })

  it('drops a resume with an empty cwd', () => {
    const out = sanitizeRestoredSpawnOptions({ resume: { uuid: goodUuid, cwd: '' } })
    expect(out.resume).toBeUndefined()
  })

  it('drops a resume with an over-long cwd (> 4096)', () => {
    const out = sanitizeRestoredSpawnOptions({ resume: { uuid: goodUuid, cwd: 'x'.repeat(4097) } })
    expect(out.resume).toBeUndefined()
  })

  it('defaults a codex session with NO codexOptions to read-only', () => {
    const out: any = sanitizeRestoredSpawnOptions({ provider: 'codex' })
    expect(out.codexOptions).toEqual({ permissionsPreset: 'read-only' })
  })

  it('floors an invalid codex permissionsPreset to read-only, keeping other codex fields', () => {
    const out: any = sanitizeRestoredSpawnOptions({
      provider: 'codex',
      codexOptions: { model: 'gpt', reasoningEffort: 'high', permissionsPreset: 'root' as any },
    })
    expect(out.codexOptions).toEqual({ model: 'gpt', reasoningEffort: 'high', permissionsPreset: 'read-only' })
  })

  it('leaves a valid codex preset untouched', () => {
    const out: any = sanitizeRestoredSpawnOptions({
      provider: 'codex',
      codexOptions: { permissionsPreset: 'auto' },
    })
    expect(out.codexOptions.permissionsPreset).toBe('auto')
  })

  it('does NOT inject codexOptions for a non-codex provider', () => {
    const out: any = sanitizeRestoredSpawnOptions({ provider: 'claude' })
    expect(out.codexOptions).toBeUndefined()
  })

  it('returns undefined input as-is without throwing', () => {
    expect(() => sanitizeRestoredSpawnOptions(undefined)).not.toThrow()
    expect(sanitizeRestoredSpawnOptions(undefined)).toBeUndefined()
  })

  it('never mutates the input object', () => {
    const input = { resume: { uuid: 'bad', cwd: 'C:/p' }, provider: 'codex' as const }
    const out = sanitizeRestoredSpawnOptions(input)
    expect(input.resume).toEqual({ uuid: 'bad', cwd: 'C:/p' }) // original untouched
    expect(out).not.toBe(input)
  })
})
