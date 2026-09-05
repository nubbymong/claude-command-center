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
import { listProfiles, getProfileConfigDir, readProfileAccountEmail, atomicWriteSecure, hardenCredentialFile } from '../account-profiles'
import { isAccountActive } from '../../shared/account-types'
import type { AccountProfile } from '../../shared/account-types'
import { isProfileInUseByLiveSession, getClaudeProfileId } from '../claude-account-identity'
import { noteProfileRefreshInFlight } from '../profile-consumers'
import { parseUsage } from './usage-buckets'
import { loadSnapshots, saveSnapshots, type UsageSnapshot } from './usage-snapshots'
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
 *  observed half-written by a concurrently-starting Claude.
 *
 *  Rotation safety: re-reads the file and ABORTS (returning false, file untouched)
 *  when its refresh token is no longer the one we spent on the grant — another
 *  writer (a /login completing in a login shell, or Claude's own refresh) rotated
 *  the lineage mid-flight, and theirs is NEWER; overwriting would destroy a live
 *  sign-in. Transient write errors are retried: the server-side rotation already
 *  happened, so giving up too easily would strand the account on a dead token. */
async function writeRefreshedCreds(
  credsPath: string,
  spentRefreshToken: string,
  t: { accessToken: string; refreshToken: string; expiresAt: number },
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const raw = fs.readFileSync(credsPath, 'utf8')
      const c = JSON.parse(raw) as { claudeAiOauth?: Record<string, unknown> }
      const current = c.claudeAiOauth?.refreshToken
      if (typeof current === 'string' && current.length > 0 && current !== spentRefreshToken) {
        logWarn('[account-usage] credentials rotated by another writer during refresh — keeping theirs, discarding ours')
        return false
      }
      c.claudeAiOauth = { ...(c.claudeAiOauth ?? {}), accessToken: t.accessToken, refreshToken: t.refreshToken, expiresAt: t.expiresAt }
      atomicWriteSecure(credsPath, JSON.stringify(c, null, 2), 0o600)
      // This path had no re-assert, unlike account-profiles' writeCredentialFile.
      // Keep the two credential writers symmetric so neither is a lone weak point.
      hardenCredentialFile(credsPath)
      return true
    } catch (e) {
      if (attempt < 2) { await sleep(100); continue }
      logWarn(`[account-usage] failed to persist refreshed token after retries: ${(e as Error)?.message ?? e}`)
    }
  }
  return false
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
    // Persist the ROTATED tokens immediately (a Claude spawning right now re-reads
    // this file for its own refresh, so landing the new lineage fast is what keeps
    // it signed in). writeRefreshedCreds aborts instead when ANOTHER writer rotated
    // mid-flight — their sign-in is newer than our rotation, keep theirs.
    if (!(await writeRefreshedCreds(credsPath, refreshToken, parsed))) return null
    logInfo(`[account-usage] refreshed access token for profile=${profileId}`)
    return { accessToken: parsed.accessToken, expiresAt: parsed.expiresAt }
  })()
  refreshInFlight.set(profileId, run)
  // #49: publish the rotation so a consumer that starts NOW (a session, a
  // headless run, a cloud agent) waits for the new lineage to land instead of
  // reading a credential file whose refresh token this POST is about to spend.
  // Registered synchronously with the guard check that let us get here, so no
  // consumer can slip between "not in use" and "rotating".
  noteProfileRefreshInFlight(profileId, run)
  try { return await run } finally { refreshInFlight.delete(profileId) }
}

/** Last successful usage per profile. When a later fetch can't complete but the
 *  account is still signed in (lapsed token, 429 burst, network blip), we show
 *  these last-known figures flagged stale instead of blanking the card.
 *
 *  This used to be memory-only and was cleared on restart, which meant the one
 *  case it was most wanted in -- reopening the app and picking an account before
 *  any session has run -- was the one case it could not serve. It is now backed
 *  by usage-snapshots.json (see usage-snapshots.ts): the same map, rehydrated
 *  once per process and written through on every success. Nothing about the
 *  DECISION changes -- `resolveUsageOutcome` already models "stale figures with
 *  an age" and the UI already renders `stale` + `fetchedAt`. */
const lastGoodUsage = new Map<string, UsageSnapshot>()

let snapshotsLoaded = false

/** Rehydrate from disk once per process, on first use. */
function hydrateSnapshots(): void {
  if (snapshotsLoaded) return
  snapshotsLoaded = true
  for (const [id, snap] of loadSnapshots()) lastGoodUsage.set(id, snap)
}

