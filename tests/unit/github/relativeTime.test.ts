import { describe, it, expect } from 'vitest'
import { relativeTime } from '../../../src/renderer/utils/relativeTime'

describe('relativeTime', () => {
  const NOW = 1_700_000_000_000

  it('< 5s → "just now"', () => {
    expect(relativeTime(NOW - 2000, NOW)).toBe('just now')
  })
  it('seconds', () => {
    expect(relativeTime(NOW - 30_000, NOW)).toBe('30s ago')
  })
  it('minutes', () => {
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago')
  })
  it('hours', () => {
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3h ago')
  })
  it('days', () => {
    expect(relativeTime(NOW - 7 * 86_400_000, NOW)).toBe('7d ago')
  })
  it('months', () => {
    expect(relativeTime(NOW - 90 * 86_400_000, NOW)).toBe('3mo ago')
  })
  it('years', () => {
    expect(relativeTime(NOW - 400 * 86_400_000, NOW)).toBe('1y ago')
  })
  it('months→years boundary never produces "0y ago"', () => {
    // 364 days: 30-day months gives mo=12, but 365-day years gives y=0.
    // Regression guard: mo-derived years must yield at least "1y ago" once
    // we cross the 12-month threshold.
    expect(relativeTime(NOW - 364 * 86_400_000, NOW)).toBe('1y ago')
  })
  it('future timestamps clamp to "just now"', () => {
    expect(relativeTime(NOW + 10_000, NOW)).toBe('just now')
  })
})
