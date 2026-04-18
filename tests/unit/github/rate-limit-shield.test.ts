import { describe, it, expect } from 'vitest'
import { RateLimitShield } from '../../../src/main/github/client/rate-limit-shield'

describe('RateLimitShield', () => {
  it('allows calls with no state', () => {
    expect(new RateLimitShield().canCall('core', Date.now())).toBe(true)
  })
  it('updates + snapshot', () => {
    const s = new RateLimitShield()
    const now = Date.now()
    s.update('core', { limit: 5000, remaining: 4000, resetAt: now + 1000, capturedAt: now })
    expect(s.snapshot('core')?.remaining).toBe(4000)
  })
  it('blocks when <10% remaining before reset', () => {
    const s = new RateLimitShield()
    const now = Date.now()
    s.update('core', { limit: 5000, remaining: 400, resetAt: now + 60_000, capturedAt: now })
    expect(s.canCall('core', now)).toBe(false)
  })
  it('resumes after reset', () => {
    const s = new RateLimitShield()
    const now = Date.now()
    s.update('core', { limit: 5000, remaining: 400, resetAt: now + 60_000, capturedAt: now })
    expect(s.canCall('core', now + 61_000)).toBe(true)
  })
  it('per-bucket independence — graphql not affected by core exhaustion', () => {
    const s = new RateLimitShield()
    const now = Date.now()
    s.update('core', { limit: 5000, remaining: 100, resetAt: now + 60_000, capturedAt: now })
    expect(s.canCall('graphql', now)).toBe(true)
  })
  it('graphql tracks points budget per spec §7 (not a request count)', () => {
    // GraphQL limit is point/cost based (typically 5000 points/hr). A large
    // query that consumed 4900 points leaves 100 remaining — shield should
    // block even though only one query was issued.
    const s = new RateLimitShield()
    const now = Date.now()
    s.update('graphql', { limit: 5000, remaining: 100, resetAt: now + 60_000, capturedAt: now })
    expect(s.canCall('graphql', now)).toBe(false)
  })
  it('nextAllowedAt returns resetAt when blocked', () => {
    const s = new RateLimitShield()
    const now = Date.now()
    const reset = now + 60_000
    s.update('core', { limit: 5000, remaining: 0, resetAt: reset, capturedAt: now })
    expect(s.nextAllowedAt('core')).toBe(reset)
  })
})
