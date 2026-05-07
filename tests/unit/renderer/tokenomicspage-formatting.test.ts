// @vitest-environment jsdom
/**
 * Regression tests for TokenomicsPage formatting helpers. Targets the
 * Copilot-flagged bug (2026-05-07) where getModelShort collapsed every Claude
 * variant to "claude" because it stripped non-alpha then sliced the first 6
 * characters of "claudesonnet" / "claudeopus" / "claudehaiku".
 *
 * The fix returns the family name directly via regex match.
 */
import { describe, it, expect, vi } from 'vitest'

// TokenomicsPage imports useTokenomicsStore at module load -- mock it so the
// component file can be imported in a unit test without standing up Zustand.
vi.mock('../../../src/renderer/stores/tokenomicsStore', () => ({
  useTokenomicsStore: () => ({
    sessions: {},
    dailyAggregates: {},
    seedComplete: false,
    extraSpend: undefined,
    rateLimits: undefined,
  }),
}))

const { getModelShort } = await import('../../../src/renderer/components/TokenomicsPage')

describe('getModelShort', () => {
  it('returns the Claude family name for sonnet variants', () => {
    expect(getModelShort('claude-sonnet-4-6')).toBe('sonnet')
    expect(getModelShort('claude-sonnet-3-5')).toBe('sonnet')
    expect(getModelShort('claude-3-5-sonnet-20241022')).toBe('sonnet')
  })

  it('returns the Claude family name for opus variants', () => {
    expect(getModelShort('claude-opus-4-6')).toBe('opus')
    expect(getModelShort('claude-opus-4-5')).toBe('opus')
  })

  it('returns the Claude family name for haiku variants', () => {
    expect(getModelShort('claude-haiku-4-5')).toBe('haiku')
    expect(getModelShort('claude-3-haiku-20240307')).toBe('haiku')
  })

  it('strips the gpt- prefix for Codex/GPT models', () => {
    expect(getModelShort('gpt-5.5')).toBe('5.5')
    expect(getModelShort('gpt-5.4-mini')).toBe('5.4-mini')
    expect(getModelShort('gpt-5.3-codex')).toBe('5.3-codex')
  })

  it('returns unknown model strings unchanged', () => {
    expect(getModelShort('mistral-large')).toBe('mistral-large')
    expect(getModelShort('')).toBe('')
  })

  it('case-insensitively matches Claude family names', () => {
    expect(getModelShort('Claude-Sonnet-4-6')).toBe('sonnet')
    expect(getModelShort('CLAUDE-OPUS-4-6')).toBe('opus')
  })
})
