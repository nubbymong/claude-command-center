import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  verifyToken,
  probeRepoAccess,
  parseExpiryHeader,
  VerifyTransientError,
} from '../../../src/main/github/auth/pat-verifier'

const orig = globalThis.fetch
afterEach(() => {
  globalThis.fetch = orig
})

describe('parseExpiryHeader', () => {
  it('parses GitHub format', () => {
    const t = parseExpiryHeader('2026-07-01 12:00:00 UTC')
    expect(new Date(t!).getUTCFullYear()).toBe(2026)
  })
  it('returns undefined on garbage', () => {
    expect(parseExpiryHeader('???')).toBeUndefined()
  })
})

describe('verifyToken', () => {
  it('returns username + scopes + expiry on 200', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: {
            get: (h: string) =>
              ((
                {
                  'x-oauth-scopes': 'repo, read:org',
                  'github-authentication-token-expiration': '2026-07-01 12:00:00 UTC',
                } as Record<string, string>
              )[h.toLowerCase()] ?? null),
          },
          json: async () => ({ login: 'nub', avatar_url: 'https://a' }),
        }) as unknown as Response,
    ) as unknown as typeof fetch
    const r = await verifyToken('ghp_x')
    expect(r!.username).toBe('nub')
    expect(r!.scopes).toEqual(['repo', 'read:org'])
    expect(r!.expiresAt).toBeGreaterThan(Date.now())
  })
  it('returns null on 401', async () => {
    globalThis.fetch = vi.fn(
      async () => ({ ok: false, status: 401 }) as unknown as Response,
    ) as unknown as typeof fetch
    expect(await verifyToken('bad')).toBeNull()
  })
  it('returns null on 403 when NOT rate-limited', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: false,
          status: 403,
          headers: { get: (_h: string) => null },
        }) as unknown as Response,
    ) as unknown as typeof fetch
    expect(await verifyToken('bad')).toBeNull()
  })
  it('throws VerifyTransientError on 403 rate-limit (remaining=0)', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: false,
          status: 403,
          headers: {
            get: (h: string) => (h.toLowerCase() === 'x-ratelimit-remaining' ? '0' : null),
          },
        }) as unknown as Response,
    ) as unknown as typeof fetch
    await expect(verifyToken('x')).rejects.toBeInstanceOf(VerifyTransientError)
  })
  it('throws VerifyTransientError on 5xx', async () => {
    globalThis.fetch = vi.fn(
      async () => ({ ok: false, status: 503 }) as unknown as Response,
    ) as unknown as typeof fetch
    await expect(verifyToken('x')).rejects.toBeInstanceOf(VerifyTransientError)
  })
})

describe('probeRepoAccess', () => {
  it('true on 200', async () => {
    globalThis.fetch = vi.fn(
      async () => ({ ok: true, status: 200 }) as unknown as Response,
    ) as unknown as typeof fetch
    expect(await probeRepoAccess('ghp_', 'a/b')).toBe(true)
  })
  it('false on 404', async () => {
    globalThis.fetch = vi.fn(
      async () => ({ ok: false, status: 404 }) as unknown as Response,
    ) as unknown as typeof fetch
    expect(await probeRepoAccess('ghp_', 'a/b')).toBe(false)
  })
  it('false on network-level failure (best-effort contract)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }) as unknown as typeof fetch
    expect(await probeRepoAccess('ghp_', 'a/b')).toBe(false)
  })
})

describe('verifyToken network + parse failures', () => {
  it('throws VerifyTransientError on fetch network error (DNS/TCP)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }) as unknown as typeof fetch
    await expect(verifyToken('x')).rejects.toBeInstanceOf(VerifyTransientError)
  })
  it('throws VerifyTransientError on 2xx body that fails to parse as JSON', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => {
            throw new Error('Unexpected token < in JSON')
          },
        }) as unknown as Response,
    ) as unknown as typeof fetch
    await expect(verifyToken('x')).rejects.toBeInstanceOf(VerifyTransientError)
  })
})
