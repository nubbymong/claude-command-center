import { describe, it, expect } from 'vitest'
import { computeCodexCostUsd, priceForModel } from '../../../../src/main/providers/codex/pricing'

describe('codex pricing', () => {
  it('computes cost for gpt-5.5 (1M input + 100k output)', () => {
    const cost = computeCodexCostUsd('gpt-5.5', {
      inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 100_000, reasoningOutputTokens: 0,
    })
    expect(cost).toBeCloseTo(5 + 3, 2)  // $5 input + $3 output
  })

  it('gpt-5.5 cached-input rate is $1.25/M (canonical per openai.com/api/pricing/, verified 2026-05-04)', () => {
    // Fixture token counts from tests/fixtures/codex/rollout-sample.jsonl:
    //   input_tokens=21805, cached_input_tokens=19328, output_tokens=30, reasoning_output_tokens=0
    // Expected: (21805/1e6)*5.00 + (19328/1e6)*1.25 + (30/1e6)*30.00
    //         = 0.109025 + 0.02416 + 0.0009 = 0.134085
    const cost = computeCodexCostUsd('gpt-5.5', {
      inputTokens: 21_805,
      cachedInputTokens: 19_328,
      outputTokens: 30,
      reasoningOutputTokens: 0,
    })
    expect(cost).toBeCloseTo(0.134085, 5)
    // Sanity check: pure cached-input rate at 1M tokens = $1.25
    const cachedOnly = computeCodexCostUsd('gpt-5.5', {
      inputTokens: 0, cachedInputTokens: 1_000_000, outputTokens: 0, reasoningOutputTokens: 0,
    })
    expect(cachedOnly).toBeCloseTo(1.25, 5)
  })

  it('gpt-5.3-codex rates match expected per openai.com/api/pricing/', () => {
    // input $1.75/M, cached $0.175/M, output $14.00/M
    const cost = computeCodexCostUsd('gpt-5.3-codex', {
      inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 1_000_000, reasoningOutputTokens: 0,
    })
    expect(cost).toBeCloseTo(1.75 + 0.175 + 14.00, 5)
  })

  it('returns null for unpriced model', () => {
    expect(computeCodexCostUsd('gpt-5.4', {
      inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
    })).toBeNull()
  })

  it('priceForModel lookup', () => {
    expect(priceForModel('gpt-5.5')?.inputPer1M).toBe(5.00)
    expect(priceForModel('gpt-5.5')?.cachedInputPer1M).toBe(1.25)
    expect(priceForModel('does-not-exist')).toBeNull()
  })
})
