// Fetches Anthropic usage for EVERY account profile without opening a session.
//
// Each account profile has its own OAuth credentials file (its isolated home),
// so we can read that account's access token and call the same usage endpoint
// the live statusline uses — no PTY, no fake session.
//
// Accounts stay signed in (the refresh token is long-lived); only the short-lived
// access token lapses between sessions, and starting a session refreshes it. So a
// lapsed/absent access token is NOT "signed out": we surface a "Sign in" prompt
// ONLY when the account has no credentials at all. When the account is signed in
// but we can't fetch right now (lapsed token, a 429 burst, a network blip) we show
// its last-known usage (flagged stale) rather than blanking the card. We never
// refresh the token ourselves — refresh tokens rotate, and racing Claude Code's own
// refresh would log the account out.
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { listProfiles, getProfileConfigDir, readProfileAccountEmail } from '../account-profiles'
import { parseUsage } from './usage-buckets'
import type { AccountUsage, UsageBucket, CreditsInfo } from '../../shared/usage-types'
import { logWarn } from '../debug-logger'

export type { AccountUsage } from '../../shared/usage-types'

interface StoredCreds {
  token: string | null
  expiresAt: number
  /** True when the account has credential material (a refresh/access token) or a
   *  credentials file we just couldn't parse this instant. Only when this is FALSE
   *  do we treat the account as genuinely signed out (and show a "Sign in" prompt). */
  signedIn: boolean
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

/** Read a profile's OAuth token + expiry + signed-in state from its isolated
 *  credentials file (falling back to global ~/.claude for the primary account).
 *  Retries a couple of times on a read/parse failure: Claude Code rewrites this
 *  file on its own token refresh, and a single read can catch it mid-write — a
 *  transient parse failure would otherwise masquerade as "not signed in". Async
 *  only for the retry backoff. Never throws. */
async function readProfileToken(profileId: string, isPrimary: boolean): Promise<StoredCreds> {
  const candidates = [path.join(getProfileConfigDir(profileId), '.claude', '.credentials.json')]
  if (isPrimary) candidates.push(path.join(os.homedir(), '.claude', '.credentials.json'))
  let fileSeen = false
  for (const p of candidates) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let raw: string
      try {
        raw = fs.readFileSync(p, 'utf8')
      } catch (e) {
        // Missing at this path -> try the next candidate. Any other read error
        // (e.g. a rename gap during Claude's refresh) gets one brief retry.
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT' || attempt >= 2) break
        await sleep(60)
        continue
      }
      fileSeen = true
      try {
        const c = JSON.parse(raw) as { claudeAiOauth?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown } }
        const oauth = c.claudeAiOauth
        const token = typeof oauth?.accessToken === 'string' ? oauth.accessToken : null
        const hasRefresh = typeof oauth?.refreshToken === 'string' && oauth.refreshToken.length > 0
        const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : 0
        return { token, expiresAt, signedIn: !!token || hasRefresh }
      } catch {
        // Parsed nothing — likely caught the file mid-rewrite. Brief retry.
        if (attempt < 2) await sleep(60)
      }
    }
  }
  // Never parsed a token. A credentials file that EXISTS but wouldn't parse is a
  // transient read, not a sign-out, so keep signedIn true to avoid a false "Sign
  // in"; only a genuinely absent file is treated as signed out.
  return { token: null, expiresAt: 0, signedIn: fileSeen }
}

export type RawResult =
  | { ok: true; data: unknown }
  | { ok: false; httpStatus: number | null; retryAfterMs: number | null }

/** GET api.anthropic.com/api/oauth/usage with a bearer token. Resolves the
 *  parsed JSON, or an { httpStatus, retryAfterMs } marker on a non-2xx (so
 *  401 -> token lapsed, 429 -> caller backs off and retries). */
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

/** Last successful usage per profile, in-memory for the app's lifetime. When a
 *  later fetch can't complete but the account is still signed in (lapsed token,
 *  429 burst, network blip), we show these last-known figures flagged stale
 *  instead of blanking the card. Cleared naturally on app restart. */
const lastGoodUsage = new Map<string, { buckets: UsageBucket[]; credits?: CreditsInfo; fetchedAt: number }>()

/** Pure decision: given the account's signed-in state, whether its token was
 *  usable, the fetch result (if we made one), and any cached usage, produce the
 *  AccountUsage to show. Exported + pure so the whole state matrix is unit-tested. */
export function resolveUsageOutcome(
  base: AccountUsage,
  input: { signedIn: boolean; tokenUsable: boolean; fetch?: RawResult },
  cached: { buckets: UsageBucket[]; credits?: CreditsInfo; fetchedAt: number } | undefined,
): AccountUsage {
  // Genuinely signed out (no credentials at all) is the ONLY "Sign in" case.
  if (!input.signedIn) return { ...base, status: 'needs-login', detail: 'not signed in' }

  const staleOr = (fallback: AccountUsage): AccountUsage =>
    cached
      ? { ...base, status: 'ok', stale: true, buckets: cached.buckets, credits: cached.credits, fetchedAt: cached.fetchedAt }
      : fallback

  const refreshHint: AccountUsage = { ...base, status: 'error', detail: 'signed in — open a session to refresh' }

  // Signed in but no usable token, or we never fetched -> can't fetch live; show
  // last-known usage, else a soft refresh hint. Never "Sign in".
  if (!input.tokenUsable || !input.fetch) return staleOr(refreshHint)

  const res = input.fetch
  if (!res.ok) {
    // A 401/403 on a signed-in account means the token lapsed just now -> soft refresh.
    if (res.httpStatus === 401 || res.httpStatus === 403) return staleOr(refreshHint)
    // 429-after-retries / network error -> last-known if we have it, else the error.
    return staleOr({ ...base, status: 'error', detail: res.httpStatus ? `HTTP ${res.httpStatus}` : 'network error' })
  }
  const parsed = parseUsage(res.data)
  return { ...base, status: 'ok', stale: false, buckets: parsed.buckets, credits: parsed.credits }
}

/** Fetch usage for one profile. Signed-out -> needs-login; signed-in but not
 *  fetchable -> last-known (stale) or a soft refresh hint; success -> fresh. */
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

  const { token, expiresAt, signedIn } = await readProfileToken(profileId, isPrimary)
  // 60s skew guard: a token within 60s of expiry is treated as unusable so we
  // don't burn a request that will 401.
  const tokenUsable = !!token && !(expiresAt > 0 && expiresAt < Date.now() + 60_000)

  let fetched: RawResult | undefined
  if (signedIn && tokenUsable && token) {
    fetched = await fetchWithRetry(() => fetchUsageRaw(token))
    if (!fetched.ok && fetched.httpStatus && fetched.httpStatus !== 401 && fetched.httpStatus !== 403) {
      logWarn(`[account-usage] fetch failed profile=${profileId} http=${fetched.httpStatus}`)
    }
  }

  const result = resolveUsageOutcome(base, { signedIn, tokenUsable, fetch: fetched }, lastGoodUsage.get(profileId))
  if (result.status === 'ok' && !result.stale) {
    lastGoodUsage.set(profileId, { buckets: result.buckets, credits: result.credits, fetchedAt: result.fetchedAt })
  }
  return result
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
