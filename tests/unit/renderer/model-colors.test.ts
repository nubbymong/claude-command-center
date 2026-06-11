import { describe, it, expect } from 'vitest'
import { getModelColor } from '../../../src/renderer/components/tokenomics/modelColors'

describe('getModelColor (chart colour rule, spec section 5)', () => {
  it('Opus -> copper chart token', () => {
    expect(getModelColor('claude-opus-4-7')).toBe('var(--chart-opus)')
  })
  it('Sonnet -> teal chart token', () => {
    expect(getModelColor('claude-sonnet-4-6')).toBe('var(--chart-sonnet)')
  })
  it('Codex/gpt -> blue chart token', () => {
    expect(getModelColor('gpt-5.5')).toBe('var(--chart-codex)')
    expect(getModelColor('gpt-5.3-codex')).toBe('var(--chart-codex)')
  })
  it('unknown -> deterministic hashed hex (not chart-other; registry-backed spec §4)', () => {
    expect(getModelColor('mystery-model')).toMatch(/^#/)
  })
})
