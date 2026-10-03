import { describe, it, expect } from 'vitest'
import { registryFallbackPricing } from '../../src/main/tokenomics/tk-pricing'

// The registry-derived fallback prices (no live list in a unit test). The
// P4.11 review (P411-1) removed getPricing / getPricingWithSource, which nothing
// in the app called; the path Tokenomics prices a turn on is pinned in
// tests/unit/tokenomics/tk-pricing.test.ts (getAllPricing + parseClaudeUsageLine).
describe('registryFallbackPricing', () => {
  it('the #411 corrections hold: opus-4-6 and haiku-4-5 carry the published rates', () => {
    const fallback = registryFallbackPricing()
    expect(fallback['claude-opus-4-6']).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
    expect(fallback['claude-haiku-4-5']).toEqual({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 })
  })

  it('[host] P4.11: Opus 5.5 and Sonnet 5.5 carry their published rates', () => {
    const fallback = registryFallbackPricing()
    expect(fallback['claude-opus-5-5']).toEqual({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 })
    expect(fallback['claude-sonnet-5-5']).toEqual({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 })
  })
})
