import { describe, it, expect } from 'vitest'
import {
  formatCredits,
  formatBilledUsd,
  selectAiChip,
  selectUsagePool,
} from '../../../src/renderer/lib/ai-usage-format'
import type { AiUsageReport, AiUsageItem, CycleCredits } from '../../../src/shared/github-types'

// U+00B7 MIDDLE DOT separates the demoted billed-overage suffix in the no-cap
// idiom ("Copilot 500 · +$11.69"). Reconstructed here so the assertion does not
// depend on the source file's encoding.
const DOT = String.fromCodePoint(0xb7)

function item(partial: Partial<AiUsageItem>): AiUsageItem {
  return {
    product: 'copilot',
    sku: 'sku',
    model: 'gpt-5',
    unitType: 'request',
    grossQuantity: 0,
    grossAmount: 0,
    coveredQuantity: 0,
    coveredAmount: 0,
    billedQuantity: 0,
    billedAmount: 0,
    ...partial,
  }
}

function report(items: AiUsageItem[], billedAmount = 0): AiUsageReport {
  const grossAmount = items.reduce((s, it) => s + it.grossAmount, 0)
  const coveredAmount = items.reduce((s, it) => s + it.coveredAmount, 0)
  return {
    fetchedAt: 1_700_000_000_000,
    source: 'ai_credit',
    timePeriod: { year: 2026, month: 6 },
    items,
    totals: { grossAmount, coveredAmount, billedAmount },
  }
}

function cycle(partial: Partial<CycleCredits> = {}): CycleCredits {
  return {
    since: '2026-06-13',
    through: '2026-06-14',
    creditsUsed: 0,
    billedUsd: 0,
    ...partial,
  }
}

describe('formatCredits', () => {
  const cases: Array<[number, string]> = [
    [0, '0'],
    [-5, '0'],
    [12, '12'],
    [930, '930'],
    [999, '999'],
    [1000, '1k'],
    [8120, '8.1k'],
    [8000, '8k'],
    [19_950, '20k'],
    [20000, '20k'],
    [100_000, '100k'],
    [123_400, '123k'],
    [1_250_000, '1.3m'],
    [2_000_000, '2m'],
  ]
  it.each(cases)('formatCredits(%d) === %s', (input, expected) => {
    expect(formatCredits(input)).toBe(expected)
  })
})

describe('formatBilledUsd', () => {
  it('formats with a leading + and two decimals', () => {
    expect(formatBilledUsd(11.69)).toBe('+$11.69')
    expect(formatBilledUsd(0.4)).toBe('+$0.40')
    expect(formatBilledUsd(0)).toBe('+$0.00')
  })
  it('clamps negatives to zero', () => {
    expect(formatBilledUsd(-3)).toBe('+$0.00')
  })
})

describe('selectAiChip (whole-month report, no cycle)', () => {
  it('no overage, no cap: shows just the credit count', () => {
    const r = report([item({ grossQuantity: 8120 })])
    const chip = selectAiChip(r, null)
    expect(chip.tone).toBe('normal')
    expect(chip.label).toBe('Copilot 8.1k credits')
    expect(chip.creditsUsed).toBe(8120)
  })

  it('no overage, cap set: shows used / cap', () => {
    const r = report([item({ grossQuantity: 8120 })])
    const chip = selectAiChip(r, 20000)
    expect(chip.tone).toBe('normal')
    expect(chip.label).toBe('Copilot 8.1k/20k')
  })

  it('sums grossQuantity across multiple model rows', () => {
    const r = report([
      item({ grossQuantity: 5000 }),
      item({ grossQuantity: 3120 }),
    ])
    const chip = selectAiChip(r, 20000)
    expect(chip.creditsUsed).toBe(8120)
    expect(chip.label).toBe('Copilot 8.1k/20k')
  })

  it('credit count leads; a billed overage no longer hijacks the headline', () => {
    // The old idiom replaced the headline with "Copilot +$11.69". The redesign
    // keeps the credit count as the headline. With a cap set, exceeding it is
    // the warning signal (used > cap), shown as the ratio -- not the dollar value.
    const r = report([item({ grossQuantity: 22000, billedAmount: 11.69 })], 11.69)
    const chipCap = selectAiChip(r, 20000)
    expect(chipCap.tone).toBe('warning')
    expect(chipCap.label).toBe('Copilot 22k/20k')
  })

  it('no cap + billed overage: credit count leads, billed demoted to a suffix, tone stays normal', () => {
    // Without a cap there is no allowance to exceed, so the chip stays calm and
    // surfaces the billed amount as a small trailing annotation, not a warning.
    const r = report([item({ grossQuantity: 22000, billedAmount: 11.69 })], 11.69)
    const chip = selectAiChip(r, null)
    expect(chip.tone).toBe('normal')
    expect(chip.label).toBe(`Copilot 22k credits ${DOT} +$11.69`)
  })

  it('zero billed is NOT a warning even with usage present', () => {
    const r = report([item({ grossQuantity: 100 })], 0)
    expect(selectAiChip(r, null).tone).toBe('normal')
  })

  it('cap of 0 or negative is treated as unset', () => {
    const r = report([item({ grossQuantity: 100 })])
    expect(selectAiChip(r, 0).label).toBe('Copilot 100 credits')
    expect(selectAiChip(r, -5).label).toBe('Copilot 100 credits')
  })

  it('every label is prefixed "Copilot" (the renamed meter, not the bare "AI")', () => {
    const noCap = selectAiChip(report([item({ grossQuantity: 8120 })]), null)
    const withCap = selectAiChip(report([item({ grossQuantity: 8120 })]), 20000)
    const overage = selectAiChip(report([item({ grossQuantity: 5000, billedAmount: 11.69 })], 11.69), null)
    for (const chip of [noCap, withCap, overage]) {
      expect(chip.label.startsWith('Copilot ')).toBe(true)
      expect(chip.label).not.toMatch(/\bAI\b/)
    }
  })
})

