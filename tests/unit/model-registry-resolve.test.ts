import { describe, it, expect } from 'vitest'
import baselineJson from '../../resources/model-registry.json'
import { resolveModelInfo, type ModelRegistry } from '../../src/shared/model-registry'

const reg = baselineJson as unknown as ModelRegistry

describe('resolveModelInfo — behaviour-identity snapshots (pin today)', () => {
  // Chart colours must match getModelColor (modelColors.ts:6-13) exactly.
  it.each([
    ['claude-fable-5', 'var(--chart-fable)'],
    ['claude-opus-4-8-20260601', 'var(--chart-opus)'],
    ['Opus 4.7 (1M context)', 'var(--chart-opus)'],
    ['claude-sonnet-4-6', 'var(--chart-sonnet)'],
    ['gpt-5.5', 'var(--chart-codex)'],
    ['o3-codex', 'var(--chart-codex)'],
    ['claude-haiku-4-5', 'var(--chart-other)'],
  ])('chart colour for %s', (model, color) => {
    expect(resolveModelInfo(reg, model).colors.chart).toBe(color)
  })
  it('haiku agentPill override preserved (registry colorOverrides)', () => {
    expect(resolveModelInfo(reg, 'haiku').colors.agentPill).toBe('var(--status-success)')
    expect(resolveModelInfo(reg, 'opus').colors.agentPill).toBe('var(--chart-opus)')
  })
  it('chart short label = family label (getModelShort parity)', () => {
    expect(resolveModelInfo(reg, 'claude-opus-4-8').chartLabel).toBe('opus')
    expect(resolveModelInfo(reg, 'claude-fable-5-20260603').chartLabel).toBe('fable')
  })
  it('alias matches resolve exactly, including opus[1m]', () => {
    // The family aliases always point at the NEWEST model in the family, so
    // this target moves with each new Opus (#385 added claude-opus-5; P4.11
    // claude-opus-5-5 and claude-sonnet-5-5, which Claude Code's opus and
    // sonnet aliases resolve to on the Anthropic API).
    expect(resolveModelInfo(reg, 'opus[1m]').id).toBe('claude-opus-5-5')
    expect(resolveModelInfo(reg, 'opus').id).toBe('claude-opus-5-5')
    expect(resolveModelInfo(reg, 'sonnet').id).toBe('claude-sonnet-5-5')
    expect(resolveModelInfo(reg, 'fable').family).toBe('fable')
  })
  it('exact + longest-prefix id matching picks the specific entry', () => {
    expect(resolveModelInfo(reg, 'claude-opus-4-8-fast').label).toBe('Opus 4.8 Fast')
    expect(resolveModelInfo(reg, 'claude-opus-4-7-20260101').label).toBe('Opus 4.7')
  })
  it('[host] P4.11: Opus 5.5 and Sonnet 5.5 are entries of their own, not Opus 5 and Sonnet 5 by prefix', () => {
    for (const [id, label] of [['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-opus-5', 'Opus 5'], ['claude-sonnet-5', 'Sonnet 5']]) {
      const info = resolveModelInfo(reg, id)
      expect(info.id, id).toBe(id)
      expect(info.label, id).toBe(label)
      expect(info.matchKind, id).toBe('exact')
    }
    // Fallback prices from Anthropic's current model reference (per MTok).
    const price = (id: string) => reg.models.find((m) => m.id === id)?.fallbackPricing
    expect(price('claude-opus-5-5')).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 })
    expect(price('claude-sonnet-5-5')).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 })
  })
  it('substring pattern order is load-bearing: generic opus text lands on the first opus entry', () => {
    // Unchanged invariant (first opus entry wins); the registry is ordered
    // newest-first per family, so that entry is now claude-opus-5-5.
    expect(resolveModelInfo(reg, 'foo-opus-bar').id).toBe('claude-opus-5-5')
    expect(resolveModelInfo(reg, 'foo-opus-bar').matchKind).toBe('pattern')
  })
  it('codex family groups under the "codex" chart label (intended change vs old verbatim labels)', () => {
    expect(resolveModelInfo(reg, 'gpt-5.5').chartLabel).toBe('codex')
    expect(resolveModelInfo(reg, 'o3-codex').chartLabel).toBe('codex')
  })
})

describe('resolveModelInfo — graceful defaults for unknowns', () => {
  it('unknown model: known=false, verbatim label, deterministic hashed colour NOT a chart token', () => {
    const a = resolveModelInfo(reg, 'claude-thinking-7')
    const b = resolveModelInfo(reg, 'claude-thinking-7')
    expect(a.known).toBe(false)
    expect(a.label).toBe('claude-thinking-7')
    expect(a.colors.chart).toBe(b.colors.chart)         // deterministic
    expect(a.colors.chart).toMatch(/^#/)                 // hex from the unknown palette, never var(--chart-*)
  })
  it('unknown model: efforts null (assume-all-valid)', () => {
    expect(resolveModelInfo(reg, 'claude-thinking-7').efforts).toBeNull()
  })
  it('empty input resolves without throwing', () => {
    expect(resolveModelInfo(reg, '').known).toBe(false)
  })
})
