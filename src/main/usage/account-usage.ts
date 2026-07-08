// Fetches Anthropic usage for EVERY account profile without opening a session.
//
// Each account profile has its own OAuth credentials file (its isolated home),
// so we can read that account's access token and call the same usage endpoint
// the live statusline uses — no PTY, no fake session. An account whose stored
// token has expired can't be fetched silently (refresh tokens rotate; a bad
// write would log the account out), so it's reported as `needs-login` and the
// UI offers a re-auth button.
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { listProfiles, getProfileConfigDir, readProfileAccountEmail } from '../account-profiles'
import { parseUsage } from './usage-buckets'
import type { AccountUsage } from '../../shared/usage-types'
import { logWarn } from '../debug-logger'

export type { AccountUsage } from '../../shared/usage-types'

interface StoredCreds {
  token: string | null
  expiresAt: number
}

/** Space consecutive account fetches out so a batch doesn't burst the usage
 *  endpoint's per-IP rate limit (the old Promise.all drew 429s on valid tokens). */
const STAGGER_MS = 300
/** Max 429 retries per account before giving up and reporting the error. */
const MAX_429_RETRIES = 3

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Parse a Retry-After header (delta-seconds form; capped at 10s). Null when
 *  absent or not a plain number (HTTP-date form is not sent by this endpoint). */
function parseRetryAfterMs(header: string | string[] | undefined): number | null {
  const v = Array.isArray(header) ? header[0] : header
  if (!v) return null
  const secs = Number(v)
  return Number.isFinite(secs) && secs >= 0 ? Math.min(secs * 1000, 10_000) : null
}

/** Read a profile's OAuth token + expiry from its isolated credentials file.
 *  Falls back to the global ~/.claude for the primary account when its profile
 *  home hasn't been seeded yet. Never throws. */
function readProfileToken(profileId: string, isPrimary: boolean): StoredCreds {
  const candidates = [path.join(getProfileConfigDir(profileId), '.claude', '.credentials.json')]
  if (isPrimary) candidates.push(path.join(os.homedir(), '.claude', '.credentials.json'))
  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, 'utf8')
      const c = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } }
      const token = typeof c.claudeAiOauth?.accessToken === 'string' ? c.claudeAiOauth.accessToken : null
      const expiresAt = typeof c.claudeAiOauth?.expiresAt === 'number' ? c.claudeAiOauth.expiresAt : 0
      if (token) return { token, expiresAt }
    } catch { /* try next candidate */ }
  }
  return { token: null, expiresAt: 0 }
}

export type RawResult =
  | { ok: true; data: unknown }
  | { ok: false; httpStatus: number | null; retryAfterMs: number | null }

/** GET api.anthropic.com/api/oauth/usage with a bearer token. Resolves the
 *  parsed JSON, or an { httpStatus, retryAfterMs } marker on a non-2xx (so
 *  401 -> needs-login, 429 -> caller backs off and retries). */
async function fetchUsageRaw(token: string): Promise<RawResult> {
  const https = await import('https')
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/api/oauth/usage',
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: 'Bearer ' + token,
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'claude-code/2.1.34',
        },
        timeout: 8000,
      },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          const status = res.statusCode ?? null
          if (status && status >= 200 && status < 300) {
            try { resolve({ ok: true, data: JSON.parse(body) }) }
            catch { resolve({ ok: false, httpStatus: status, retryAfterMs: null }) }
          } else {
            resolve({ ok: false, httpStatus: status, retryAfterMs: parseRetryAfterMs(res.headers['retry-after']) })
          }
        })
      },
    )
    req.on('error', () => resolve({ ok: false, httpStatus: null, retryAfterMs: null }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, httpStatus: null, retryAfterMs: null }) })
    req.end()
  })
}

/** Run `fetch` and retry on HTTP 429 with backoff, honouring Retry-After when
 *  present. The usage endpoint burst-rate-limits by IP, so a batch of accounts
 *  can 429 even with a valid token. Exported for testing; `sleepFn` is injectable
 *  so tests exercise the retry logic without waiting real time. */
export async function fetchWithRetry(
  fetch: () => Promise<RawResult>,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<RawResult> {
  let res = await fetch()
  for (let attempt = 1; attempt <= MAX_429_RETRIES && !res.ok && res.httpStatus === 429; attempt++) {
    await sleepFn(res.retryAfterMs ?? attempt * 600)
    res = await fetch()
  }
  return res
}

/** Fetch usage for one profile. Expired/absent token -> needs-login (no network). */
export async function fetchAccountUsage(profileId: string): Promise<AccountUsage> {
  const profiles = listProfiles()
  const profile = profiles.find((p) => p.id === profileId)
  const isPrimary = !!profile?.isPrimary
  const base: AccountUsage = {
    profileId,
    email: profile?.accountEmail || readProfileAccountEmail(profileId),
    name: profile?.name || 'Account',
    isPrimary,
    status: 'error',
    buckets: [],
    fetchedAt: Date.now(),
  }
  if (!profile) return { ...base, detail: 'unknown profile' }

  const { token, expiresAt } = readProfileToken(profileId, isPrimary)
  if (!token) return { ...base, status: 'needs-login', detail: 'not signed in' }
  // A 60s skew guard: a token expiring imminently is treated as stale so we
  // don't burn a request that will 401.
  if (expiresAt > 0 && expiresAt < Date.now() + 60_000) {
    return { ...base, status: 'needs-login', detail: 'session expired' }
  }

  const res = await fetchWithRetry(() => fetchUsageRaw(token))
  if (!res.ok) {
    if (res.httpStatus === 401 || res.httpStatus === 403) {
      return { ...base, status: 'needs-login', detail: 'session expired' }
    }
    logWarn(`[account-usage] fetch failed profile=${profileId} http=${res.httpStatus}`)
    return { ...base, status: 'error', detail: res.httpStatus ? `HTTP ${res.httpStatus}` : 'network error' }
  }
  const parsed = parseUsage(res.data)
  return { ...base, status: 'ok', buckets: parsed.buckets, credits: parsed.credits }
}

/** Fetch usage for every account, sequentially with a small stagger between
 *  accounts. The usage endpoint burst-rate-limits by IP, so firing every account
 *  at once (the old Promise.all) drew 429s on otherwise-valid tokens. Order
 *  matches listProfiles (primary first is the store's responsibility). */
export async function fetchAllAccountsUsage(): Promise<AccountUsage[]> {
  const profiles = listProfiles()
  const out: AccountUsage[] = []
  for (let i = 0; i < profiles.length; i++) {
    if (i > 0) await sleep(STAGGER_MS)
    out.push(await fetchAccountUsage(profiles[i].id))
  }
  return out
}
