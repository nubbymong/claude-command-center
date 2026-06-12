import { describe, it, expect } from 'vitest'
import {
  formatCredits,
  formatBilledUsd,
  selectAiChip,
} from '../../../src/renderer/lib/ai-usage-format'
import type { AiUsageReport, AiUsageItem } from '../../../src/shared/github-types'

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

describe('selectAiChip', () => {
  it('no overage, no cap: shows just the credit count', () => {
    const r = report([item({ grossQuantity: 8120 })])
    const chip = selectAiChip(r, null)
    expect(chip.tone).toBe('normal')
    expect(chip.label).toBe('AI 8.1k')
    expect(chip.creditsUsed).toBe(8120)
  })

  it('no overage, cap set: shows used / cap', () => {
    const r = report([item({ grossQuantity: 8120 })])
    const chip = selectAiChip(r, 20000)
    expect(chip.tone).toBe('normal')
    expect(chip.label).toBe('AI 8.1k/20k')
  })

  it('sums grossQuantity across multiple model rows', () => {
    const r = report([
      item({ grossQuantity: 5000 }),
      item({ grossQuantity: 3120 }),
    ])
    const chip = selectAiChip(r, 20000)
    expect(chip.creditsUsed).toBe(8120)
    expect(chip.label).toBe('AI 8.1k/20k')
  })

  it('overage: switches to the billed warning idiom regardless of cap', () => {
    const r = report([item({ grossQuantity: 22000, billedAmount: 11.69 })], 11.69)
    const chipNoCap = selectAiChip(r, null)
    expect(chipNoCap.tone).toBe('warning')
    expect(chipNoCap.label).toBe('AI +$11.69')
    const chipCap = selectAiChip(r, 20000)
    expect(chipCap.tone).toBe('warning')
    expect(chipCap.label).toBe('AI +$11.69')
  })

  it('zero billed is NOT a warning even with usage present', () => {
    const r = report([item({ grossQuantity: 100 })], 0)
    expect(selectAiChip(r, null).tone).toBe('normal')
  })

  it('cap of 0 or negative is treated as unset', () => {
    const r = report([item({ grossQuantity: 100 })])
    expect(selectAiChip(r, 0).label).toBe('AI 100')
    expect(selectAiChip(r, -5).label).toBe('AI 100')
  })
})
