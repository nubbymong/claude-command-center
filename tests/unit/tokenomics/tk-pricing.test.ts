import { describe, it, expect } from 'vitest'
import { getAllPricing, normalizeModelForPricing, registryFallbackPricing } from '../../../src/main/tokenomics/tk-pricing'

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
