import { describe, it, expect } from 'vitest'
import type { TokenomicsSessionRecord } from '../../../src/shared/types'
import { rollupSessionsByDay, computeAccountSummaryCosts } from '../../../src/renderer/components/TokenomicsPage'

const make = (over: Partial<TokenomicsSessionRecord>): TokenomicsSessionRecord => ({
  sessionId: over.sessionId || 's',
  projectDir: 'p',
  model: 'claude-sonnet',
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  totalCostUsd: 0,
  messageCount: 0,
  firstTimestamp: '2026-06-02T00:00:00Z',
  lastTimestamp: '2026-06-02T00:00:00Z',
  ...over,
})

describe('rollupSessionsByDay', () => {
  it('buckets sessions by UTC date and sums cost / sessions / messages', () => {
    const map = rollupSessionsByDay([
      make({ firstTimestamp: '2026-06-02T01:00:00Z', totalCostUsd: 1, messageCount: 3 }),
      make({ firstTimestamp: '2026-06-02T23:00:00Z', totalCostUsd: 2, messageCount: 4 }),
      make({ firstTimestamp: '2026-06-01T10:00:00Z', totalCostUsd: 5, messageCount: 1 }),
    ])
    expect(map['2026-06-02']).toEqual({ totalCostUsd: 3, sessionCount: 2, messageCount: 7 })
    expect(map['2026-06-01']).toEqual({ totalCostUsd: 5, sessionCount: 1, messageCount: 1 })
  })

  it('returns an empty map for no sessions', () => {
    expect(rollupSessionsByDay([])).toEqual({})
  })
})

describe('computeAccountSummaryCosts', () => {
  const now = new Date('2026-06-02T12:00:00Z')
  const fiveHourStart = '2026-06-02T07:00:00Z'

  it('splits cost across today / week / 5h / all-time windows', () => {
    const sessions = [
      make({ firstTimestamp: '2026-06-02T08:00:00Z', totalCostUsd: 10 }), // today, in 5h
      make({ firstTimestamp: '2026-06-02T02:00:00Z', totalCostUsd: 4 }),  // today, before 5h
      make({ firstTimestamp: '2026-05-30T00:00:00Z', totalCostUsd: 3 }),  // within 7d, not today
      make({ firstTimestamp: '2026-05-20T00:00:00Z', totalCostUsd: 100 }), // older than 7d
    ]
    const r = computeAccountSummaryCosts(sessions, now, fiveHourStart)
    expect(r.todayCost).toBe(14)
    expect(r.weekCost).toBe(17)       // 10 + 4 + 3 (last 7 calendar days incl today)
    expect(r.fiveHourCost).toBe(10)   // only the 08:00 session is >= 07:00
    expect(r.allTimeCost).toBe(117)   // sum of everything
  })

  it('includes the 7-day boundary day (today-6) and excludes the day before', () => {
    const sessions = [
      make({ firstTimestamp: '2026-05-27T12:00:00Z', totalCostUsd: 1 }), // today-6 → included
      make({ firstTimestamp: '2026-05-26T12:00:00Z', totalCostUsd: 9 }), // today-7 → excluded
    ]
    const r = computeAccountSummaryCosts(sessions, now, fiveHourStart)
    expect(r.weekCost).toBe(1)
    expect(r.allTimeCost).toBe(10)
  })

  it('returns zeros for no sessions', () => {
    expect(computeAccountSummaryCosts([], now, fiveHourStart)).toEqual({
      todayCost: 0, weekCost: 0, fiveHourCost: 0, allTimeCost: 0,
    })
  })
})
