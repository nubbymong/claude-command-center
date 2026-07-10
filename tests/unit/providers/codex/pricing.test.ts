import { describe, it, expect } from 'vitest'
import { computeCodexCostUsd, priceForModel } from '../../../../src/main/providers/codex/pricing'

// Codex usage semantics (verified against real rollouts: total_tokens ==
// input_tokens + output_tokens exactly): cached_input_tokens ⊂ input_tokens.
// Cost = (input - cached)·inputRate + cached·cachedRate + output·outputRate.
describe('codex pricing', () => {
  it('computes cost for gpt-5.5 (1M uncached input + 100k output)', () => {
    const cost = computeCodexCostUsd('gpt-5.5', {
      inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 100_000,
    })
    expect(cost).toBeCloseTo(5 + 3, 2)  // $5 input + $3 output
  })

  it('charges the cached SUBSET of input at the cached rate, not on top of it', () => {
    // Fixture token counts from tests/fixtures/codex/rollout-sample.jsonl:
    //   input_tokens=21805 (of which cached_input_tokens=19328), output_tokens=30
    // Expected: uncached (21805-19328)/1e6*5.00 + cached 19328/1e6*1.25 + 30/1e6*30.00
    //         = 0.012385 + 0.02416 + 0.0009 = 0.037445
    // (The old formula charged all 21805 at full rate PLUS the 19328 again at the
    //  cached rate — double-charging the cached portion.)
    const cost = computeCodexCostUsd('gpt-5.5', {
      inputTokens: 21_805,
      cachedInputTokens: 19_328,
      outputTokens: 30,
    })
    expect(cost).toBeCloseTo(0.037445, 5)
    // Fully-cached input at 1M tokens = the pure cached rate, $1.25
    const cachedOnly = computeCodexCostUsd('gpt-5.5', {
      inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0,
    })
    expect(cachedOnly).toBeCloseTo(1.25, 5)
  })

  it('gpt-5.3-codex rates match expected per openai.com/api/pricing/', () => {
    // input $1.75/M, cached $0.175/M, output $14.00/M — 1M fully-cached input + 1M output
    const cost = computeCodexCostUsd('gpt-5.3-codex', {
      inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 1_000_000,
    })
    expect(cost).toBeCloseTo(0.175 + 14.00, 5)
  })

  it('clamps cached to input (defensive against malformed events)', () => {
    const cost = computeCodexCostUsd('gpt-5.5', {
      inputTokens: 100_000, cachedInputTokens: 500_000, outputTokens: 0,
    })
    expect(cost).toBeCloseTo((100_000 / 1e6) * 1.25, 5) // all input at cached rate, none negative
  })

  it('returns null for unpriced model', () => {
    expect(computeCodexCostUsd('gpt-5.4', {
      inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0,
    })).toBeNull()
  })

  it('priceForModel lookup', () => {
    expect(priceForModel('gpt-5.5')?.inputPer1M).toBe(5.00)
    expect(priceForModel('gpt-5.5')?.cachedInputPer1M).toBe(1.25)
    expect(priceForModel('does-not-exist')).toBeNull()
  })
})
