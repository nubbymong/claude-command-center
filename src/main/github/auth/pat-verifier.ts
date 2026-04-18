import { GITHUB_API_BASE } from '../../../shared/github-constants'

export interface VerifyResult {
  username: string
  avatarUrl?: string
  scopes: string[]
  expiresAt?: number
}

const UA = 'ClaudeCommandCenter'

/**
 * Verifies a PAT by hitting /user. Returns null on 401 (bad/expired token).
 * Reads scopes from `x-oauth-scopes` (classic PATs and OAuth tokens only —
 * fine-grained PATs return an empty header; capability derivation for those
 * goes through the per-repo probeRepoAccess path instead).
 */
export async function verifyToken(token: string): Promise<VerifyResult | null> {
  const r = await fetch(`${GITHUB_API_BASE}/user`, {
    headers: {
      Authorization: `token ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': UA,
    },
  })
  if (!r.ok) return null
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
