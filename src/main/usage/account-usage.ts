// Fetches Anthropic usage for EVERY account profile without opening a session.
//
// Each account profile has its own OAuth credentials file (its isolated home),
// so we can read that account's access token and call the same usage endpoint
// the live statusline uses — no PTY, no fake session.
//
// Accounts stay signed in (the refresh token is long-lived); only the short-lived
// access token lapses between sessions. When it lapses we mint a fresh one from
// the refresh token ourselves (see refreshProfileToken) so an idle-but-signed-in
// account still shows live usage without opening a session. That refresh is
// heavily guarded (below) because refresh tokens ROTATE — a careless refresh that
// raced Claude Code's own refresh, or failed to persist, would log the account out.
// We surface a "Sign in" prompt ONLY when an account has no credentials at all.
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { listProfiles, getProfileConfigDir, readProfileAccountEmail } from '../account-profiles'
import { getActiveProfileIds } from '../claude-account-identity'
import { parseUsage } from './usage-buckets'
import type { AccountUsage, UsageBucket, CreditsInfo } from '../../shared/usage-types'
import { logWarn, logInfo } from '../debug-logger'

export type { AccountUsage } from '../../shared/usage-types'

interface StoredCreds {
  token: string | null
  expiresAt: number
  refreshToken: string | null
  /** The credentials file we actually read/parsed — where a refresh writes back. */
  credsPath: string | null
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
/** Claude Code's public OAuth client id — used for the refresh_token grant. If it
 *  ever changes, refresh just gets rejected (no rotation, no harm) and we fall back
 *  to showing last-known usage / the "open a session" hint. */
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Parse a Retry-After header (delta-seconds form; capped at 10s). Null when
 *  absent or not a plain number (HTTP-date form is not sent by this endpoint). */
function parseRetryAfterMs(header: string | string[] | undefined): number | null {
  const v = Array.isArray(header) ? header[0] : header
  if (!v) return null
  const secs = Number(v)
  return Number.isFinite(secs) && secs >= 0 ? Math.min(secs * 1000, 10_000) : null
}

/** Read a profile's OAuth tokens + expiry + signed-in state from its isolated
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
        const refreshToken = typeof oauth?.refreshToken === 'string' && oauth.refreshToken.length > 0 ? oauth.refreshToken : null
        const expiresAt = typeof oauth?.expiresAt === 'number' ? oauth.expiresAt : 0
        return { token, expiresAt, refreshToken, credsPath: p, signedIn: !!token || !!refreshToken }
      } catch {
        // Parsed nothing — likely caught the file mid-rewrite. Brief retry.
        if (attempt < 2) await sleep(60)
      }
    }
  }
  // Never parsed a token. A credentials file that EXISTS but wouldn't parse is a
  // transient read, not a sign-out, so keep signedIn true to avoid a false "Sign
  // in"; only a genuinely absent file is treated as signed out.
  return { token: null, expiresAt: 0, refreshToken: null, credsPath: null, signedIn: fileSeen }
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

// ── Token refresh ─────────────────────────────────────────────────────────
//
// Minting a fresh access token from the refresh token. This is the ONLY way to
// read usage for an account that's been idle long enough for its access token to
// lapse, without opening a session. It is guarded at the call site (fetchAccountUsage):
// only for signed-in accounts, only when the token is actually lapsed, and only when
// NO live session exists for the profile (so it can't race Claude Code's own refresh
// and rotate the token out from under a running session).

/** POST console.anthropic.com/v1/oauth/token with a refresh_token grant. */
async function postTokenRefresh(refreshToken: string): Promise<{ ok: true; data: unknown } | { ok: false }> {
  const https = await import('https')
  const payload = JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: OAUTH_CLIENT_ID })
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: 'console.anthropic.com',
        path: '/v1/oauth/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'User-Agent': 'claude-code/2.1.34',
        },
        timeout: 10_000,
      },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => {
          const s = res.statusCode ?? 0
          if (s >= 200 && s < 300) {
            try { resolve({ ok: true, data: JSON.parse(body) }) } catch { resolve({ ok: false }) }
          } else {
            resolve({ ok: false })
          }
        })
      },
    )
    req.on('error', () => resolve({ ok: false }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false }) })
    req.write(payload)
    req.end()
  })
}

/** Pure parse of a token-refresh response into the fields we persist. Exported +
 *  `now` injectable for testing. Returns null unless BOTH new tokens are present
 *  (a rotation that dropped the refresh token would be unsafe to persist). */
