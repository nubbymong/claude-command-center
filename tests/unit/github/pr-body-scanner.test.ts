import { describe, it, expect } from 'vitest'
import { scanPrBodyRefs } from '../../../src/main/github/session/pr-body-scanner'

describe('scanPrBodyRefs', () => {
  it('returns [] for empty / null / non-string input', () => {
    expect(scanPrBodyRefs('')).toEqual([])
    expect(scanPrBodyRefs(null)).toEqual([])
    expect(scanPrBodyRefs(undefined)).toEqual([])
  })

  it('picks up bare #N', () => {
    expect(scanPrBodyRefs('Fixes #123 and related work')).toEqual([123])
  })

  it('picks up keyword variants', () => {
    expect(
      scanPrBodyRefs('closes #12, fixes #34, resolves #56'),
    ).toEqual([12, 34, 56])
  })

  it('dedupes', () => {
    expect(scanPrBodyRefs('#42 see also #42 and again #42')).toEqual([42])
  })

  it('picks up cross-repo owner/repo#N', () => {
    expect(scanPrBodyRefs('See owner/repo#7 for context')).toEqual([7])
  })

  it('picks up GitHub issue / PR URLs', () => {
    const body = `
      Related: https://github.com/acme/widget/issues/99
      Follow-up: https://github.com/acme/widget/pull/100
    `
    expect(scanPrBodyRefs(body)).toEqual([99, 100])
  })

  it('ignores numbers inside fenced code blocks', () => {
    const body = 'Outside #1\n```\nInside #999\n```\nStill outside #2'
    expect(scanPrBodyRefs(body)).toEqual([1, 2])
  })

  it('ignores numbers inside inline code', () => {
    expect(scanPrBodyRefs('Use `#999` placeholder — see #5')).toEqual([5])
  })

  it('rejects non-numeric anchors like #section and #foo-3', () => {
    // '#foo-3' matches /#(\d+)/ only if a digit immediately follows #.
    // '#section' has no digit, so it's correctly skipped.
    expect(scanPrBodyRefs('See #section and #foo-3')).toEqual([])
  })

  it('caps at MAX_REFS', () => {
    const lots = Array.from({ length: 20 }, (_, i) => `#${i + 1}`).join(' ')
    const out = scanPrBodyRefs(lots)
    expect(out).toHaveLength(10)
    expect(out[0]).toBe(1)
    expect(out[9]).toBe(10)
  })

  it('filters implausibly large ids (>1e9)', () => {
    expect(scanPrBodyRefs('nonsense #9999999999 and real #42')).toEqual([42])
  })
})
