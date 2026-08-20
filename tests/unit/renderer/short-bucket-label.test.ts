/**
 * Short bucket codes for the multi-account footer.
 *
 * The footer renders one row per account and every bucket on each, so the words
 * ("5h:", "Weekly:", "Fable:") and their percentages repeat across the whole
 * strip and crowd out the coloured bars. Compact mode shortens the label and
 * moves the figure into the tooltip.
 *
 * Bucket labels come from the API and are OPEN-ENDED — 5h, Weekly, then one per
 * model as they appear — so this has to be a rule, not a lookup table of the
 * three that exist today.
 */
import { describe, it, expect } from 'vitest'
import { shortBucketLabel } from '../../../src/renderer/components/terminal/RateLimitBar'

describe('shortBucketLabel', () => {
  it('leaves an hour window as-is', () => {
    expect(shortBucketLabel('5h')).toBe('5h')
    expect(shortBucketLabel('1h')).toBe('1h')
    expect(shortBucketLabel('24h')).toBe('24h')
  })

  it('normalises hour-window spacing and case', () => {
    expect(shortBucketLabel('5 H')).toBe('5h')
    expect(shortBucketLabel(' 5h ')).toBe('5h')
  })

  it('abbreviates the weekly window', () => {
    expect(shortBucketLabel('Weekly')).toBe('wk')
    expect(shortBucketLabel('weekly')).toBe('wk')
    expect(shortBucketLabel('Week')).toBe('wk')
  })

  it('keeps three characters of a model bucket, which stays recognisable', () => {
    // Two letters would give "Fa"/"So"/"Ha" — ambiguous between Sonnet and
    // something else the API adds later. Three is the floor.
    expect(shortBucketLabel('Fable')).toBe('Fab')
    expect(shortBucketLabel('Sonnet')).toBe('Son')
    expect(shortBucketLabel('Opus')).toBe('Opu')
  })

  it('never lengthens a label that is already short', () => {
    for (const label of ['5h', 'wk', 'A', '']) {
      expect(shortBucketLabel(label).length).toBeLessThanOrEqual(Math.max(label.trim().length, 2))
    }
  })

  it('never returns more than three characters', () => {
    for (const label of ['Weekly', 'Fable', 'Sonnet', 'A very long future bucket name']) {
      expect(shortBucketLabel(label).length).toBeLessThanOrEqual(3)
    }
  })
})
