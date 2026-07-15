import { describe, it, expect } from 'vitest'
import { getPricingWithSource, getPricing } from '../../src/main/tokenomics/tk-pricing'

// livePricing is null in unit tests (no fetch), so resolution exercises the
// registry-fallback chain. The registry service self-initializes on import
// with the static baseline; no overlay dir needed for these cases.
describe('getPricingWithSource', () => {
  it('exact registry id -> source fallback, exact prices', () => {
    const r = getPricingWithSource('claude-opus-4-8')
    expect(r.source).toBe('fallback')
    expect(r.pricing).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
  })
  it("date-suffixed id -> prefix match (today's behaviour at tk-pricing.ts:124-127, pinned)", () => {
    const r = getPricingWithSource('claude-sonnet-4-6-20260301')
    expect(r.source).toBe('prefix')
    expect(r.pricing.input).toBe(3)
  })
  it('novel family -> guess (sonnet rates), never silent', () => {
    const r = getPricingWithSource('claude-thinking-7')
    expect(r.source).toBe('guess')
    expect(r.pricing.input).toBe(3)
  })
  it('legacy getPricing(model) keeps returning the same numbers', () => {
    expect(getPricing('claude-haiku-4-5').input).toBe(0.8)
    expect(getPricing('claude-thinking-7').input).toBe(3)
  })

  // Prefix-order regression: pin the numbers the OLD FALLBACK_PRICING code produced
  // for date-suffixed opus variants, so we never silently drift tokenomics totals.
  //
  // Analysis: the old prefix loop stripped /-\d+[-\d]*$/ from each KEY.
  //   'claude-opus-4-8'      → base 'claude-opus'  (strips -4-8)
  //   'claude-opus-4-8-fast' → base unchanged      ('-fast' is non-digit suffix; no match)
  //   'claude-opus-4-7'      → base 'claude-opus'  (strips -4-7)
  //   'claude-opus-4-6'      → base 'claude-opus'  (strips -4-6)
  //
  // Old key order: fable-5, opus-4-8, opus-4-8-fast, opus-4-7, opus-4-6, ...
  // New key order: fable-5, opus-4-8-fast, opus-4-8, opus-4-7, opus-4-6, ...
  //
  // For date-suffixed ids the first key whose BASE is a prefix wins:
  //   opus-4-8-fast has NO numeric suffix to strip → base stays 'claude-opus-4-8-fast'
  //                 → startsWith check FAILS for all three NON-FAST cases below
  //   opus-4-8      base → 'claude-opus' → matches all claude-opus-* → SAME first hit
  //
  // Therefore old and new produce identical numbers for the three NON-FAST cases.
  // The -fast date-suffixed case is intentionally DIFFERENT — see pinned test below.
  it('claude-opus-4-8-20260601 -> prefix hit on opus-4-8 key -> 5/25 (old & new identical)', () => {
    const r = getPricingWithSource('claude-opus-4-8-20260601')
    expect(r.source).toBe('prefix')
    expect(r.pricing.input).toBe(5)
    expect(r.pricing.output).toBe(25)
  })
  it('claude-opus-4-7-20260101 -> prefix hit on opus-4-8 key (base claude-opus) -> 5/25 (old & new identical)', () => {
    // Old code: opus-4-8 came first; base 'claude-opus' matched 4-7-dated string → 5/25.
    // New code: opus-4-8-fast has no strippable suffix (base unchanged), so opus-4-8
    //           still comes first with base 'claude-opus' → 5/25. Same.
    const r = getPricingWithSource('claude-opus-4-7-20260101')
    expect(r.source).toBe('prefix')
    expect(r.pricing.input).toBe(5)
    expect(r.pricing.output).toBe(25)
  })
  it('claude-opus-4-6-20260101 -> prefix hit on opus-4-8 key (base claude-opus) -> 5/25 (old & new identical)', () => {
    // Old code: opus-4-8 base 'claude-opus' matched before opus-4-6 → returned 5/25
    //           (NOT 15/75; was already "wrong" by intent, but consistent & pinned).
    // New code: same first-hit via opus-4-8 base 'claude-opus' → 5/25. Identical.
    const r = getPricingWithSource('claude-opus-4-6-20260101')
    expect(r.source).toBe('prefix')
    expect(r.pricing.input).toBe(5)
    expect(r.pricing.output).toBe(25)
  })

  it('date-suffixed -fast id now correctly gets fast pricing (intentional change: old key order made it $5)', () => {
    const r = getPricingWithSource('claude-opus-4-8-fast-20260601')
    expect(r.source).toBe('prefix')
    expect(r.pricing.input).toBe(10)
  })
})
