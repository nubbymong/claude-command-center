import { describe, it, expect } from 'vitest'
import {
  assembleCrossAccount,
  buildComparisonRows,
  collectUniqueMetrics,
  topLists,
  withNarrative,
  type CrossAccountMember
} from '../../src/main/insights-cross-account'
import type { InsightsData } from '../../src/shared/types'

// #191 follow-up: merging two accounts' metrics on `category + metricKey` ALONE
// asserts an equivalence the data does not support. These tests pin the fix using
// the exact values that exposed it in real archives.
//
// The real case: both accounts report `Outcomes.successRate`.
//   aai-se01 -> 0.4231, label "Fully Achieved Rate"
//   severson -> 0.787,  label "Mostly or Fully Achieved Rate"
// severson's own fully-achieved rate is 0.128 -- the WORSE of the two -- but its
// key (`fullyAchievedRate`) has no counterpart, so it was dropped. The table
// therefore rendered severson green at 78.7% "Fully Achieved Rate": the exact
// inverse of the truth, in colour, presented as a measurement.

function member(key: string, label: string, kpis: InsightsData): CrossAccountMember {
  return { key, runId: `run-${key}`, profileId: `p-${key}`, accountEmail: `${key}@example.com`, label, kpis }
}

const SAME_WINDOW = { start: '2026-07-01', end: '2026-07-31' }

describe('label disagreement (the real successRate case)', () => {
  const seA = member('A1', 'aai-se01', {
    period: SAME_WINDOW,
    kpis: {
      Outcomes: {
        successRate: { value: 0.4231, label: 'Fully Achieved Rate', format: 'percent', goodDirection: 'up' }
      }
    }
  })
  const seB = member('A2', 'severson', {
    period: SAME_WINDOW,
    kpis: {
      Outcomes: {
        successRate: {
          value: 0.787,
          label: 'Mostly or Fully Achieved Rate',
          format: 'percent',
          goodDirection: 'up'
        },
        fullyAchievedRate: { value: 0.128, label: 'Fully Achieved Rate', format: 'percent', goodDirection: 'up' }
      }
    }
  })

  it('keeps the row but refuses to assert the metrics are the same measure', () => {
    const [row] = buildComparisonRows([seA, seB])
    expect(row.metricKey).toBe('successRate')
    expect(row.values.map((v) => v.value)).toEqual([0.4231, 0.787])
    // Marked, and displayed by raw key so neither wording is presented as shared.
    expect(row.labelVariants).toEqual(['Fully Achieved Rate', 'Mostly or Fully Achieved Rate'])
    expect(row.label).toBe('successRate')
  })

  it('carries no total on a conflicted row', () => {
    const rows = buildComparisonRows([
      member('A1', 'a', { period: SAME_WINDOW, kpis: { V: { m: { value: 1, label: 'Alpha', format: 'number' } } } }),
      member('A2', 'b', { period: SAME_WINDOW, kpis: { V: { m: { value: 2, label: 'Beta', format: 'number' } } } })
    ])
    expect(rows[0].labelVariants).toEqual(['Alpha', 'Beta'])
    expect(rows[0].total).toBeUndefined()
  })

  it('does not treat pure wording noise as a conflict', () => {
    const rows = buildComparisonRows([
      member('A1', 'a', {
        period: SAME_WINDOW,
        kpis: { V: { m: { value: 1, label: 'Sessions Analyzed', format: 'number' } } }
      }),
      member('A2', 'b', {
        period: SAME_WINDOW,
        kpis: { V: { m: { value: 2, label: 'sessions analyzed!', format: 'number' } } }
      })
    ])
    expect(rows[0].labelVariants).toBeUndefined()
    expect(rows[0].label).toBe('Sessions Analyzed')
    expect(rows[0].total).toBe(3)
  })

  it('keeps the dropped counterpart visible as an account-unique metric', () => {
    const unique = collectUniqueMetrics([seA, seB])
    const dropped = unique.find((u) => u.metricKey === 'fullyAchievedRate')
    expect(dropped).toBeDefined()
    expect(dropped!.key).toBe('A2')
    expect(dropped!.value).toBe(0.128)
  })
})

