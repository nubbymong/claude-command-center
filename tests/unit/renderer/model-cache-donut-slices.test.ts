/**
 * Cost-donut slice building (VM finding #2, 2026-06-13).
 *
 * The model/cache breakdown is a COST split: rows that cost $0 — notably
 * "<synthetic>" (CLI-fabricated transcript messages, never priced) — were
 * still landing in the legend because the GROUP BY passes every model id
 * through. Zero-cost rows must be dropped before slicing.
 */
import { describe, it, expect } from 'vitest'
import baselineJson from '../../../resources/model-registry.json'
import type { ModelRegistry } from '../../../src/shared/model-registry'
import { buildCostSlices } from '../../../src/renderer/components/tokenomics/ModelCacheDonut'

const reg = baselineJson as unknown as ModelRegistry

describe('buildCostSlices', () => {
  it('drops zero-cost rows (e.g. <synthetic>) from the cost split', () => {
    const slices = buildCostSlices([
      { model: 'claude-opus-4-8', costUsd: 90, tokens: 1000 },
      { model: '<synthetic>', costUsd: 0, tokens: 0 },
      { model: 'gpt-5.5', costUsd: 10, tokens: 200 },
    ], reg)
    expect(slices.map((s) => s.label)).toEqual(['Opus 4.8', '5.5'])
  })

  it('percentages are computed over the full cost, sorted descending', () => {
    const slices = buildCostSlices([
      { model: 'gpt-5.5', costUsd: 25, tokens: 1 },
      { model: 'claude-opus-4-8', costUsd: 75, tokens: 1 },
    ], reg)
    expect(slices[0]).toMatchObject({ label: 'Opus 4.8', pct: 75 })
    expect(slices[1]).toMatchObject({ label: '5.5', pct: 25 })
  })

  it('collapses the tail beyond five models into Other', () => {
    const slices = buildCostSlices(
      ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((m, i) => ({ model: m, costUsd: 100 - i, tokens: 1 })),
      reg,
    )
    expect(slices).toHaveLength(6)
    expect(slices[5].label).toBe('Other')
  })

  it('returns no slices when every row is zero-cost', () => {
    expect(buildCostSlices([{ model: '<synthetic>', costUsd: 0, tokens: 0 }], reg)).toEqual([])
  })
})
