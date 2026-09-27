import { describe, it, expect } from 'vitest'
import { getAllPricing, normalizeModelForPricing, registryFallbackPricing } from '../../../src/main/tokenomics/tk-pricing'
import { computeCodexCostUsd, priceForModel, codexCachedInputPer1M, codexPricingKeys } from '../../../src/main/providers/codex/pricing'

describe('getAllPricing', () => {
  it('includes claude-fable-5 and opus-4-8 with per-1M rates', () => {
    const map = getAllPricing()
    expect(map['claude-fable-5']).toEqual({ input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 })
    expect(map['claude-opus-4-8']).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
  })
  it('maps a codex model into the TkPricing shape with cacheWrite 0', () => {
    const map = getAllPricing()
    const codexKey = Object.keys(map).find((k) => k.startsWith('gpt-'))
    expect(codexKey).toBeTruthy()
    expect(map[codexKey!].cacheWrite).toBe(0)
  })
})

// Usage track MP11: one rule for a missing cached tier, in the session strip
// and in Tokenomics: it costs the full input rate.
describe('the Codex cached-input rate (MP11)', () => {
  it('a model with no cached tier charges cached input at its input rate; one with a tier, at the tier', () => {
    expect(codexCachedInputPer1M({ inputPer1M: 30, cachedInputPer1M: null })).toBe(30)
    expect(codexCachedInputPer1M({ inputPer1M: 5, cachedInputPer1M: 1.25 })).toBe(1.25)
    const map = getAllPricing()
    const noTier = codexPricingKeys().find((k) => priceForModel(k)!.cachedInputPer1M === null)
    expect(noTier).toBeTruthy()
    expect(map[noTier!].cacheRead).toBe(priceForModel(noTier!)!.inputPer1M)
    const tier = codexPricingKeys().find((k) => priceForModel(k)!.cachedInputPer1M !== null)!
    expect(map[tier].cacheRead).toBe(priceForModel(tier)!.cachedInputPer1M)
  })

  it('Tokenomics prices a Codex turn exactly as the session strip does, for every Codex model', () => {
    const map = getAllPricing()
    // A turn: 1000 input of which 400 cached, 50 output. Tokenomics stores
    // the non-cached input and the cached input apart.
    for (const k of codexPricingKeys()) {
      const p = map[k]
      const tokenomics = (600 * p.input + 400 * p.cacheRead + 50 * p.output) / 1e6
      expect(tokenomics, k).toBeCloseTo(computeCodexCostUsd(k, { inputTokens: 1000, cachedInputTokens: 400, outputTokens: 50 })!, 12)
    }
  })
})

describe('normalizeModelForPricing', () => {
  it('exact match wins', () => {
    expect(normalizeModelForPricing('claude-opus-4-8', Object.keys(registryFallbackPricing()))).toBe('claude-opus-4-8')
  })
  it('longest prefix match for dated models', () => {
    expect(normalizeModelForPricing('claude-opus-4-8-20260101', Object.keys(registryFallbackPricing()))).toBe('claude-opus-4-8')
  })
  it('returns raw model when nothing matches', () => {
    expect(normalizeModelForPricing('mystery-model', Object.keys(registryFallbackPricing()))).toBe('mystery-model')
  })
})