describe('format and direction disagreement', () => {
  it('clears the format and marks it when accounts disagree on units', () => {
    const rows = buildComparisonRows([
      member('A1', 'a', {
        period: SAME_WINDOW,
        kpis: { P: { t: { value: 5000, label: 'Response Time', format: 'duration' } } }
      }),
      member('A2', 'b', {
        period: SAME_WINDOW,
        kpis: { P: { t: { value: 5, label: 'Response Time', format: 'number' } } }
      })
    ])
    expect(rows[0].formatVariants?.sort()).toEqual(['duration', 'number'])
    expect(rows[0].format).toBeUndefined()
    expect(rows[0].total).toBeUndefined()
  })

  it('clears goodDirection when accounts disagree, so colour cannot depend on member order', () => {
    const a = member('A1', 'a', {
      period: SAME_WINDOW,
      kpis: { Volume: { messages: { value: 360, label: 'Total Messages', format: 'number', goodDirection: 'up' } } }
    })
    const b = member('A2', 'b', {
      period: SAME_WINDOW,
      kpis: {
        Volume: { messages: { value: 2281, label: 'Total Messages', format: 'number', goodDirection: 'neutral' } }
      }
    })
    const forward = buildComparisonRows([a, b])[0]
    const reversed = buildComparisonRows([b, a])[0]
    expect(forward.directionConflict).toBe(true)
    expect(forward.goodDirection).toBeUndefined()
    // Order-independence is the actual property under test.
    expect(reversed.goodDirection).toBe(forward.goodDirection)
    expect(reversed.directionConflict).toBe(true)
  })

  it('leaves an agreed direction intact', () => {
    const rows = buildComparisonRows([
      member('A1', 'a', {
        period: SAME_WINDOW,
        kpis: { F: { e: { value: 9, label: 'Errors', format: 'number', goodDirection: 'down' } } }
      }),
      member('A2', 'b', {
        period: SAME_WINDOW,
        kpis: { F: { e: { value: 4, label: 'Errors', format: 'number', goodDirection: 'down' } } }
      })
    ])
    expect(rows[0].goodDirection).toBe('down')
    expect(rows[0].directionConflict).toBeUndefined()
    expect(rows[0].total).toBe(13)
  })
})

describe('reporting windows', () => {
  const short = member('A1', 'short', {
    period: { start: '2026-07-09', end: '2026-07-31', days: 10 },
    kpis: { Volume: { sessions: { value: 26, label: 'Sessions', format: 'number' } } }
  })
  const long = member('A2', 'long', {
    period: { start: '2026-06-27', end: '2026-07-31', days: 27 },
    kpis: { Volume: { sessions: { value: 165, label: 'Sessions', format: 'number' } } }
  })

  it('computes the calendar span from the dates, not from the model s active-day count', () => {
    const data = assembleCrossAccount([short, long], null)
    // Real archived values: a 23-day window reported as days:10, a 35-day as days:27.
    expect(data.accounts[0].spanDays).toBe(23)
    expect(data.accounts[0].period?.days).toBe(10)
    expect(data.accounts[1].spanDays).toBe(35)
    expect(data.accounts[1].period?.days).toBe(27)
  })

  it('suppresses every total when the windows differ materially', () => {
    const data = assembleCrossAccount([short, long], null)
    expect(data.windowsComparable).toBe(false)
    expect(data.comparison.every((r) => r.total === undefined)).toBe(true)
  })

  it('allows totals when the windows are close enough', () => {
    const a = member('A1', 'a', {
      period: { start: '2026-07-01', end: '2026-07-31' },
      kpis: { Volume: { sessions: { value: 10, label: 'Sessions', format: 'number' } } }
    })
    const b = member('A2', 'b', {
      period: { start: '2026-07-05', end: '2026-07-31' },
      kpis: { Volume: { sessions: { value: 20, label: 'Sessions', format: 'number' } } }
    })
    const data = assembleCrossAccount([a, b], null)
    expect(data.windowsComparable).toBe(true)
    expect(data.comparison[0].total).toBe(30)
  })

  it('treats an unknown window as not comparable rather than assuming it matches', () => {
    const a = member('A1', 'a', { kpis: { V: { m: { value: 1, label: 'M', format: 'number' } } } })
    const b = member('A2', 'b', {
      period: { start: '2026-07-01', end: '2026-07-31' },
      kpis: { V: { m: { value: 2, label: 'M', format: 'number' } } }
    })
    const data = assembleCrossAccount([a, b], null)
    expect(data.accounts[0].spanDays).toBeUndefined()
    expect(data.windowsComparable).toBe(false)
    expect(data.comparison[0].total).toBeUndefined()
  })
})

