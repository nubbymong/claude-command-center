// P3.8 round 1 (P1, P3): the checks both providers' prices pass, read from the
// LiteLLM list or from a saved copy of it. Pure: no file, no request.
import { describe, it, expect } from 'vitest'
import {
  isPlainPriceId,
  checkedPer1M,
  listPricePer1M,
  isFreshCopy,
  isPriceRecord,
  MAX_PRICE_PER_1M,
  PRICE_CACHE_TTL_MS,
  PRICE_CACHE_CLOCK_SKEW_MS,
} from '../../../src/main/tokenomics/price-checks'

describe('the price checks', () => {
  it('a stored price is a finite number from 0 to the bound', () => {
    for (const v of [0, 1.25, MAX_PRICE_PER_1M]) expect(checkedPer1M(v)).toBe(v)
    for (const v of [-0.01, MAX_PRICE_PER_1M + 1, NaN, Infinity, -Infinity, '1', null, undefined, {}]) expect(checkedPer1M(v)).toBeNull()
  })

  it('a list price per token is read per 1M; absent is undefined, present but unusable is null', () => {
    expect(listPricePer1M(0.000005)).toBeCloseTo(5, 9)
    expect(listPricePer1M(0)).toBe(0)
    expect(listPricePer1M(undefined)).toBeUndefined()
    expect(listPricePer1M(null)).toBeUndefined()
    for (const v of ['0.000005', -0.000001, 1, NaN, true, {}]) expect(listPricePer1M(v)).toBeNull()
  })

  it('a model id is printable text with no space, 1 to 128 characters', () => {
    for (const id of ['claude-opus-5', 'anthropic.claude-opus-4-8-v1:0', 'vertex_ai/claude-opus-4-6@20250514', 'x'.repeat(128)]) {
      expect(isPlainPriceId(id)).toBe(true)
    }
    for (const id of ['', 'a b', 'a\tb', 'a\nb', 'x'.repeat(129), 'caf\u00e9', 5, null, undefined]) {
      expect(isPlainPriceId(id)).toBe(false)
    }
  })

  it('a saved copy is fresh within the day; one dated ahead of the clock by more than the skew is stale', () => {
    const now = 1_800_000_000_000
    expect(isFreshCopy(now, now)).toBe(true)
    expect(isFreshCopy(now - PRICE_CACHE_TTL_MS + 1, now)).toBe(true)
    expect(isFreshCopy(now - PRICE_CACHE_TTL_MS, now)).toBe(false)
    // Just written: the file system's clock may read a little ahead.
    expect(isFreshCopy(now + PRICE_CACHE_CLOCK_SKEW_MS, now)).toBe(true)
    expect(isFreshCopy(now + PRICE_CACHE_CLOCK_SKEW_MS + 1, now)).toBe(false)
    expect(isFreshCopy(now + 365 * 24 * 60 * 60 * 1000, now)).toBe(false)
    expect(isFreshCopy(NaN, now)).toBe(false)
    // The tolerance is a clock skew, not a second window.
    expect(PRICE_CACHE_CLOCK_SKEW_MS).toBeGreaterThan(0)
    expect(PRICE_CACHE_CLOCK_SKEW_MS).toBeLessThanOrEqual(5 * 60 * 1000)
  })

  it('a record is a plain object, never null or an array', () => {
    expect(isPriceRecord({})).toBe(true)
    for (const v of [null, undefined, [], 'x', 1]) expect(isPriceRecord(v)).toBe(false)
  })
})
