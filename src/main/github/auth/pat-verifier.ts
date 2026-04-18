import { GITHUB_API_BASE } from '../../../shared/github-constants'

export interface VerifyResult {
  username: string
  avatarUrl?: string
  scopes: string[]
  expiresAt?: number
}

/** Thrown on transient / server-side failures so callers can distinguish them
 *  from an invalid-token verdict. 401 / 403-with-auth-failure return null; all
 *  other non-2xx statuses throw this. */
export class VerifyTransientError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`GitHub /user returned HTTP ${status}`)
    this.name = 'VerifyTransientError'
    this.status = status
  }
}

const UA = 'ClaudeCommandCenter'

/**
 * Verifies a PAT by hitting /user.
 *
 * Return semantics:
 *   - VerifyResult on 2xx
 *   - null on 401 (bad/expired token) or 403 when response body indicates
 *     bad credentials — caller re-prompts for a new token
 *   - THROWS VerifyTransientError on any other non-2xx (5xx, 403 rate-limit,
 *     network-edge) so callers can retry / surface a "temporary issue" state
 *     rather than telling the user their token is bad
 *
 * Reads scopes from `x-oauth-scopes` (classic PATs and OAuth tokens only —
 * fine-grained PATs return an empty header; capability derivation for those
 * goes through probeRepoAccess).
 */
export async function verifyToken(token: string): Promise<VerifyResult | null> {
  const r = await fetch(`${GITHUB_API_BASE}/user`, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': UA,
    },
  })
  if (r.ok) {
    const u = (await r.json()) as { login: string; avatar_url?: string }
    const scopes = (r.headers.get('x-oauth-scopes') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const exp = r.headers.get('github-authentication-token-expiration')
    return {
      username: u.login,
      avatarUrl: u.avatar_url,
      scopes,
      expiresAt: exp ? parseExpiryHeader(exp) : undefined,
    }
  }
  if (r.status === 401) return null
  if (r.status === 403) {
    // 403 is ambiguous: bad credentials, rate limited, or blocked by SSO.
    // x-ratelimit-remaining === '0' means rate-limited; otherwise treat as
    // an auth failure and return null so the UI prompts re-auth.
    const remaining = r.headers.get('x-ratelimit-remaining')
    if (remaining === '0') throw new VerifyTransientError(r.status)
    return null
  }
  throw new VerifyTransientError(r.status)
}

/**
 * Probes whether a token has access to a specific repo.
 * 200 → true, anything else → false (401/403/404 are all "no").
 * Used by fine-grained PAT flows to populate `allowedRepos`.
 */
export async function probeRepoAccess(token: string, slug: string): Promise<boolean> {
  const r = await fetch(`${GITHUB_API_BASE}/repos/${slug}`, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': UA,
    },
  })
  return r.ok
}

/**
 * Parses the `github-authentication-token-expiration` header ("2026-07-01 12:00:00 UTC")
 * into an epoch ms, or undefined if the format isn't recognized.
 */
export function parseExpiryHeader(raw: string): number | undefined {
  const iso = raw.replace(' UTC', 'Z').replace(' ', 'T')
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : t
}
