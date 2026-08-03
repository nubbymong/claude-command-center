import { describe, it, expect } from 'vitest'
import {
  assembleCrossAccount,
  buildComparisonRows,
  type CrossAccountMember
} from '../../src/main/insights-cross-account'
import type { InsightsData } from '../../src/shared/types'

// #191: the load-bearing rule is NUMBERS ARE COMPUTED, PROSE IS MODEL-WRITTEN.
// These tests pin the computed half: every value must be traceable to a member's
// own kpis.json, and nothing may be aggregated that cannot be aggregated safely.

function member(key: string, label: string, kpis: InsightsData): CrossAccountMember {
  return { key, runId: `run-${key}`, profileId: `p-${key}`, accountEmail: `${key}@example.com`, label, kpis }
}

const WORK = member('A1', 'Work', {
  period: { start: '2026-07-01', end: '2026-07-31', days: 31 },
  kpis: {
    Volume: {
      sessions: { value: 120, label: 'Sessions', format: 'number', goodDirection: 'up' },
      workOnly: { value: 9, label: 'Work Only', format: 'number' }
    },
    Outcomes: { successRate: { value: 0.8, label: 'Success Rate', format: 'percent', goodDirection: 'up' } },
    Friction: { retries: { value: 5, label: 'Retries', format: 'number', goodDirection: 'down' } }
  }
})

const PERSONAL = member('A2', 'Personal', {
  period: { start: '2026-07-10', end: '2026-07-31', days: 21 },
  kpis: {
    Volume: { sessions: { value: 40, label: 'Sessions', format: 'number', goodDirection: 'up' } },
    Outcomes: { successRate: { value: 0.95, label: 'Success Rate', format: 'percent', goodDirection: 'up' } },
    Friction: { retries: { value: 11, label: 'Retries', format: 'number', goodDirection: 'down' } }
  }
})

describe('buildComparisonRows', () => {
  const rows = buildComparisonRows([WORK, PERSONAL])

  it('keeps only metrics at least two accounts reported', () => {
    const keys = rows.map((r) => r.metricKey)
    expect(keys).toContain('sessions')
    expect(keys).toContain('successRate')
    expect(keys).toContain('retries')
    // Only Work has this one, so there is nothing to compare.
    expect(keys).not.toContain('workOnly')
  })

  it('copies each account value verbatim and keeps them identifiable', () => {
    const sessions = rows.find((r) => r.metricKey === 'sessions')!
    expect(sessions.category).toBe('Volume')
    expect(sessions.label).toBe('Sessions')
    expect(sessions.values).toEqual([
      { key: 'A1', profileId: 'p-A1', accountEmail: 'A1@example.com', value: 120 },
      { key: 'A2', profileId: 'p-A2', accountEmail: 'A2@example.com', value: 40 }
    ])
  })

  it('totals counts but never percentages or durations', () => {
    expect(rows.find((r) => r.metricKey === 'sessions')!.total).toBe(160)
    expect(rows.find((r) => r.metricKey === 'retries')!.total).toBe(16)
    // A summed success rate is a meaningless number; no weights exist to average it.
    expect(rows.find((r) => r.metricKey === 'successRate')!.total).toBeUndefined()
  })

  it('leaves an untagged metric untotalled rather than assuming it is a count', () => {
    const a = member('A1', 'A', { kpis: { Misc: { ratio: { value: 0.5, label: 'Ratio' } } } })
    const b = member('A2', 'B', { kpis: { Misc: { ratio: { value: 0.25, label: 'Ratio' } } } })
    const [row] = buildComparisonRows([a, b])
    expect(row.values.map((v) => v.value)).toEqual([0.5, 0.25])
    expect(row.total).toBeUndefined()
  })

  it('ignores non-numeric, non-finite, and malformed metric entries', () => {
    const a = member('A1', 'A', {
      kpis: {
        Volume: {
          good: { value: 1, label: 'Good', format: 'number' },
          text: { value: 'lots', label: 'Text' } as never,
          nan: { value: Number.NaN, label: 'NaN' },
          nothing: null as never
        }
      }
    })
    const b = member('A2', 'B', {
      kpis: {
        Volume: {
          good: { value: 2, label: 'Good', format: 'number' },
          text: { value: 'more', label: 'Text' } as never,
          nan: { value: Number.NaN, label: 'NaN' },
          nothing: null as never
        }
      }
    })
    expect(buildComparisonRows([a, b]).map((r) => r.metricKey)).toEqual(['good'])
  })

  it('returns nothing when a member has no kpis block at all', () => {
    expect(buildComparisonRows([member('A1', 'A', {}), member('A2', 'B', {})])).toEqual([])
  })

  it('groups by category, widest coverage first', () => {
    const categories = buildComparisonRows([WORK, PERSONAL]).map((r) => r.category)
    expect(categories).toEqual([...categories].sort())
  })
})

describe('assembleCrossAccount', () => {
  it('marks a model-written roll-up as ai and attaches highlights by key', () => {
    const data = assembleCrossAccount([WORK, PERSONAL], {
      accounts: [{ key: 'A2', highlights: ['Cleaner outcomes'] }],
      summary: { improvements: ['up'] },
      crossAccount: { observations: ['A1 is 3x A2'] }
    })
    expect(data.synthesis).toBe('ai')
    expect(data.accounts.find((a) => a.key === 'A1')!.highlights).toBeUndefined()
    expect(data.accounts.find((a) => a.key === 'A2')!.highlights).toEqual(['Cleaner outcomes'])
    expect(data.summary?.improvements).toEqual(['up'])
    expect(data.crossAccount?.observations).toEqual(['A1 is 3x A2'])
  })

  it('still produces a complete, renderable roll-up when the synthesis failed', () => {
    const data = assembleCrossAccount([WORK, PERSONAL], null)
    expect(data.synthesis).toBe('deterministic')
    expect(data.summary).toBeUndefined()
    expect(data.crossAccount).toBeUndefined()
    // The numbers survive — that is the point of the fallback.
    expect(data.comparison.length).toBeGreaterThan(0)
    expect(data.accounts.map((a) => a.label)).toEqual(['Work', 'Personal'])
  })

  it('carries each account its own period and never invents a combined one', () => {
    const data = assembleCrossAccount([WORK, PERSONAL], null)
    expect(data.period).toBeUndefined()
    expect(data.accounts[0].period).toEqual({ start: '2026-07-01', end: '2026-07-31', days: 31 })
    expect(data.accounts[1].period).toEqual({ start: '2026-07-10', end: '2026-07-31', days: 21 })
  })

  it('ignores narrative entries whose key matches no account', () => {
    const data = assembleCrossAccount([WORK], {
      accounts: [{ key: 'ghost', highlights: ['from nowhere'] }],
      crossAccount: { observations: ['x'] }
    })
    expect(data.accounts).toHaveLength(1)
    expect(data.accounts[0].highlights).toBeUndefined()
  })
})