describe('ranked lists', () => {
  it('keeps the top 3 of each list instead of discarding lists entirely', () => {
    const lists = topLists({
      lists: {
        'Top Tools': [
          { name: 'Bash', count: 10328 },
          { name: 'Edit', count: 2765 },
          { name: 'Read', count: 1736 },
          { name: 'Grep', count: 900 }
        ],
        'Top Languages': [{ name: 'Markdown', count: 1692 }]
      }
    })
    expect(lists?.['Top Tools']).toEqual([
      { name: 'Bash', count: 10328 },
      { name: 'Edit', count: 2765 },
      { name: 'Read', count: 1736 }
    ])
    expect(lists?.['Top Languages']).toHaveLength(1)
  })

  it('drops malformed entries and returns undefined when nothing survives', () => {
    expect(topLists({ lists: { Bad: [{ name: 'x' }, { count: 2 }, null] as never } })).toBeUndefined()
    expect(topLists({})).toBeUndefined()
  })

  it('reaches the assembled roll-up', () => {
    const a = member('A1', 'a', {
      period: SAME_WINDOW,
      kpis: { V: { m: { value: 1, label: 'M', format: 'number' } } },
      lists: { 'Top Tools': [{ name: 'Bash', count: 5 }] }
    })
    const b = member('A2', 'b', {
      period: SAME_WINDOW,
      kpis: { V: { m: { value: 2, label: 'M', format: 'number' } } }
    })
    const data = assembleCrossAccount([a, b], null)
    expect(data.accounts[0].topLists?.['Top Tools']).toEqual([{ name: 'Bash', count: 5 }])
    expect(data.accounts[1].topLists).toBeUndefined()
  })
})

describe('withNarrative', () => {
  const base = () =>
    assembleCrossAccount(
      [
        member('A1', 'a', { period: SAME_WINDOW, kpis: { V: { m: { value: 1, label: 'M', format: 'number' } } } }),
        member('A2', 'b', { period: SAME_WINDOW, kpis: { V: { m: { value: 2, label: 'M', format: 'number' } } } })
      ],
      null
    )

  it('attaches prose to the already-computed table without touching the numbers', () => {
    const before = base()
    const after = withNarrative(before, {
      accounts: [{ key: 'A2', highlights: ['quieter'] }],
      summary: { improvements: ['fine'] },
      crossAccount: { observations: ['A1 vs A2'] }
    })
    expect(after.synthesis).toBe('ai')
    expect(after.comparison).toEqual(before.comparison)
    expect(after.uniqueMetrics).toEqual(before.uniqueMetrics)
    expect(after.windowsComparable).toBe(before.windowsComparable)
    expect(after.accounts.find((a) => a.key === 'A2')!.highlights).toEqual(['quieter'])
    expect(after.accounts.find((a) => a.key === 'A1')!.highlights).toBeUndefined()
  })

  it('returns the deterministic roll-up unchanged when there is no narrative', () => {
    const before = base()
    expect(withNarrative(before, null)).toBe(before)
    expect(before.synthesis).toBe('deterministic')
  })
})
