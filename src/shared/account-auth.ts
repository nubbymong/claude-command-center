// account-auth.ts — what a profile's stored credentials say about its sign-in.
//
// Two expiries live in `.credentials.json` and conflating them produces a wrong,
// alarming UI:
//
//   expiresAt             the ACCESS token. Measured on real profiles: 0.5-7.8
//                         hours. Refreshed automatically; the user never sees it.
//   refreshTokenExpiresAt the REFRESH token. This is the one whose expiry forces
//                         an interactive login. Measured: 1.0 to 27.4 days.
//
// Only the second belongs in a countdown. "Your sign-in expires in 30 minutes" is
// false when the access token is about to renew itself.

/** What one profile's stored credentials say. Read from disk, no network. */
export interface ProfileAuthInfo {
  profileId: string
  /** Identity recorded in profiles.json for this profile. */
  accountEmail?: string
  /** Identity recorded INSIDE the profile's own home (.claude.json oauthAccount). */
  oauthEmail?: string
  /** No readable/parseable .credentials.json in this profile's home. */
  credentialsMissing?: boolean
  hasRefreshToken?: boolean
  /** Access-token expiry, epoch ms. Auto-renewed; not a user-facing countdown. */
  expiresAt?: number
  /** Refresh-token expiry, epoch ms. THIS is what forces an interactive login. */
  refreshTokenExpiresAt?: number
  subscriptionType?: string
  /**
   * When the credentials file was last written, epoch ms. This is how a past
   * failure gets retired: a run that failed authentication is only still relevant
   * if the credentials have NOT been rewritten since. Without it, signing in
   * cannot clear a warning derived from run history, because signing in does not
   * produce a new run.
   */
  credentialsUpdatedAt?: number
  /**
   * profiles.json and the profile's own home disagree about which account this
   * is — the home is authoritative, so the label is wrong.
   */
  identityMismatch?: boolean
  /**
   * ANOTHER profile's home resolves to the same account. This is the one that
   * actually hurts: refreshing in one home rotates the OAuth refresh token and
   * invalidates the copies in the others, so the duplicates start failing with
   * "OAuth session expired and could not be refreshed".
   *
   * Detected separately from `identityMismatch` on purpose. `refreshIdentity`
   * OVERWRITES profiles.json's accountEmail with whatever the home reports
   * (account-profiles-handlers.ts), so a wrong sign-in silently RELABELS the
   * profile and the divergence disappears — while the duplication remains. A
   * divergence-only check would go quiet exactly when the damage is done.
   */
  duplicateOfProfileIds?: string[]
}

export type AuthWindowTone = 'expired' | 'critical' | 'warning' | 'ok' | 'unknown'

export interface AuthWindow {
  /** Whole days until a forced interactive login. Null when not derivable. */
  daysUntilForcedLogin: number | null
  tone: AuthWindowTone
  /** Ready-to-render sentence. Never mentions the access token. */
  label: string
}

/**
 * Does a past authentication failure still describe reality?
 *
 * A run that failed with an auth error is stale the moment the credentials are
 * rewritten — i.e. the moment the user signs in. Signing in does NOT create a new
 * Insights run, so anything keyed purely on run history would keep warning
 * forever. This is the retirement rule.
 */
export function authFailureStillApplies(
  runTimestamp: number,
  info: Pick<ProfileAuthInfo, 'credentialsUpdatedAt' | 'credentialsMissing'> | undefined
): boolean {
  if (!info) return true // nothing known about the credentials; keep the warning
  if (info.credentialsMissing) return true
  if (typeof info.credentialsUpdatedAt !== 'number') return true
  return info.credentialsUpdatedAt <= runTimestamp
}

/** Under this many days, the countdown is red. */
const CRITICAL_DAYS = 2
/** Under this many days, the countdown is amber. */
const WARNING_DAYS = 7

const DAY_MS = 86400000

/**
 * Describe how long until this profile forces an interactive login.
 *
 * `now` is injected so this is testable against a fixed clock rather than the
 * wall clock. Pure, and shared so main and renderer cannot disagree about what a
 * given credential state means.
 */
export function describeAuthWindow(info: Pick<ProfileAuthInfo, 'credentialsMissing' | 'hasRefreshToken' | 'refreshTokenExpiresAt'>, now: number): AuthWindow {
  if (info.credentialsMissing) {
    return { daysUntilForcedLogin: null, tone: 'expired', label: 'Not signed in' }
  }
  if (info.hasRefreshToken === false) {
    return { daysUntilForcedLogin: null, tone: 'expired', label: 'Sign-in incomplete — no refresh token stored' }
  }
  const expiry = info.refreshTokenExpiresAt
  if (typeof expiry !== 'number' || !Number.isFinite(expiry) || expiry <= 0) {
    // Older credential files predate refreshTokenExpiresAt. Say nothing rather
    // than guess: a fabricated countdown is worse than no countdown.
    return { daysUntilForcedLogin: null, tone: 'unknown', label: 'Sign-in valid — renewal date unknown' }
  }

  const remainingMs = expiry - now
  if (remainingMs <= 0) {
    return { daysUntilForcedLogin: 0, tone: 'expired', label: 'Sign-in expired — needs signing in again' }
  }

  const days = Math.floor(remainingMs / DAY_MS)
  const tone: AuthWindowTone = days < CRITICAL_DAYS ? 'critical' : days < WARNING_DAYS ? 'warning' : 'ok'

  if (days < 1) {
    const hours = Math.max(1, Math.round(remainingMs / 3600000))
    return {
      daysUntilForcedLogin: 0,
      tone: 'critical',
      label: `Forced sign-in in ${hours} hour${hours === 1 ? '' : 's'}`
    }
  }
  return {
    daysUntilForcedLogin: days,
    tone,
    label: `Forced sign-in in ${days} day${days === 1 ? '' : 's'}`
  }
}
