// Cycle-scoped "included credits" usage: sums per-day Copilot AI-credit usage
// from a plan-cycle start (e.g. a mid-month Max upgrade) so the meter matches
// GitHub's billing-card "X / allowance" instead of the whole-month total.
import { describe, it, expect, vi } from 'vitest'
import {
  sumCopilotCreditsForDay,
  cycleDays,
  fetchCycleCredits,
} from '../../../src/main/github/copilot-usage'

// A realistic day-summary body (shape from GET .../billing/usage/summary?day=N):
// Copilot ai-units count toward the pool; a premium-request row and an Actions
// row must be excluded.
function daySummary(copilotGross: number, copilotNet = 0) {
  return {
    timePeriod: { year: 2026, month: 6 },
    user: 'nubbymong',
    usageItems: [
      { product: 'Actions', sku: 'actions_linux', unitType: 'minutes', grossQuantity: 7104, netAmount: 23.55 },
      { product: 'Copilot', sku: 'copilot_premium_request', unitType: 'Requests', grossQuantity: 500, netAmount: 5 },
      { product: 'Copilot', sku: 'copilot_ai_unit', unitType: 'ai-units', grossQuantity: copilotGross, netAmount: copilotNet },
    ],
  }
}

describe('sumCopilotCreditsForDay', () => {
  it('sums only Copilot ai-unit rows (gross credits + overage $), excluding premium-request and other products', () => {
    const r = sumCopilotCreditsForDay(daySummary(815.1, 0))
    expect(r.credits).toBeCloseTo(815.1, 4)
    expect(r.billedUsd).toBeCloseTo(0, 4)
  })
  it('captures overage on the ai-unit row', () => {
    const r = sumCopilotCreditsForDay(daySummary(2186.3, 11.69))
    expect(r.credits).toBeCloseTo(2186.3, 4)
    expect(r.billedUsd).toBeCloseTo(11.69, 4)
  })
  it('returns zeros for an unparseable body', () => {
    expect(sumCopilotCreditsForDay(null)).toEqual({ credits: 0, billedUsd: 0 })
    expect(sumCopilotCreditsForDay({ usageItems: 'nope' })).toEqual({ credits: 0, billedUsd: 0 })
  })
})

describe('cycleDays', () => {
  const jun14 = Date.UTC(2026, 5, 14, 9, 0, 0) // 2026-06-14
  it('enumerates inclusive UTC days from the cycle start through today', () => {
    expect(cycleDays('2026-06-13', jun14).map((d) => d.iso)).toEqual(['2026-06-13', '2026-06-14'])
  })
  it('single day when start is today', () => {
    expect(cycleDays('2026-06-14', jun14).map((d) => d.iso)).toEqual(['2026-06-14'])
  })
  it('empty for a future start or garbage', () => {
    expect(cycleDays('2026-06-20', jun14)).toEqual([])
    expect(cycleDays('not-a-date', jun14)).toEqual([])
  })
  it('bounded so a far-past start cannot fan out unbounded', () => {
    expect(cycleDays('2020-01-01', jun14).length).toBe(70)
  })
})

describe('fetchCycleCredits', () => {
  const jun14 = Date.UTC(2026, 5, 14, 9, 0, 0)
  // Real nubbymong slice: Jun 13 = 815.1 credits, Jun 14 = 18.5, both fully
  // covered (no overage on Max) -> ~833.6 used since the upgrade.
  const perDay: Record<string, number> = { '13': 815.1, '14': 18.5 }

  function fetchImpl(url: string) {
    const day = new URL(url).searchParams.get('day') as string
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(daySummary(perDay[day] ?? 0, 0)),
    } as Response)
  }

  it('sums Copilot credits across the cycle window (matches the GitHub card)', async () => {
    const cycle = await fetchCycleCredits('nubbymong', '2026-06-13', {
      tokenFn: async () => 'tok',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => jun14,
    })
    expect(cycle).not.toBeNull()
    expect(cycle!.creditsUsed).toBeCloseTo(833.6, 1)
    expect(cycle!.billedUsd).toBeCloseTo(0, 4)
    expect(cycle!.since).toBe('2026-06-13')
    expect(cycle!.through).toBe('2026-06-14')
  })

  it('returns null when every day errors (so the caller keeps any prior value)', async () => {
    const failing = vi.fn().mockResolvedValue({ ok: false } as Response)
    const cycle = await fetchCycleCredits('nubbymong', '2026-06-13', {
      tokenFn: async () => 'tok',
      fetchImpl: failing as unknown as typeof fetch,
      now: () => jun14,
    })
    expect(cycle).toBeNull()
  })

  it('returns null when no cycle start is configured', async () => {
    expect(
      await fetchCycleCredits('nubbymong', '', { tokenFn: async () => 'tok', now: () => jun14 }),
    ).toBeNull()
  })
})
