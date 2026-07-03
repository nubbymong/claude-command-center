import { describe, it, expect } from 'vitest'
import { parseUsage } from '../../src/main/usage/usage-buckets'

// The real payload shape captured from a live account (2026-07-03): limits[]
// with session + weekly-all + a per-model weekly, plus a disabled extra_usage.
const REAL = {
  five_hour: { utilization: 31, resets_at: '2026-06-30T06:09:59Z' },
  seven_day: { utilization: 34, resets_at: '2026-07-05T04:59:59Z' },
  seven_day_sonnet: { utilization: 7, resets_at: '2026-07-05T04:59:59Z' },
  tangelo: null, iguana_necktie: null, amber_ladder: null,
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: 29828, currency: 'GBP', decimal_places: 2, disabled_reason: 'out_of_credits' },
  limits: [
    { kind: 'session', group: 'session', percent: 31, severity: 'normal', resets_at: '2026-06-30T06:09:59Z', scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 34, severity: 'normal', resets_at: '2026-07-05T04:59:59Z', scope: null, is_active: true },
    { kind: 'weekly_scoped', group: 'weekly', percent: 100, severity: 'critical', resets_at: '2026-07-05T04:59:59Z', scope: { model: { display_name: 'Fable' } }, is_active: false },
  ],
  spend: { used: { amount_minor: 29828, currency: 'GBP', exponent: 2 }, limit: null, enabled: false, disabled_reason: 'out_of_credits' },
}

describe('parseUsage — dynamic bucket discovery from limits[]', () => {
  it('discovers 5h, Weekly, and the per-model Fable bucket, in order', () => {
    const { buckets } = parseUsage(REAL)
    expect(buckets.map((b) => b.label)).toEqual(['5h', 'Weekly', 'Fable'])
    expect(buckets.map((b) => b.percent)).toEqual([31, 34, 100])
    expect(buckets.map((b) => b.group)).toEqual(['session', 'weekly', 'weekly'])
  })

  it('carries severity + reset per bucket', () => {
    const fable = parseUsage(REAL).buckets.find((b) => b.label === 'Fable')!
    expect(fable.severity).toBe('critical')
    expect(fable.resetsAt).toBe('2026-07-05T04:59:59Z')
  })

  it('a NEW per-model weekly appears automatically (no code change)', () => {
    const withOpus = {
      limits: [
        { kind: 'session', group: 'session', percent: 10, severity: 'normal', resets_at: '', scope: null },
        { kind: 'weekly_scoped', group: 'weekly', percent: 55, severity: 'normal', resets_at: '', scope: { model: { display_name: 'Opus' } } },
      ],
    }
    expect(parseUsage(withOpus).buckets.map((b) => b.label)).toEqual(['5h', 'Opus'])
  })

  it('ignores non session/weekly groups and codenamed null placeholders', () => {
    const { buckets } = parseUsage(REAL)
    // tangelo/iguana_necktie/amber_ladder never become buckets
    expect(buckets).toHaveLength(3)
    expect(buckets.some((b) => b.label.includes('tangelo'))).toBe(false)
  })

  it('drops entries with a non-numeric percent', () => {
    const bad = { limits: [{ kind: 'session', group: 'session', percent: null }, { kind: 'weekly_all', group: 'weekly', percent: 20 }] }
    expect(parseUsage(bad).buckets.map((b) => b.label)).toEqual(['Weekly'])
  })
})

describe('parseUsage — legacy fallback (no limits[])', () => {
  it('builds 5h + Weekly from five_hour/seven_day when limits[] is absent', () => {
    const legacy = { five_hour: { utilization: 20, resets_at: 'a' }, seven_day: { utilization: 40, resets_at: 'b' } }
    const { buckets } = parseUsage(legacy)
    expect(buckets.map((b) => b.label)).toEqual(['5h', 'Weekly'])
    expect(buckets.map((b) => b.percent)).toEqual([20, 40])
  })
})

describe('parseUsage — credits only when enabled', () => {
  it('omits credits when extra_usage/spend are disabled (out of credits)', () => {
    expect(parseUsage(REAL).credits).toBeUndefined()
  })

  it('reports credits from spend when enabled', () => {
    const withSpend = {
      limits: [],
      spend: { used: { amount_minor: 500, currency: 'GBP', exponent: 2 }, limit: 2000, balance: 1500, enabled: true },
    }
    const c = parseUsage(withSpend).credits!
    expect(c.currency).toBe('GBP')
    expect(c.used).toBe(5)
    expect(c.limit).toBe(20)
    expect(c.remaining).toBe(15)
  })

  it('falls back to extra_usage when enabled and spend absent', () => {
    const withExtra = {
      limits: [],
      extra_usage: { is_enabled: true, monthly_limit: 3000, used_credits: 1000, currency: 'USD', decimal_places: 2 },
    }
    const c = parseUsage(withExtra).credits!
    expect(c.currency).toBe('USD')
    expect(c.used).toBe(10)
    expect(c.limit).toBe(30)
    expect(c.remaining).toBe(20)
  })
})

describe('parseUsage — defensive', () => {
  it('empty / malformed payloads yield no buckets, never throw', () => {
    expect(parseUsage(null).buckets).toEqual([])
    expect(parseUsage(undefined).buckets).toEqual([])
    expect(parseUsage('nope').buckets).toEqual([])
    expect(parseUsage({}).buckets).toEqual([])
  })
})