export function parseRefreshResponse(
  data: unknown,
  now: number = Date.now(),
): { accessToken: string; refreshToken: string; expiresAt: number } | null {
  if (!data || typeof data !== 'object') return null
  const o = data as Record<string, unknown>
  const accessToken = typeof o.access_token === 'string' && o.access_token.length > 0 ? o.access_token : null
  const refreshToken = typeof o.refresh_token === 'string' && o.refresh_token.length > 0 ? o.refresh_token : null
  const expiresIn = typeof o.expires_in === 'number' ? o.expires_in : null
  if (!accessToken || !refreshToken) return null
  return { accessToken, refreshToken, expiresAt: expiresIn ? now + expiresIn * 1000 : 0 }
}

/** Atomically write refreshed tokens back into the credentials file, preserving
 *  every other field in `claudeAiOauth`. temp-file + rename so the file is never
 *  observed half-written by a concurrently-starting Claude. Returns false (and
 *  does NOT touch the file) on any error. */
function writeRefreshedCreds(credsPath: string, t: { accessToken: string; refreshToken: string; expiresAt: number }): boolean {
  try {
    const raw = fs.readFileSync(credsPath, 'utf8')
    const c = JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> }
    c.claudeAiOauth = { ...(c.claudeAiOauth ?? {}), accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt }
    const tmp = credsPath + '.ccc-refresh.tmp'
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, credsPath)
    return true
  } catch (e) {
    logWarn(`[account-usage] failed to persist refreshed token: ${(e as Error)?.message ?? e}`)
    return false
  }
}

/** Per-profile in-flight guard so two concurrent fetches (fetchAll + a manual
 *  refreshOne) never double-refresh the same account and rotate twice. */
const refreshInFlight = new Map<string, Promise<{ accessToken: string; expiresAt: number } | null>>()

/** Mint + persist a fresh access token for a profile. Returns the new access
 *  token/expiry, or null on any failure (in which case credentials are untouched
 *  — a failed refresh NEVER logs the account out). */
async function refreshProfileToken(profileId: string, refreshToken: string, credsPath: string): Promise<{ accessToken: string; expiresAt: number } | null> {
  const existing = refreshInFlight.get(profileId)
  if (existing) return existing
  const run = (async () => {
    const res = await postTokenRefresh(refreshToken)
    if (!res.ok) { logWarn(`[account-usage] token refresh rejected for profile=${profileId}`); return null }
    const parsed = parseRefreshResponse(res.data)
    if (!parsed) { logWarn(`[account-usage] token refresh response unparseable for profile=${profileId}`); return null }
    // Persist the ROTATED tokens before returning; if the write fails we bail
    // (the server already rotated, but leaving creds untouched is the safe call —
    // worst case the account needs a re-login, which is the same failure Claude has).
    if (!writeRefreshedCreds(credsPath, parsed)) return null
    logInfo(`[account-usage] refreshed access token for profile=${profileId}`)
    return { accessToken: parsed.accessToken, expiresAt: parsed.expiresAt }
  })()
  refreshInFlight.set(profileId, run)
  try { return await run } finally { refreshInFlight.delete(profileId) }
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
 *  fetchable -> last-known (stale) or a soft refresh hint; success -> fresh.
 *  Auto-refreshes a lapsed token (guarded) so idle accounts still show live usage. */
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

  const creds = await readProfileToken(profileId, isPrimary)
  let token = creds.token
  let expiresAt = creds.expiresAt
  // 60s skew guard: a token within 60s of expiry is treated as unusable so we
  // don't burn a request that will 401.
  let tokenUsable = !!token && !(expiresAt > 0 && expiresAt < Date.now() + 60_000)

  // Auto-refresh a lapsed token so an idle-but-signed-in account still shows live
  // usage without opening a session. GUARDS (all must hold): signed in, we have a
  // refresh token + the creds path to write back, the token is actually lapsed,
  // and NO live session is running for this profile — so we can't race Claude's own
  // refresh and rotate the token out from under it. Refresh tokens rotate, so a
  // careless refresh here would log the account out.
  if (!tokenUsable && creds.signedIn && creds.refreshToken && creds.credsPath && !getActiveProfileIds().has(profileId)) {
    const refreshed = await refreshProfileToken(profileId, creds.refreshToken, creds.credsPath)
    if (refreshed) {
      token = refreshed.accessToken
      expiresAt = refreshed.expiresAt
      tokenUsable = true
    }
  }

  let fetched: RawResult | undefined
  if (creds.signedIn && tokenUsable && token) {
    fetched = await fetchWithRetry(() => fetchUsageRaw(token))
    if (!fetched.ok && fetched.httpStatus && fetched.httpStatus !== 401 && fetched.httpStatus !== 403) {
      logWarn(`[account-usage] fetch failed profile=${profileId} http=${fetched.httpStatus}`)
    }
  }

  const result = resolveUsageOutcome(base, { signedIn: creds.signedIn, tokenUsable, fetch: fetched }, lastGoodUsage.get(profileId))
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
