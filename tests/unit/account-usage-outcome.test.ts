import { describe, it, expect } from 'vitest'
import { resolveUsageOutcome, type RawResult } from '../../src/main/usage/account-usage'
import type { AccountUsage, UsageBucket } from '../../src/shared/usage-types'

const base: AccountUsage = {
  profileId: 'p1', email: 'a@b.c', name: 'A', isPrimary: false,
  status: 'error', buckets: [], fetchedAt: 1000,
}
const cachedBucket: UsageBucket = { key: 'session:', label: '5h', group: 'session', percent: 10, resetsAt: '', severity: 'normal' }
const cached = { buckets: [cachedBucket], credits: undefined, fetchedAt: 500 }

const ok = (data: unknown): RawResult => ({ ok: true, data })
const fail = (httpStatus: number | null): RawResult => ({ ok: false, httpStatus, retryAfterMs: null })

describe('resolveUsageOutcome — account panel state matrix', () => {
  it('signed OUT -> needs-login (the ONLY Sign in case)', () => {
    const r = resolveUsageOutcome(base, { signedIn: false, tokenUsable: false }, undefined)
    expect(r.status).toBe('needs-login')
    expect(r.detail).toBe('not signed in')
  })

  it('signed in + unusable token + no cache -> soft refresh hint, NOT Sign in', () => {
    const r = resolveUsageOutcome(base, { signedIn: true, tokenUsable: false }, undefined)
    expect(r.status).toBe('error')
    expect(r.detail).toMatch(/^signed in/)
  })

  it('signed in + unusable token + cache -> stale ok with cached figures', () => {
    const r = resolveUsageOutcome(base, { signedIn: true, tokenUsable: false }, cached)
    expect(r.status).toBe('ok')
    expect(r.stale).toBe(true)
    expect(r.buckets).toEqual(cached.buckets)
    expect(r.fetchedAt).toBe(500) // shows the real age of the cached data
  })

  it('signed in + 401 + no cache -> soft refresh hint (never needs-login)', () => {
    const r = resolveUsageOutcome(base, { signedIn: true, tokenUsable: true, fetch: fail(401) }, undefined)
    expect(r.status).toBe('error')
    expect(r.detail).toMatch(/^signed in/)
  })

  it('signed in + 401 + cache -> stale ok', () => {
    const r = resolveUsageOutcome(base, { signedIn: true, tokenUsable: true, fetch: fail(401) }, cached)
    expect(r.status).toBe('ok')
    expect(r.stale).toBe(true)
  })

  it('signed in + 429-after-retries + no cache -> error HTTP 429', () => {
    const r = resolveUsageOutcome(base, { signedIn: true, tokenUsable: true, fetch: fail(429) }, undefined)
    expect(r.status).toBe('error')
    expect(r.detail).toBe('HTTP 429')
  })

  it('signed in + 429 + cache -> stale ok (never blank a working account)', () => {
    const r = resolveUsageOutcome(base, { signedIn: true, tokenUsable: true, fetch: fail(429) }, cached)
    expect(r.status).toBe('ok')
    expect(r.stale).toBe(true)
  })

  it('signed in + network error + no cache -> error network', () => {
    const r = resolveUsageOutcome(base, { signedIn: true, tokenUsable: true, fetch: fail(null) }, undefined)
    expect(r.status).toBe('error')
    expect(r.detail).toBe('network error')
  })

  it('signed in + success -> fresh ok (not stale), parsed buckets', () => {
    const data = { limits: [{ group: 'session', kind: 'session', percent: 42, resets_at: '', severity: 'normal' }] }
    const r = resolveUsageOutcome(base, { signedIn: true, tokenUsable: true, fetch: ok(data) }, cached)
    expect(r.status).toBe('ok')
    expect(r.stale).toBe(false)
    expect(r.buckets.length).toBe(1)
    expect(r.buckets[0].label).toBe('5h')
    expect(r.buckets[0].percent).toBe(42)
  })
})
