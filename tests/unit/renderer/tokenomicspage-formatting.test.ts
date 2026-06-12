/**
 * Regression tests for the tokenomics model-label helper. Targets the
 * Copilot-flagged bug (2026-05-07) where getModelShort collapsed every Claude
 * variant to "claude" because it stripped non-alpha then sliced the first 6
 * characters of "claudesonnet" / "claudeopus" / "claudehaiku".
 *
 * The fix returns the family name directly via regex match.
 */
import { describe, it, expect } from 'vitest'
import { getModelShort } from '../../../src/renderer/components/tokenomics/modelColors'

describe('getModelShort', () => {
  // Versioned labels for version-faithful matches (exact id / prefix);
  // family fallback ONLY for fuzzy pattern hits (user report 2026-06-12:
  // several per-version categories all rendered as lowercase "opus").
  it('returns the VERSIONED label for exact registry ids', () => {
    expect(getModelShort('claude-sonnet-4-6')).toBe('Sonnet 4.6')
    expect(getModelShort('claude-opus-4-6')).toBe('Opus 4.6')
    expect(getModelShort('claude-haiku-4-5')).toBe('Haiku 4.5')
  })

  it('returns the versioned label for date-suffixed ids (prefix match)', () => {
    expect(getModelShort('claude-opus-4-7-20260101')).toBe('Opus 4.7')
  })

  it('falls back to the family name for fuzzy pattern matches (never claims a wrong version)', () => {
    expect(getModelShort('claude-sonnet-3-5')).toBe('sonnet')
    expect(getModelShort('claude-3-5-sonnet-20241022')).toBe('sonnet')
    expect(getModelShort('claude-opus-4-5')).toBe('opus')
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

  it('case-insensitive ids still resolve (pattern tier) without claiming a version', () => {
    expect(getModelShort('CLAUDE-OPUS-4-6')).toBe('opus')
  })
})
