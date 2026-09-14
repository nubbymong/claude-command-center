import { describe, it, expect } from 'vitest'
import {
  formatMetricValue,
  spanDaysFromPeriod,
  windowsAreComparable
} from '../../src/shared/kpi-format'
import { formatValue } from '../../src/renderer/utils/kpiTrends'

// #191 follow-up: value formatting moved to shared/ so the main process can render
// the SAME strings into the synthesis prompt that the renderer shows in the table.
// If these two ever diverge, the model quotes numbers the UI contradicts.

describe('formatMetricValue', () => {
  it('renders percent as a 0-1 proportion', () => {
    expect(formatMetricValue(0.4231, 'percent')).toBe('42.3%')
    expect(formatMetricValue(1, 'percent')).toBe('100.0%')
  })

  it('renders duration from milliseconds', () => {
    expect(formatMetricValue(126600, 'duration')).toBe('2.1m')
    expect(formatMetricValue(5000, 'duration')).toBe('5.0s')
    expect(formatMetricValue(340, 'duration')).toBe('340ms')
  })

  it('abbreviates large counts and keeps integers exact', () => {
    expect(formatMetricValue(17358)).toBe('17.4K')
    expect(formatMetricValue(1200000)).toBe('1.2M')
    expect(formatMetricValue(242)).toBe('242')
    expect(formatMetricValue(7.61)).toBe('7.6')
  })

  it('is the same function the renderer uses', () => {
    expect(formatValue).toBe(formatMetricValue)
  })
})

describe('spanDaysFromPeriod', () => {
  it('counts calendar days inclusive', () => {
    expect(spanDaysFromPeriod({ start: '2026-07-09', end: '2026-07-31' })).toBe(23)
    expect(spanDaysFromPeriod({ start: '2026-06-27', end: '2026-07-31' })).toBe(35)
    expect(spanDaysFromPeriod({ start: '2026-07-01', end: '2026-07-01' })).toBe(1)
  })

  it('returns undefined rather than guessing on missing or bad dates', () => {
    expect(spanDaysFromPeriod(undefined)).toBeUndefined()
    expect(spanDaysFromPeriod({ start: '2026-07-01' })).toBeUndefined()
    expect(spanDaysFromPeriod({ start: 'last Tuesday', end: '2026-07-31' })).toBeUndefined()
    // end before start is nonsense, not a negative span.
    expect(spanDaysFromPeriod({ start: '2026-07-31', end: '2026-07-01' })).toBeUndefined()
  })

  it('is deliberately NOT period.days', () => {
    // Real archived values: the extraction model puts ACTIVE days in period.days,
    // so a 23-day window arrives carrying days:10. Anything reasoning about window
    // length has to derive it from the dates.
    const period = { start: '2026-07-09', end: '2026-07-31', days: 10 }
    expect(spanDaysFromPeriod(period)).toBe(23)
    expect(period.days).toBe(10)
  })
})

describe('windowsAreComparable', () => {
  it('accepts windows within tolerance', () => {
    expect(windowsAreComparable([31, 27])).toBe(true)
    expect(windowsAreComparable([30, 30, 30])).toBe(true)
  })

  it('rejects materially different windows', () => {
    expect(windowsAreComparable([23, 35])).toBe(false)
    expect(windowsAreComparable([10, 61])).toBe(false)
  })

  it('rejects any unknown or non-positive span rather than assuming', () => {
    expect(windowsAreComparable([30, undefined])).toBe(false)
    expect(windowsAreComparable([30, 0])).toBe(false)
    expect(windowsAreComparable([])).toBe(false)
  })
})