describe('selectAiChip (cycle-scoped included credits)', () => {
  it('prefers the cycle figure over the whole-month report', () => {
    // Real nubbymong slice: month report is dominated by pre-upgrade Plus usage
    // (9342 credits, $11.69 billed on Jun 12), but the Max cycle since Jun 13 is
    // only ~891 credits and fully covered. The chip must show the cycle number.
    const month = report([item({ grossQuantity: 9342, billedAmount: 11.69 })], 11.69)
    const chip = selectAiChip(month, 20000, cycle({ creditsUsed: 891.29, billedUsd: 0 }))
    expect(chip.tone).toBe('normal')
    expect(chip.label).toBe('Copilot 891/20k')
    expect(chip.creditsUsed).toBeCloseTo(891.29, 2)
    expect(chip.billedAmount).toBe(0)
  })

  it('warns only when cycle usage exceeds the cap', () => {
    const month = report([item({ grossQuantity: 9342 })])
    const over = selectAiChip(month, 20000, cycle({ creditsUsed: 21000, billedUsd: 5 }))
    expect(over.tone).toBe('warning')
    expect(over.label).toBe('Copilot 21k/20k')
  })

  it('cycle with no cap + in-cycle overage: count leads, billed demoted, tone normal', () => {
    const month = report([item({ grossQuantity: 9342 })])
    const chip = selectAiChip(month, null, cycle({ creditsUsed: 500, billedUsd: 11.69 }))
    expect(chip.tone).toBe('normal')
    expect(chip.label).toBe(`Copilot 500 credits ${DOT} +$11.69`)
  })

  it('cycle with cap, no overage, fully covered: just the ratio (the user-approved calm chip)', () => {
    const month = report([item({ grossQuantity: 9342, billedAmount: 11.69 })], 11.69)
    const chip = selectAiChip(month, 20000, cycle({ creditsUsed: 833.6, billedUsd: 0 }))
    expect(chip.label).toBe('Copilot 834/20k')
    expect(chip.tone).toBe('normal')
  })

  it('a null cycle falls back to the whole-month report', () => {
    const month = report([item({ grossQuantity: 8120 })])
    expect(selectAiChip(month, 20000, null).label).toBe('Copilot 8.1k/20k')
    expect(selectAiChip(month, 20000, undefined).label).toBe('Copilot 8.1k/20k')
  })
})

describe('selectUsagePool (the popover + settings progress bar)', () => {
  it('uses the cycle figure and computes a clamped percentage of the cap', () => {
    const month = report([item({ grossQuantity: 9342, billedAmount: 11.69 })], 11.69)
    const pool = selectUsagePool(month, 20000, cycle({ creditsUsed: 891.29, billedUsd: 0 }))
    expect(pool.used).toBeCloseTo(891.29, 2)
    expect(pool.billed).toBe(0)
    expect(pool.capSet).toBe(true)
    expect(pool.over).toBe(false)
    expect(pool.pct).toBeCloseTo((891.29 / 20000) * 100, 4)
  })

  it('flags over-cap and clamps the percentage at 100', () => {
    const month = report([item({ grossQuantity: 9342 })])
    const pool = selectUsagePool(month, 20000, cycle({ creditsUsed: 25000, billedUsd: 10 }))
    expect(pool.over).toBe(true)
    expect(pool.pct).toBe(100)
  })

  it('surfaces a month overage that predates the cycle (clean cycle, billed month)', () => {
    // The user's exact case: $11.69 billed on Jun 12 (Plus), but the Max cycle
    // since Jun 13 is fully covered. The popover labels it as prior-plan billing.
    const month = report([item({ grossQuantity: 9342, billedAmount: 11.69 })], 11.69)
    const pool = selectUsagePool(month, 20000, cycle({ creditsUsed: 891.29, billedUsd: 0 }))
    expect(pool.billed).toBe(0)
    expect(pool.priorPlanBilled).toBeCloseTo(11.69, 2)
  })

  it('no cycle: pools the whole month and treats month billing as current (no prior-plan split)', () => {
    const month = report([item({ grossQuantity: 8120, billedAmount: 3.5 })], 3.5)
    const pool = selectUsagePool(month, 20000, null)
    expect(pool.used).toBe(8120)
    expect(pool.billed).toBe(3.5)
    expect(pool.priorPlanBilled).toBe(0)
  })

  it('no cap: pct is 0 and over is false', () => {
    const month = report([item({ grossQuantity: 8120 })])
    const pool = selectUsagePool(month, null, cycle({ creditsUsed: 500, billedUsd: 0 }))
    expect(pool.capSet).toBe(false)
    expect(pool.pct).toBe(0)
    expect(pool.over).toBe(false)
  })
})
