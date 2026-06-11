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
  it('haiku agentPill override preserved (AgentLibrary.tsx:12)', () => {
    expect(resolveModelInfo(reg, 'haiku').colors.agentPill).toBe('var(--status-success)')
    expect(resolveModelInfo(reg, 'opus').colors.agentPill).toBe('var(--chart-opus)')
  })
  it('chart short label = family label (getModelShort parity)', () => {
    expect(resolveModelInfo(reg, 'claude-opus-4-8').chartLabel).toBe('opus')
    expect(resolveModelInfo(reg, 'claude-fable-5-20260603').chartLabel).toBe('fable')
  })
  it('alias matches resolve exactly, including opus[1m]', () => {
    expect(resolveModelInfo(reg, 'opus[1m]').id).toBe('claude-opus-4-8')
    expect(resolveModelInfo(reg, 'fable').family).toBe('fable')
  })
  it('exact + longest-prefix id matching picks the specific entry', () => {
    expect(resolveModelInfo(reg, 'claude-opus-4-8-fast').label).toBe('Opus 4.8 Fast')
    expect(resolveModelInfo(reg, 'claude-opus-4-7-20260101').label).toBe('Opus 4.7')
  })
  it('substring pattern order is load-bearing: generic opus text lands on the first opus entry', () => {
    expect(resolveModelInfo(reg, 'foo-opus-bar').id).toBe('claude-opus-4-8')
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
