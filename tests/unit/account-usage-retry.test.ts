import { describe, it, expect, vi } from 'vitest'
import { fetchWithRetry, type RawResult } from '../../src/main/usage/account-usage'

// A no-op sleep so the retry/backoff logic runs without waiting real time.
const noSleep = () => Promise.resolve()

const OK: RawResult = { ok: true, data: { limits: [] } }
const rl = (retryAfterMs: number | null = null): RawResult => ({ ok: false, httpStatus: 429, retryAfterMs })
const UNAUTH: RawResult = { ok: false, httpStatus: 401, retryAfterMs: null }

describe('fetchWithRetry — 429 burst backoff', () => {
  it('returns immediately on success (no retry)', async () => {
    const fetch = vi.fn().mockResolvedValue(OK)
    const res = await fetchWithRetry(fetch, noSleep)
    expect(res.ok).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('retries on 429 and returns the first success', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(rl())
      .mockResolvedValueOnce(rl())
      .mockResolvedValueOnce(OK)
    const res = await fetchWithRetry(fetch, noSleep)
    expect(res.ok).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('gives up after the retry cap and returns the final 429 (not a hard error state)', async () => {
    const fetch = vi.fn().mockResolvedValue(rl())
    const res = await fetchWithRetry(fetch, noSleep)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.httpStatus).toBe(429)
    expect(fetch).toHaveBeenCalledTimes(4) // 1 initial + 3 retries
  })

  it('does NOT retry non-429 failures (401 stays needs-login)', async () => {
    const fetch = vi.fn().mockResolvedValue(UNAUTH)
    const res = await fetchWithRetry(fetch, noSleep)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.httpStatus).toBe(401)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('honours Retry-After when present, else uses attempt backoff', async () => {
    const waits: number[] = []
    const sleepFn = (ms: number) => { waits.push(ms); return Promise.resolve() }
    const fetch = vi.fn()
      .mockResolvedValueOnce(rl(2000)) // Retry-After 2s -> wait 2000
      .mockResolvedValueOnce(rl(null)) // no header -> attempt(2) * 600 = 1200
      .mockResolvedValueOnce(OK)
    await fetchWithRetry(fetch, sleepFn)
    expect(waits).toEqual([2000, 1200])
  })
})
