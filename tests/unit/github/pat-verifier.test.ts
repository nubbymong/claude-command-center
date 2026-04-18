import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  verifyToken,
  probeRepoAccess,
  parseExpiryHeader,
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
})
