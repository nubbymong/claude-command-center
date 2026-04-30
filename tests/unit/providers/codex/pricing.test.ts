import { describe, it, expect } from 'vitest'
import { computeCodexCostUsd, priceForModel } from '../../../../src/main/providers/codex/pricing'

describe('codex pricing', () => {
  it('computes cost for gpt-5.5 (1M input + 100k output)', () => {
    const cost = computeCodexCostUsd('gpt-5.5', {
      inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 100_000, reasoningOutputTokens: 0,
    })
    expect(cost).toBeCloseTo(5 + 3, 2)  // $5 input + $3 output
  })

  it('returns null for unpriced model', () => {
    expect(computeCodexCostUsd('gpt-5.4', {
      inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
    })).toBeNull()
  })

  it('priceForModel lookup', () => {
    expect(priceForModel('gpt-5.5')?.inputPer1M).toBe(5.00)
    expect(priceForModel('does-not-exist')).toBeNull()
  })
})
