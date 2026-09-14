import { describe, it, expect } from 'vitest'
import { parseCrossAccountNarrative } from '../../src/main/insights-cross-account'

// #191: the synthesis reply is model output, so parsing has to survive the
// envelope, prose padding, and junk — and must return null (not a hollow object)
// when there is no narrative, because null is what triggers the deterministic
// numbers-only fallback.

const NARRATIVE = {
  summary: { improvements: ['A1 shipped 3x the sessions'], regressions: [], suggestions: ['Move CI work to A2'] },
  accounts: [
    { key: 'A1', highlights: ['Carries the volume'] },
    { key: 'A2', highlights: ['Cleaner outcomes'] }
  ],
  crossAccount: { observations: ['A1 is 3x A2 by volume'], recommendations: ['Consolidate on A1'] }
}

describe('parseCrossAccountNarrative', () => {
  it('parses a direct JSON object', () => {
    const out = parseCrossAccountNarrative(JSON.stringify(NARRATIVE))
    expect(out?.accounts.map((a) => a.key)).toEqual(['A1', 'A2'])
    expect(out?.summary?.improvements).toEqual(['A1 shipped 3x the sessions'])
    expect(out?.crossAccount?.recommendations).toEqual(['Consolidate on A1'])
  })

  it('unwraps the {result:"<json>"} envelope from claude -p --output-format json', () => {
    const out = parseCrossAccountNarrative(JSON.stringify({ result: JSON.stringify(NARRATIVE) }))
    expect(out?.accounts).toHaveLength(2)
  })

  it('recovers JSON wrapped in prose inside the envelope', () => {
    const wrapped = `Here you go:\n\n${JSON.stringify(NARRATIVE)}\n\nHope that helps.`
    const out = parseCrossAccountNarrative(JSON.stringify({ result: wrapped }))
    expect(out?.accounts).toHaveLength(2)
  })

  it('recovers JSON wrapped in prose with no envelope at all', () => {
    const out = parseCrossAccountNarrative(`Analysis:\n${JSON.stringify(NARRATIVE)}`)
    expect(out?.crossAccount?.observations).toEqual(['A1 is 3x A2 by volume'])
  })

  it('drops empty arrays instead of reporting empty sections', () => {
    const out = parseCrossAccountNarrative(JSON.stringify(NARRATIVE))
    // regressions was [] in the input.
    expect(out?.summary?.regressions).toBeUndefined()
  })

  it('drops non-string bullets and keys that are not strings', () => {
    const out = parseCrossAccountNarrative(
      JSON.stringify({
        accounts: [{ key: 'A1', highlights: ['real', 42, null, ''] }, { key: 7 }, {}],
        crossAccount: { observations: ['ok'] }
      })
    )
    expect(out?.accounts).toEqual([{ key: 'A1', highlights: ['real'] }])
  })

  it('caps bullet count and bullet length', () => {
    const out = parseCrossAccountNarrative(
      JSON.stringify({
        accounts: [{ key: 'A1' }],
        crossAccount: { observations: Array.from({ length: 20 }, () => 'x'.repeat(900)) }
      })
    )
    const observations = out!.crossAccount!.observations!
    expect(observations.length).toBeLessThanOrEqual(6)
    expect(observations[0].length).toBeLessThanOrEqual(400)
  })

  it('returns null for junk, empty output, and a JSON array', () => {
    expect(parseCrossAccountNarrative('')).toBeNull()
    expect(parseCrossAccountNarrative('not json at all')).toBeNull()
    expect(parseCrossAccountNarrative('[1,2,3]')).toBeNull()
  })

  it('returns null when keys come back but no prose does — that is a failed pass', () => {
    expect(
      parseCrossAccountNarrative(JSON.stringify({ accounts: [{ key: 'A1' }, { key: 'A2' }] }))
    ).toBeNull()
  })

  it('accepts a reply whose only prose is per-account highlights', () => {
    const out = parseCrossAccountNarrative(
      JSON.stringify({ accounts: [{ key: 'A1', highlights: ['busy'] }, { key: 'A2' }] })
    )
    expect(out?.accounts).toHaveLength(2)
    expect(out?.summary).toBeUndefined()
  })
})
