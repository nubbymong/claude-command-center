import type { RateLimitSnapshot } from '../../../shared/github-types'

export type Bucket = 'core' | 'search' | 'graphql'

/**
 * Per-bucket rate-limit shield. Tracks the last-observed snapshot per bucket
 * and blocks calls when the remaining budget drops below 10% of the limit
 * before the reset window.
 *
 * Bucket semantics (per spec §7):
 *   - core / search: REQUESTS remaining against the per-hour request budget
 *     (typically 5000 req/hr for authenticated REST)
 *   - graphql: POINTS remaining against the per-hour point budget (also
 *     typically 5000 points/hr, but one query can consume many points
 *     depending on shape). Callers update this from the `rateLimit` object
 *     returned by each GraphQL response — never from a request count.
 *
 * Buckets are independent: exhausting core does not pause graphql and vice
 * versa.
 */
export class RateLimitShield {
  private buckets: Partial<Record<Bucket, RateLimitSnapshot>> = {}

  update(b: Bucket, s: RateLimitSnapshot): void {
    this.buckets[b] = s
  }

  snapshot(b: Bucket): RateLimitSnapshot | undefined {
    return this.buckets[b]
  }

  canCall(b: Bucket, now: number): boolean {
    const s = this.buckets[b]
    if (!s) return true
    if (now >= s.resetAt) return true
    return s.remaining >= Math.ceil(s.limit * 0.1)
  }

  nextAllowedAt(b: Bucket): number | null {
    const s = this.buckets[b]
    return s ? s.resetAt : null
  }
}
