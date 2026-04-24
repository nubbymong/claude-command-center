import { describe, it, expect, vi, afterEach } from 'vitest'
import { githubFetch, RateLimitError } from '../../../src/main/github/client/github-fetch'
import { RateLimitShield } from '../../../src/main/github/client/rate-limit-shield'
import { EtagCache } from '../../../src/main/github/client/etag-cache'

const orig = globalThis.fetch
afterEach(() => {
  globalThis.fetch = orig
})

const makeResp = (
  body: unknown,
  headers: Record<string, string> = {},
  status = 200,
) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => headers[h.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response

describe('githubFetch', () => {
  const shield = new RateLimitShield()
  const etags = new EtagCache({})
  const tokenFn = async () => 'ghp_X'

  it('sends Authorization + captures rate limit headers', async () => {
    globalThis.fetch = vi.fn(async (_u: unknown, opts: unknown) => {
      const o = opts as { headers: Record<string, string> }
      expect(o.headers.Authorization).toBe('token ghp_X')
      return makeResp(
        {},
        {
          'x-ratelimit-limit': '5000',
          'x-ratelimit-remaining': '4999',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        },
      )
    }) as unknown as typeof fetch
    const s = new RateLimitShield()
    await githubFetch('/user', { tokenFn, shield: s, etags })
    expect(s.snapshot('core')?.remaining).toBe(4999)
  })

  it('sends If-None-Match when cached', async () => {
    const e = new EtagCache({ 'GET /user': '"old"' })
    globalThis.fetch = vi.fn(async (_u: unknown, opts: unknown) => {
      const o = opts as { headers: Record<string, string> }
      expect(o.headers['If-None-Match']).toBe('"old"')
      return makeResp({}, {}, 304)
    }) as unknown as typeof fetch
    const r = await githubFetch('/user', { tokenFn, shield, etags: e })
    expect(r.status).toBe(304)
  })

  it('captures new ETag on 200', async () => {
    const e = new EtagCache({})
    globalThis.fetch = vi.fn(
      async () => makeResp({}, { etag: '"new"' }),
    ) as unknown as typeof fetch
    await githubFetch('/x', { tokenFn, shield, etags: e })
    expect(e.get('GET /x')).toBe('"new"')
  })

  it('throws RateLimitError when blocked (no fetch call)', async () => {
    const s = new RateLimitShield()
    const now = Date.now()
    s.update('core', { limit: 5000, remaining: 0, resetAt: now + 60_000, capturedAt: now })
    const f = vi.fn() as unknown as typeof fetch
    globalThis.fetch = f
    await expect(
      githubFetch('/x', { tokenFn, shield: s, etags: new EtagCache({}) }),
    ).rejects.toBeInstanceOf(RateLimitError)
    expect(f).not.toHaveBeenCalled()
  })

  it('POST passes JSON body with correct Content-Type', async () => {
    globalThis.fetch = vi.fn(async (_u: unknown, opts: unknown) => {
      const o = opts as { method: string; headers: Record<string, string>; body: string }
      expect(o.method).toBe('POST')
      expect(o.headers['Content-Type']).toBe('application/json')
      expect(JSON.parse(o.body)).toEqual({ hi: 1 })
      return makeResp({ ok: true })
    }) as unknown as typeof fetch
    await githubFetch('/x', {
      tokenFn,
      shield,
      etags,
      method: 'POST',
      body: { hi: 1 },
    })
  })

  it('does not send If-None-Match for non-GET methods', async () => {
    const e = new EtagCache({ 'POST /x': '"etag"' })
    globalThis.fetch = vi.fn(async (_u: unknown, opts: unknown) => {
      const o = opts as { headers: Record<string, string> }
      expect(o.headers['If-None-Match']).toBeUndefined()
      return makeResp({})
    }) as unknown as typeof fetch
    await githubFetch('/x', { tokenFn, shield, etags: e, method: 'POST', body: {} })
  })
})
