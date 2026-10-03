import { describe, it, expect } from 'vitest'
import { getPricingWithSource, getPricing, registryFallbackPricing, prefixPricingKey } from '../../src/main/tokenomics/tk-pricing'

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
  it('legacy getPricing(model) keeps returning the registry numbers', () => {
    // haiku-4-5 moved 0.8 → 1 with #411 (the published rate); the point of
    // this test is that the legacy entry point reads the SAME registry as the
    // new one, not that the numbers are frozen forever.
    expect(getPricing('claude-haiku-4-5').input).toBe(1)
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
  // For date-suffixed ids the LONGEST base that prefixes the model wins (#385
  // changed this from first-hit; registry order became a UI concern, and a
  // first-hit rule let `claude-opus-5` — base 'claude-opus' — shadow the far
  // more specific 'claude-opus-4-8-fast' purely by sitting earlier):
  //   opus-4-8-fast has NO numeric suffix to strip → base stays 'claude-opus-4-8-fast'
  //                 → startsWith check FAILS for all three NON-FAST cases below
  //   opus-4-8      base → 'claude-opus' → matches all claude-opus-*
  //
  // Ties on base length keep the FIRST key, i.e. registry order — see the
  // tie-invariant test at the bottom, which requires every tie to be
  // price-identical so position can never move a number.
  //
  // Therefore old and new produce identical numbers for the three NON-FAST cases.
  // The -fast date-suffixed case is intentionally DIFFERENT — see pinned test below.
  // P4.11: a dated id now takes its OWN key first (prefixPricingKey step 1), so
  // these three read 5/25 from claude-opus-4-8, 4-7 and 4-6 themselves; the
  // numbers are the ones pinned above.
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

  // The prefix match resolves ties on base length by registry POSITION, which
  // is only safe while every tie is price-identical. Adding a differently-priced
  // member to an existing family would otherwise silently re-price sibling
  // models according to where the entry was pasted. Fail here instead (#385 Q7).
  // UNCONDITIONAL since #411: the one documented exception (opus-4-6 at the
  // wrong 15/75) was corrected to the published rate, so nothing may hide
  // behind an exception list any more.
  // [host] P4.11: Opus 5.5 and Sonnet 5.5 cost less than the versions before
  // them, so a family's members no longer share one price, and pricing a dated
  // id by its collapsed family base would move it with registry order (#385
  // Q7). A dated or variant id of every registry model is priced by its OWN
  // key, whatever the order of the keys.
  it('a dated id of every registry model takes its own price, in any key order', () => {
    const fallback = registryFallbackPricing()
    const keys = Object.keys(fallback)
    const reversed = [...keys].reverse()
    for (const key of keys) {
      const dated = `${key}-20991231`
      expect(prefixPricingKey(keys, dated), dated).toBe(key)
      expect(prefixPricingKey(reversed, dated), dated).toBe(key)
      expect(getPricingWithSource(dated).pricing, dated).toEqual(fallback[key])
    }
    // A key never prices a longer version number as its own: 4-8 is not 4-80.
    expect(prefixPricingKey(['claude-opus-4-8', 'claude-opus-4'], 'claude-opus-4-80')).toBe('claude-opus-4')
    expect(prefixPricingKey(['claude-opus-4-8', 'claude-opus-4'], 'claude-opus-4-8-20991231')).toBe('claude-opus-4-8')
    // The real dated ids Claude Code reports.
    expect(getPricingWithSource('claude-opus-4-5-20251101').pricing).toEqual(fallback['claude-opus-4-5'])
    expect(getPricingWithSource('claude-sonnet-4-5-20250929').pricing).toEqual(fallback['claude-sonnet-4-5'])
    expect(getPricingWithSource('claude-haiku-4-5-20251001').pricing).toEqual(fallback['claude-haiku-4-5'])
  })

  it('[host] P4.11: Opus 5.5 and Sonnet 5.5 carry their published rates, exact and dated', () => {
    expect(getPricingWithSource('claude-opus-5-5')).toEqual({ pricing: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }, source: 'fallback' })
    expect(getPricingWithSource('claude-sonnet-5-5')).toEqual({ pricing: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }, source: 'fallback' })
    expect(getPricingWithSource('claude-opus-5-5-20261001').pricing.input).toBe(4)
    expect(getPricingWithSource('claude-opus-5-20260601').pricing.input).toBe(5)
  })

  it('the #411 corrections hold: opus-4-6 and haiku-4-5 carry the published rates', () => {
    const fallback = registryFallbackPricing()
    expect(fallback['claude-opus-4-6']).toEqual({ input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 })
    expect(fallback['claude-haiku-4-5']).toEqual({ input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 })
  })
})
