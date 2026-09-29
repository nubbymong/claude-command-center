// P3.8 (row 40): a Codex session starts on any reasoning effort its model
// offers. The Codex CLI's efforts are none, minimal, low, medium, high, xhigh,
// max and ultra (the ReasoningEffort values of the 0.153.4 binary); its models
// offer low to ultra (the bundled catalogue). The launch argument
// `-c model_reasoning_effort=<value>` is built from an allowlist, never from a
// free string, and every level the registry offers for Codex is on it.
import { describe, it, expect, vi } from 'vitest'
import { spawnOptionsSchema } from '../../../src/main/ipc/pty-handlers'
import { CODEX_EFFORTS, sanitizeRestoredSpawnOptions } from '../../../src/main/sanitize-restored-spawn-options'
import baselineJson from '../../../resources/model-registry.json'
import type { ModelRegistry } from '../../../src/shared/model-registry'

const reg = baselineJson as unknown as ModelRegistry
const codex = (reasoningEffort: unknown) => ({
  cwd: 'C:/work', provider: 'codex', codexOptions: { model: 'gpt-6-astra', reasoningEffort, permissionsPreset: 'standard' },
})

// P3.8 round 1 (L2): Plan mode is a permissions choice, as Claude's is.
describe('the Codex permission presets at the spawn boundary', () => {
  const preset = (permissionsPreset: unknown) => ({ cwd: 'C:/work', provider: 'codex', codexOptions: { permissionsPreset } })
  it('takes plan beside the four it had, and nothing else', () => {
    for (const p of ['read-only', 'standard', 'auto', 'unrestricted', 'plan']) expect(spawnOptionsSchema.parse(preset(p))?.codexOptions?.permissionsPreset).toBe(p)
    for (const bad of ['Plan', 'plan ', 'planning', '', 7]) expect(() => spawnOptionsSchema.parse(preset(bad)), JSON.stringify(bad)).toThrow()
  })
  it('a restored plan session keeps plan', () => {
    expect(sanitizeRestoredSpawnOptions({ provider: 'codex', codexOptions: { permissionsPreset: 'plan' } }).codexOptions.permissionsPreset).toBe('plan')
  })
})

describe('the Codex reasoning effort allowlist', () => {
  it('is the Codex CLI effort set', () => {
    expect([...CODEX_EFFORTS]).toEqual(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
  })

  it('takes every level on it at the spawn boundary, max and ultra included', () => {
    for (const e of CODEX_EFFORTS) expect(spawnOptionsSchema.parse(codex(e))?.codexOptions?.reasoningEffort).toBe(e)
  })

  it('refuses anything else, so no other text reaches the launch argument', () => {
    for (const bad of ['ultracode', 'bogus', 'max\n', ' low', 'low ', 'high;x', '', 42]) {
      expect(() => spawnOptionsSchema.parse(codex(bad)), JSON.stringify(bad)).toThrow()
    }
  })

  it('holds every level the registry offers Codex, and every level a Codex model lists', () => {
    const allowed = new Set<string>(CODEX_EFFORTS)
    for (const l of reg.providerEffortLevels?.codex ?? []) expect(allowed.has(l.value), l.value).toBe(true)
    expect((reg.providerEffortLevels?.codex ?? []).length).toBeGreaterThan(0)
    for (const m of reg.models.filter((x) => x.family === 'codex' && x.pickable !== false)) {
      for (const e of m.efforts ?? []) expect(allowed.has(e), `${m.id} ${e}`).toBe(true)
    }
  })

  it('a restored session with an effort off the list launches on the model default instead of failing the spawn', () => {
    const log = vi.fn()
    for (const bad of ['ultracode', 'max\n', 7, null]) {
      const out = sanitizeRestoredSpawnOptions({ provider: 'codex', codexOptions: { model: 'gpt-5.5', reasoningEffort: bad, permissionsPreset: 'auto' } }, log)
      expect(out.codexOptions.reasoningEffort, JSON.stringify(bad)).toBeUndefined()
      expect(out.codexOptions.model).toBe('gpt-5.5')
      expect(() => spawnOptionsSchema.parse({ cwd: 'C:/work', ...out })).not.toThrow()
    }
    expect(log).toHaveBeenCalledTimes(4)
    for (const good of CODEX_EFFORTS) {
      expect(sanitizeRestoredSpawnOptions({ provider: 'codex', codexOptions: { reasoningEffort: good, permissionsPreset: 'auto' } }).codexOptions.reasoningEffort).toBe(good)
    }
  })
})