// -- Live per-account usage harvested from open sessions (plan P2) -----------
//
// An OPEN account -- one with a live session -- already has its usage on screen:
// that session's statusline bridge fetched api.anthropic.com/api/oauth/usage
// seconds ago and the watcher fanned the buckets out. Making the account-usage
// page fetch the same thing AGAIN is a redundant call against an endpoint that
// rate-limits by IP, and Phase 1 already forbids the only DANGEROUS call for an
// in-use account -- the single-use token rotation. So an open account reuses the
// delivered figure and makes NO network call; only CLOSED accounts call, one at
// a time. `recordLiveUsageForSession` is wired to the statusline fan-out
// (setStatuslineUsageSink, main/index).
//
// The delivered figure carries buckets but NOT the page's full CreditsInfo (the
// statusline has only the dollar `rateLimitExtra` shape -- no currency). So when
// the page would show a credits row the buckets-only figure cannot express (the
// delivered payload had extra usage, or a prior real fetch cached credits for
// this profile), the open account falls back to ONE GET with its live token --
// never a rotation; the refresh guard forbids that while in use. This is the
// agreed Q1b behaviour.

/** How stale a delivered figure may be and still count as "live". A session
 *  writes its statusline 1-3x/s, so a healthy open account is always well inside
 *  this; the bound only stops a wedged or paused session's minutes-old figure
 *  from being served as current -- past it, the open account takes the GET path. */
export const LIVE_USAGE_MAX_AGE_MS = 90_000

interface LiveUsageEntry {
  buckets: UsageBucket[]
  /** The delivered payload indicated paid credit (statusline sets rateLimitExtra
   *  only when extra usage is enabled). The page would then show a credits row
   *  the buckets-only figure cannot, so the open account fills it with one GET. */
  hasCredits: boolean
  fetchedAt: number
}

/** Latest session-delivered usage per profile: one entry per open account,
 *  overwritten on each statusline tick and read only for an in-use account. */
const liveUsageByProfile = new Map<string, LiveUsageEntry>()

/** A delivered bucket, defensively -- the local bridge file is trusted, but a
 *  malformed record must not paint wrong numbers on the account page. */
function isLiveBucket(v: unknown): v is UsageBucket {
  if (!v || typeof v !== 'object') return false
  const b = v as Record<string, unknown>
  return typeof b.key === 'string' && typeof b.label === 'string' && typeof b.group === 'string'
    && typeof b.percent === 'number' && Number.isFinite(b.percent) && typeof b.resetsAt === 'string'
}

/**
 * Record the usage a live session just delivered, keyed by the PROFILE it runs
 * under. An empty or all-malformed set is ignored (nothing to serve), and an SSH
 * or default-home session has no local profile id so it stores nothing -- both
 * leave the account on the GET path, which is correct.
 */
export function recordLiveUsageForSession(sessionId: string, buckets: unknown, hasCredits: boolean, now: number = Date.now()): void {
  const profileId = getClaudeProfileId(sessionId)
  if (!profileId) return
  if (!Array.isArray(buckets)) return
  const clean = buckets.filter(isLiveBucket)
  if (clean.length === 0) return
  liveUsageByProfile.set(profileId, { buckets: clean, hasCredits: !!hasCredits, fetchedAt: now })
}

/** The delivered figure for a profile if one is recorded and still fresh. */
function freshLiveUsage(profileId: string, now: number): LiveUsageEntry | undefined {
  const e = liveUsageByProfile.get(profileId)
  if (!e || now - e.fetchedAt > LIVE_USAGE_MAX_AGE_MS) return undefined
  return e
}

/**
 * The delivered figure to SERVE for an open account without any network call, or
 * null when the account must take the GET path. Null when: no fresh figure yet
 * (a session just spawned), the delivered payload had credits (Q1b -> GET), or a
 * prior fetch cached credits the buckets-only figure cannot carry (Q1b -> GET).
 * The ONE decision, shared by fetchAccountUsage and the fetchAll stagger so the
 * two never disagree about which accounts hit the network.
 */
function servableLiveUsage(profileId: string, now: number = Date.now()): LiveUsageEntry | null {
  const live = freshLiveUsage(profileId, now)
  if (!live || live.hasCredits) return null
  if (lastGoodUsage.get(profileId)?.credits) return null
  return live
}

/** Whether fetchAllAccountsUsage should count a profile toward the network
 *  stagger: active, and either primary/closed or an open account that cannot be
 *  served from its delivered figure. Primary keeps the network path (its creds
 *  are shared with the global CLI), exactly as the refresh guard excludes it. */
function accountUsageWillNetwork(profile: AccountProfile): boolean {
  if (!isAccountActive(profile)) return false
  if (profile.isPrimary) return true
  if (!isProfileInUseByLiveSession(profile.id)) return true
  return servableLiveUsage(profile.id) === null
}

/** Test seam: the live cache is module state and outlives a test file otherwise. */
export function _resetLiveUsageForTest(): void { liveUsageByProfile.clear() }

/** Test seam: reset the hydrate latch + last-good map so a test can seed fresh
 *  snapshots. Without it the once-per-process hydrate keeps the first test's view. */
export function _resetSnapshotsForTest(): void { lastGoodUsage.clear(); snapshotsLoaded = false }

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

