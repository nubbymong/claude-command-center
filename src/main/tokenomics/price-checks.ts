/**
 * price-checks.ts -- the checks every price read from the LiteLLM price list,
 * or from a saved copy of it, passes through (P3.8). Both providers' prices
 * are read through the same checks: a price is a finite, non-negative number
 * no larger than MAX_PRICE_PER_1M per 1M tokens, and a model id is plain text
 * (printable, no spaces, bounded). Valid entries price exactly as they always
 * have; an entry that fails a check is left out, never coerced.
 */

/** No real price comes near this ($100,000 per 1M tokens): above it an entry
 *  is taken to be garbage, not a price. */
export const MAX_PRICE_PER_1M = 100_000

/** How long a saved copy of the list is used before it is fetched again. */
export const PRICE_CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** A model id as the price list may name it: printable ASCII with no space or
 *  control character, 1 to 128 characters. */
const PLAIN_ID_RE = /^[\x21-\x7e]{1,128}$/

export function isPlainPriceId(id: unknown): id is string {
  return typeof id === 'string' && PLAIN_ID_RE.test(id)
}

/** A per-1M price as stored (already per 1M): the number, or null when it is
 *  not a finite number in [0, MAX_PRICE_PER_1M]. */
export function checkedPer1M(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_PRICE_PER_1M ? v : null
}

/** A per-token price from the list, as per 1M: undefined when the field is
 *  absent (the list leaves it out), null when present but not a usable price. */
export function listPricePer1M(v: unknown): number | null | undefined {
  if (v === undefined || v === null) return undefined
  return typeof v === 'number' ? checkedPer1M(v * 1_000_000) : null
}

/** How far in the future a just-written copy's date may read (the file
 *  system's clock and this process's differ by a little). */
export const PRICE_CACHE_CLOCK_SKEW_MS = 60 * 1000

/** A saved copy is fresh when it was written within the TTL, and not in the
 *  future beyond the clock skew: a clock set back, or a copied file, never
 *  keeps one for good. */
export function isFreshCopy(mtimeMs: number, nowMs: number, ttlMs: number = PRICE_CACHE_TTL_MS): boolean {
  const age = nowMs - mtimeMs
  return Number.isFinite(age) && age >= -PRICE_CACHE_CLOCK_SKEW_MS && age < ttlMs
}

export const isPriceRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
