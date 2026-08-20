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

  it('reduces the weekly window to a single letter', () => {
    expect(shortBucketLabel('Weekly')).toBe('W')
    expect(shortBucketLabel('weekly')).toBe('W')
    expect(shortBucketLabel('Week')).toBe('W')
  })

  it('leaves a model bucket at its full name', () => {
    // The model is the label you actually scan for, and it has to stay legible
    // as new ones appear — truncating buys a few pixels and costs the meaning.
    expect(shortBucketLabel('Fable')).toBe('Fable')
    expect(shortBucketLabel('Sonnet')).toBe('Sonnet')
    expect(shortBucketLabel('Opus')).toBe('Opus')
  })

  it('only ever shortens; it never lengthens or rewrites a label', () => {
    for (const label of ['5h', 'W', 'A', '', 'Fable', 'Some future bucket']) {
      expect(shortBucketLabel(label).length).toBeLessThanOrEqual(label.trim().length || 0)
    }
  })
})
