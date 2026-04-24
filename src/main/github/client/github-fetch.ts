import { GITHUB_API_BASE } from '../../../shared/github-constants'
import { EtagCache } from './etag-cache'
import { RateLimitShield, type Bucket } from './rate-limit-shield'

/**
 * Thrown by githubFetch when the per-bucket shield says we're too close
 * to the reset. Callers (the sync orchestrator) are expected to catch
 * this and set `rateLimitedUntil` on the session so scheduleNext delays
 * the next attempt until the reset.
 */
export class RateLimitError extends Error {
  constructor(
    public resetAt: number,
    public bucket: Bucket,
  ) {
    super(`rate-limited on ${bucket} until ${new Date(resetAt).toISOString()}`)
    this.name = 'RateLimitError'
  }
}

export interface GithubFetchOptions {
  tokenFn: () => Promise<string>
  shield: RateLimitShield
  etags: EtagCache
  bucket?: Bucket
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  baseUrl?: string
  extraHeaders?: Record<string, string>
}

/**
 * Thin wrapper around `fetch` for GitHub REST calls:
 *   - checks the per-bucket rate-limit shield BEFORE making the request
 *     (no-op RateLimitError if blocked — the sync orchestrator reads it)
 *   - attaches Authorization via injected tokenFn (gh CLI re-fetches per
 *     call, OAuth/PAT decrypt from safeStorage)
 *   - sends If-None-Match for GET requests when we have a cached ETag
 *   - captures rate-limit headers + new ETag after the response
 *
 * GraphQL callers use a sibling wrapper that reads the `rateLimit { cost,
 * remaining }` selection from the query response and calls
 * `shield.update('graphql', ...)` directly — the GraphQL bucket is
 * point-based, not request-count-based (see spec §7).
 */
export async function githubFetch(
  pathOrUrl: string,
  opts: GithubFetchOptions,
): Promise<Response> {
  const bucket: Bucket = opts.bucket ?? 'core'
  const now = Date.now()
  if (!opts.shield.canCall(bucket, now)) {
    throw new RateLimitError(opts.shield.nextAllowedAt(bucket) ?? now + 60_000, bucket)
  }

  const url = pathOrUrl.startsWith('http')
    ? pathOrUrl
    : (opts.baseUrl ?? GITHUB_API_BASE) + pathOrUrl
  const method = opts.method ?? 'GET'
  const key = `${method} ${pathOrUrl}`
  const token = await opts.tokenFn()
  const headers: Record<string, string> = {
    Authorization: `token ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'ClaudeCommandCenter',
    ...opts.extraHeaders,
  }
  if (method === 'GET') {
    const et = opts.etags.get(key)
    if (et) headers['If-None-Match'] = et
  }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'

  const resp = await fetch(url, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  })

  // Update shield from response headers. 304s still carry these headers
  // (conditional requests count against the primary limit — see spec §7).
  const limit = Number(resp.headers.get('x-ratelimit-limit'))
  const remaining = Number(resp.headers.get('x-ratelimit-remaining'))
  const reset = Number(resp.headers.get('x-ratelimit-reset'))
  if (limit && !Number.isNaN(remaining) && reset) {
    opts.shield.update(bucket, {
      limit,
      remaining,
      resetAt: reset * 1000,
      capturedAt: Date.now(),
    })
  }

  if (resp.status === 200) {
    const et = resp.headers.get('etag')
    if (et) opts.etags.set(key, et)
  }
  return resp
}