/**
 * Fetch usage for one profile. Signed-out -> needs-login; signed-in but not
 * fetchable -> last-known (stale) or a soft refresh hint; success -> fresh.
 * Auto-refreshes a lapsed token (guarded) so idle accounts still show live usage.
 *
 * `noRefresh` suppresses the single-use refresh-token rotation entirely (#447):
 * the account-switch snapshot fires this the instant BEFORE the session
 * respawns onto the same profile, and the live-session guard cannot see that
 * imminent consumer yet — so a rotation here would spend the very token the
 * child is about to use and log the account out. With `noRefresh` a lapsed
 * token simply falls back to the last-known snapshot; a valid token still
 * fetches live. Never rotates, so it is always safe next to a spawn.
 */
export async function fetchAccountUsage(profileId: string, opts?: { noRefresh?: boolean }): Promise<AccountUsage> {
  hydrateSnapshots()
  const profiles = listProfiles()
  const profile = profiles.find((p) => p.id === profileId)
  const isPrimary = !!profile?.isPrimary
  const active = profile ? isAccountActive(profile) : true
  const base: AccountUsage = {
    profileId,
    email: profile?.accountEmail || readProfileAccountEmail(profileId),
    name: profile?.name || 'Account',
    isPrimary,
    active,
    status: 'error',
    buckets: [],
    fetchedAt: Date.now(),
  }
  if (!profile) return { ...base, detail: 'unknown profile' }

  // Parked account: list it, but do NO network poll and NO token refresh. A
  // refresh rotates the single-use token — doing that to an account the user
  // deliberately parked is the opposite of parked, and burns a request against
  // the IP burst limit for a card that only needs to say "inactive". Return
  // before readProfileToken/refresh/fetch so none of that runs.
  if (!active) return { ...base, status: 'inactive' }

  // OPEN account (plan P2): a live session is using this profile, so its usage
  // was just delivered by that session's statusline -- reuse it and make no call.
  // Primary is excluded (its creds are shared with the global CLI; it keeps the
  // network path). `servableLiveUsage` returns null when there is nothing fresh
  // to serve or the page would show a credits row the delivered figure cannot
  // carry (Q1b), in which case we fall through to the GET below. The refresh
  // guard there already forbids a rotation while in use, so any fall-through is a
  // read with the live token, never a token rotation.
  if (!isPrimary && isProfileInUseByLiveSession(profileId)) {
    const live = servableLiveUsage(profileId)
    if (live) return { ...base, status: 'ok', stale: false, buckets: live.buckets, fetchedAt: live.fetchedAt }
  }

  const creds = await readProfileToken(profileId, isPrimary)
  let token = creds.token
  let expiresAt = creds.expiresAt
  // 60s skew guard: a token within 60s of expiry is treated as unusable so we
  // don't burn a request that will 401.
  let tokenUsable = !!token && !(expiresAt > 0 && expiresAt < Date.now() + 60_000)

  // Auto-refresh a lapsed token so an idle-but-signed-in account still shows live
  // usage without opening a session. GUARDS (all must hold): signed in, we have a
  // refresh token + the creds path to write back, the token is actually lapsed,
  // NOT the primary profile, and no live session is using this profile. Refresh
  // tokens rotate (single-use), so a careless refresh here logs the account out:
  //  - PRIMARY is excluded outright: its credentials are shared with the global
  //    ~/.claude (credsPath can literally BE the global file), which `claude` runs
  //    OUTSIDE CCC read — rotating under them strands every external terminal.
  //    Non-primary profiles live in CCC-managed isolated homes, so their only
  //    consumers are things CCC knows about, and the live-session guard below
  //    covers them.
  //  - isProfileInUseByLiveSession covers interactive sessions (the identity
  //    maps) AND every registered consumer in profile-consumers.ts: the
  //    `claude auth status` probe (#258), and since #48 the headless spawner,
  //    Insights runs, cloud agents and the profile-pinned shell-only shells
  //    (plain shells + the add-account /login shell) -- each of which reads,
  //    and can rotate, the profile's token for as long as it runs.
  //  - The other ordering (#49) is closed by the refresh itself: it publishes
  //    its in-flight promise (noteProfileRefreshInFlight) and a consumer that
  //    starts mid-rotation waits for it (waitForProfileRefresh) before reading
  //    the credential file.
  if (!opts?.noRefresh && !tokenUsable && creds.signedIn && creds.refreshToken && creds.credsPath && !isPrimary && !isProfileInUseByLiveSession(profileId)) {
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
    saveSnapshots(lastGoodUsage)
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
  // Stagger only between accounts that actually hit the network. A parked
  // account short-circuits in fetchAccountUsage (no request), so it must not
  // consume a stagger slot — otherwise N parked accounts add N*STAGGER_MS of
  // dead wait before the active ones load.
  let networkedCount = 0
  for (const p of profiles) {
    // An OPEN account served from its delivered figure (plan P2) makes no request,
    // so -- like a parked account -- it must not consume a stagger slot, or N open
    // accounts would add N*STAGGER_MS of dead wait before a closed one loads.
    const willNetwork = accountUsageWillNetwork(p)
    if (willNetwork && networkedCount > 0) await sleep(STAGGER_MS)
    out.push(await fetchAccountUsage(p.id))
    if (willNetwork) networkedCount++
  }
  return out
}
