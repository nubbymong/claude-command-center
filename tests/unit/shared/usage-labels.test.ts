import { describe, it, expect } from 'vitest'
import { windowLabel, shortBucketLabel, bucketPastReset, relAgo } from '../../../src/shared/usage-labels'
import { shortBucketLabel as shortFromBar } from '../../../src/renderer/components/terminal/RateLimitBar'
import { planLabelFor } from '../../../src/shared/usage-types'
import type { UsageBucket } from '../../../src/shared/usage-types'

// Labels a provider-reported window length reads as (Q1.3 of the approved usage
// UX): 300 minutes is "5h", 10080 is "Weekly", anything else reads in hours or
// days. Shared by main (buckets) and the renderer (page, footer, strip).
describe('windowLabel', () => {
  it('reads the two standard windows as 5h and Weekly', () => {
    expect(windowLabel(300)).toBe('5h')
    expect(windowLabel(10080)).toBe('Weekly')
  })

  it('reads whole days in days and other whole hours in hours', () => {
    expect(windowLabel(60)).toBe('1h')
    expect(windowLabel(720)).toBe('12h')
    expect(windowLabel(1440)).toBe('1d')
    expect(windowLabel(4320)).toBe('3d')
    expect(windowLabel(43200)).toBe('30d')
  })

  it('reads a length that is not a whole hour in minutes rather than rounding it', () => {
    expect(windowLabel(90)).toBe('90m')
    expect(windowLabel(45)).toBe('45m')
  })

  it('has no label for a missing or nonsensical length', () => {
    for (const bad of [null, undefined, 0, -300, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(windowLabel(bad as number | null | undefined)).toBeNull()
    }
  })
})

describe('shortBucketLabel (shared)', () => {
  it('gives 5h and W for the two standard windows', () => {
    expect(shortBucketLabel(windowLabel(300)!)).toBe('5h')
    expect(shortBucketLabel(windowLabel(10080)!)).toBe('W')
  })

  it('keeps day windows and model or limit names as they are', () => {
    expect(shortBucketLabel('3d')).toBe('3d')
    expect(shortBucketLabel('Fable')).toBe('Fable')
  })

  it('is the same function the status bar has always used', () => {
    expect(shortFromBar).toBe(shortBucketLabel)
  })
})

const bucket = (resetsAt: string): UsageBucket => ({ key: 'k:', label: '5h', group: 'session', percent: 40, resetsAt, severity: 'normal' })

// D2 (approved as drawn): a window whose reset time has passed shows no figure.
describe('bucketPastReset', () => {
  const now = Date.parse('2026-09-27T12:00:00.000Z')

  it('is true once the reset time has passed, and at the reset instant', () => {
    expect(bucketPastReset(bucket('2026-09-27T11:59:59.000Z'), now)).toBe(true)
    expect(bucketPastReset(bucket('2026-09-27T12:00:00.000Z'), now)).toBe(true)
  })

  it('is false before the reset', () => {
    expect(bucketPastReset(bucket('2026-09-27T12:00:01.000Z'), now)).toBe(false)
  })

  it('is false when the reset time is missing or unreadable (nothing to compare)', () => {
    expect(bucketPastReset(bucket(''), now)).toBe(false)
    expect(bucketPastReset(bucket('not a date'), now)).toBe(false)
  })
})

describe('relAgo', () => {
  const now = Date.parse('2026-09-27T12:00:00.000Z')
  const ago = (ms: number) => relAgo(now - ms, now)

  it('reads under a minute as just now, and a time in the future too', () => {
    expect(ago(0)).toBe('just now')
    expect(ago(59_000)).toBe('just now')
    expect(relAgo(now + 60_000, now)).toBe('just now')
  })

  it('counts minutes under an hour', () => {
    expect(ago(60_000)).toBe('1 min ago')
    expect(ago(119_000)).toBe('1 min ago')
    expect(ago(59 * 60_000)).toBe('59 min ago')
  })

  it('counts hours under a day, never "1440 min ago"', () => {
    expect(ago(60 * 60_000)).toBe('1 h ago')
    expect(ago(5 * 3_600_000)).toBe('5 h ago')
    expect(ago(23 * 3_600_000 + 59 * 60_000)).toBe('23 h ago')
  })

  it('counts days from a day', () => {
    expect(ago(24 * 3_600_000)).toBe('1 day ago')
    expect(ago(3 * 24 * 3_600_000)).toBe('3 days ago')
  })

  it('reads an unreadable time as nothing rather than a wrong age', () => {
    expect(relAgo(Number.NaN, now)).toBe('')
  })
})

// The plan pill on the usage card and the Accounts plan cell (row 29).
describe('planLabelFor', () => {
  it('names the common ChatGPT plans', () => {
    expect(planLabelFor('plus')).toBe('Plus')
    expect(planLabelFor('pro')).toBe('Pro')
    expect(planLabelFor('prolite')).toBe('Pro Lite')
    expect(planLabelFor('team')).toBe('Team')
    expect(planLabelFor('business')).toBe('Business')
    expect(planLabelFor('enterprise')).toBe('Enterprise')
    expect(planLabelFor('edu_plus')).toBe('Edu Plus')
    expect(planLabelFor('free')).toBe('Free')
    expect(planLabelFor('go')).toBe('Go')
  })

  it('has no label for unknown, missing or non-string plans (unknown stays unknown)', () => {
    for (const bad of ['unknown', 'platinum', '', 'PLUS', null, undefined, 3, {}, 'toString', '__proto__']) {
      expect(planLabelFor(bad as unknown)).toBeNull()
    }
  })
})
