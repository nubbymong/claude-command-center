import { GITHUB_API_BASE } from '../../../shared/github-constants'

export interface VerifyResult {
  username: string
  avatarUrl?: string
  scopes: string[]
  expiresAt?: number
}

/** Thrown on transient / server-side failures so callers can distinguish them
 *  from an invalid-token verdict. 401 / 403-with-auth-failure return null;
 *  transient failures (5xx, rate-limit, network, parse failure) throw this.
 *
 *  `status` is the HTTP status when available, or 0 for pre-response failures
 *  (network, parse). `kind` disambiguates so callers can log accurately.
 *  The underlying error (fetch rejection, JSON parse error) is preserved via
 *  the standard ES2022 `cause` option.
 */
export class VerifyTransientError extends Error {
  readonly status: number
  readonly kind: 'http' | 'network' | 'parse'
  constructor(
    kind: 'http' | 'network' | 'parse',
    status: number,
    options?: { cause?: unknown },
  ) {
    const msg =
      kind === 'http'
        ? `GitHub /user returned HTTP ${status}`
        : kind === 'network'
        ? `network failure contacting GitHub /user`
        : `failed to parse GitHub /user response body`
    super(msg, options)
    this.name = 'VerifyTransientError'
    this.status = status
    this.kind = kind
  }
}

const UA = 'ClaudeCommandCenter'

/**
 * Verifies a PAT by hitting /user.
 *
 * Return semantics:
 *   - VerifyResult on 2xx
 *   - null on 401 (bad/expired token) or 403 when `x-ratelimit-remaining` is
 *     not `'0'` (treated as auth failure — could be SSO, org block, or bad
 *     credentials; caller re-prompts for a new token)
 *   - THROWS VerifyTransientError on:
 *       - 403 with `x-ratelimit-remaining: 0` (we hit the rate limit)
 *       - any other non-2xx status (5xx, 429, etc.)
 *       - network-level failure (DNS/TCP/timeout — fetch itself throws)
 *     so callers can retry / show a "temporary issue" state rather than
 *     telling the user their token is bad
 *
 * Reads scopes from `x-oauth-scopes` (classic PATs and OAuth tokens only —
 * fine-grained PATs return an empty header; capability derivation for those
 * goes through probeRepoAccess).
 */
export async function verifyToken(token: string): Promise<VerifyResult | null> {
  let r: Response
  try {
    r = await fetch(`${GITHUB_API_BASE}/user`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': UA,
      },
    })
  } catch (err) {
    // Network-level failures (DNS, TCP reset, TLS error, timeout) are transient
    // by definition — never let them surface as "invalid token". Preserve the
    // original error via `cause` so logs can diagnose connectivity issues.
    throw new VerifyTransientError('network', 0, { cause: err })
  }
  if (r.ok) {
    // 2xx body parsing can still fail if GitHub returns HTML (edge cache
    // errors) or truncated JSON. Treat parse failures as transient rather
    // than letting a generic Error escape this function's contract.
    let u: { login: string; avatar_url?: string }
    try {
      u = (await r.json()) as { login: string; avatar_url?: string }
    } catch (err) {
      throw new VerifyTransientError('parse', r.status, { cause: err })
    }
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
    // 403 is ambiguous: rate-limit vs SSO-blocked vs org-policy vs bad token.
    // We use `x-ratelimit-remaining === '0'` as the rate-limit signal because
    // GitHub always sets that header; deeper body inspection would require a
    // second read and doesn't add reliability. Any other 403 → null (caller
    // prompts re-auth).
    const remaining = r.headers.get('x-ratelimit-remaining')
    if (remaining === '0') throw new VerifyTransientError('http', r.status)
    return null
  }
  throw new VerifyTransientError('http', r.status)
}

/**
 * Probes whether a token has access to a specific repo.
 * 200 → true, anything else (including network failure) → false.
 * 401/403/404 are all "no"; network failures (DNS/TCP/timeout) collapse
 * into "no" as well because this is best-effort population of
 * `allowedRepos` — callers should re-probe later when connectivity returns.
 */
export async function probeRepoAccess(token: string, slug: string): Promise<boolean> {
  try {
    const r = await fetch(`${GITHUB_API_BASE}/repos/${slug}`, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': UA,
      },
    })
    return r.ok
  } catch {
    return false
  }
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
