// tests/unit/channel-rules-store.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
const store = new Map<string, unknown>()
vi.mock('../../src/main/channel-storage', () => ({
  readJsonFile: <T>(name: string, seed: () => T): T => (store.has(name) ? store.get(name) as T : seed()),
  writeJsonFile: (name: string, data: unknown) => { store.set(name, data); return true },
}))
const { loadRules, BUILTIN_RULES, saveRule } = await import('../../src/main/channel-rules-store')

describe('channel-rules-store', () => {
  beforeEach(() => store.clear())
  it('seeds exactly 6 built-in rules with stable ids', () => {
    const rules = loadRules()
    expect(rules).toHaveLength(6)
    expect(rules.map(r => r.id).sort()).toEqual(
      ['attention-pulse', 'ci-self-heal', 'codex-routing', 'memory-broadcast', 'pr-cascade', 'rate-limit-guard'])
    expect(rules.every(r => r.builtin === true)).toBe(true)
  })
  it('every built-in is enabled by default', () => {
    expect(BUILTIN_RULES.every(r => r.enabled)).toBe(true)
  })
  it('saveRule on a built-in persists an override, not a duplicate', () => {
    saveRule({ ...BUILTIN_RULES[0], enabled: false })
    const rules = loadRules()
    expect(rules).toHaveLength(6)
    expect(rules.find(r => r.id === BUILTIN_RULES[0].id)!.enabled).toBe(false)
  })
})
