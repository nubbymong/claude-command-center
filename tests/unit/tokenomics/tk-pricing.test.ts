import { describe, it, expect } from 'vitest'
import { getAllPricing, normalizeModelForPricing, registryFallbackPricing } from '../../../src/main/tokenomics/tk-pricing'
import { computeCodexCostUsd, priceForModel, codexCachedInputPer1M, codexPricingKeys } from '../../../src/main/providers/codex/pricing'
import { parseClaudeUsageLine } from '../../../src/main/tokenomics/tk-parse'

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

// [host] P4.11 (review P411-1): the path Tokenomics prices a Claude turn on.
// The worker gets getAllPricing()'s keys and maps each turn's model with
// parseClaudeUsageLine (toPriceModel: its own key, else the longest key it
// starts with). Offline (no live list in a unit test) Opus 5.5 and Sonnet 5.5
// are priced as themselves, dated or not, and an older dated id keeps its own
// version's price beside the cheaper 5.5 entries.
describe('Tokenomics prices Opus 5.5 and Sonnet 5.5 as themselves', () => {
  const map = getAllPricing()
  const keys = Object.keys(map)
  const priced = (model: string) => {
    const line = JSON.stringify({ type: 'assistant', timestamp: '2026-10-03T10:00:00Z', sessionId: 's', requestId: 'r',
      message: { id: 'm', model, usage: { input_tokens: 1, output_tokens: 1 } } })
    const key = parseClaudeUsageLine(line, keys)!.priceModel
    return { key, price: map[key] }
  }
  it('[host] exact and dated 5.5 ids take the 5.5 entries; a dated Opus 4.5 and Sonnet 4.5 keep theirs', () => {
    const opus55 = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }
    const sonnet55 = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }
    expect(priced('claude-opus-5-5')).toEqual({ key: 'claude-opus-5-5', price: opus55 })
    expect(priced('claude-opus-5-5-20261001')).toEqual({ key: 'claude-opus-5-5', price: opus55 })
    expect(priced('claude-sonnet-5-5')).toEqual({ key: 'claude-sonnet-5-5', price: sonnet55 })
    expect(priced('claude-sonnet-5-5-20261001')).toEqual({ key: 'claude-sonnet-5-5', price: sonnet55 })
    expect(priced('claude-opus-4-5-20251101')).toEqual({ key: 'claude-opus-4-5', price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } })
    expect(priced('claude-sonnet-4-5-20250929')).toEqual({ key: 'claude-sonnet-4-5', price: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } })
    expect(priced('claude-opus-5')).toEqual({ key: 'claude-opus-5', price: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } })
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
