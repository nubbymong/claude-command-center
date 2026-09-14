/**
 * cookie-harvest.ts — turn CDP cookies from the system browser into Electron
 * cookies for one account's partition (#216).
 *
 * PURE by design: no electron, no CDP, no network. The security decisions —
 * which cookies leave the user's browser, and what they become — are the part
 * worth testing, and they should be testable without launching anything.
 *
 * The trust story: the user completes SSO in their OWN browser (which is the
 * point — a compliance-mandated extension lives there and not in an Electron
 * window), CCC reads the claude.ai cookies over CDP from a browser IT launched
 * with a dedicated profile, and injects them into that account's partition.
 * CCC never reads the user's normal browser profile, and never copies a cookie
 * belonging to any other site.
 *
 * No default export (project convention).
 */

import { CLAUDE_COOKIE_HOSTS, CLAUDE_SESSION_COOKIE } from '../../shared/account-web-session'

/** The subset of a CDP `Network.Cookie` this code depends on. */
export interface CdpCookie {
  name: string
  value: string
  domain: string
  path: string
  /** CDP reports seconds since epoch; -1 or absent means a session cookie. */
  expires?: number
  httpOnly?: boolean
  secure?: boolean
  sameSite?: string
}

/** The shape Electron's `session.cookies.set()` takes. */
export interface ElectronCookie {
  url: string
  name: string
  value: string
  /**
   * Omitted for a `__Host-` cookie, which is host-only BY DEFINITION: Chromium
   * rejects the prefix outright when a domain attribute is present.
   */
  domain?: string
  path: string
  secure: boolean
  httpOnly: boolean
  /** Electron takes seconds since epoch; omitted entirely for a session cookie. */
  expirationDate?: number
  sameSite?: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
}

/** True when a cookie belongs to claude.ai and nothing else. */
export function isClaudeCookie(c: Pick<CdpCookie, 'domain'>): boolean {
  const d = (c.domain ?? '').toLowerCase()
  // Exact host or the dot-prefixed parent — NOT a suffix test, which would
  // accept `claude.ai.attacker.example`.
  return (CLAUDE_COOKIE_HOSTS as readonly string[]).includes(d)
}

/** CDP's sameSite spelling -> Electron's. Unknown values fall back to unspecified. */
export function mapSameSite(v: string | undefined): ElectronCookie['sameSite'] {
  switch ((v ?? '').toLowerCase()) {
    case 'none': return 'no_restriction'
    case 'lax': return 'lax'
    case 'strict': return 'strict'
    default: return 'unspecified'
  }
}

/**
 * Convert one CDP cookie. Returns null for anything that must not be carried
 * over — an empty name, or a non-claude.ai domain that slipped through.
 */
export function toElectronCookie(c: CdpCookie): ElectronCookie | null {
  if (!c || !c.name || !isClaudeCookie(c)) return null

  const host = c.domain.replace(/^\./, '')

  // COOKIE PREFIXES ARE RULES, NOT DECORATION. Chromium enforces them on set,
  // and copying a prefixed cookie across verbatim fails its own rule: observed
  // 2026-08-08, `__Host-claude-ai-pending-login-email` was refused with
  // EXCLUDE_INVALID_PREFIX because we passed a domain. `__Host-` means
  // host-only, path `/`, secure; `__Secure-` means secure. Both are satisfied
  // here rather than passed through and rejected.
  const hostPrefixed = c.name.startsWith('__Host-')
  const securePrefixed = c.name.startsWith('__Secure-')
  const secure = hostPrefixed || securePrefixed ? true : c.secure !== false
  const path = hostPrefixed ? '/' : (c.path || '/')

  const out: ElectronCookie = {
    // Electron derives the store key from the url; claude.ai is https-only.
    url: `https://${host}${path !== '/' ? path : ''}`,
    name: c.name,
    value: c.value ?? '',
    path,
    secure,
    httpOnly: c.httpOnly === true,
    sameSite: mapSameSite(c.sameSite),
  }
  if (!hostPrefixed) out.domain = c.domain
  // A session cookie (expires -1 / absent) must NOT get an expirationDate, or
  // Electron turns it into a persistent one that outlives the browser session
  // it came from.
  if (typeof c.expires === 'number' && c.expires > 0) out.expirationDate = c.expires
  return out
}

/**
 * The subset of an Electron `Cookie` (as returned by `session.cookies.get`) this
 * code reads. Used by the in-app sign-in path, where the user signs in DIRECTLY
 * in the account's partition, so the session cookie is already in Electron's own
 * store — there is nothing to convert or inject, only to read back.
 */
export interface ElectronReadCookie {
  name: string
  /** Electron reports seconds since epoch; absent for a session cookie. */
  expirationDate?: number
  /** True for a session cookie (no persistent expiry of its own). */
  session?: boolean
}

/**
 * PURE: decide whether an account's partition holds a usable claude.ai web
 * session, from the cookies Electron reports for it.
 *
 * Mirrors `harvestClaudeCookies`'s success rule exactly — `sessionKey` present is
 * the only meaningful signal, and the session's lifetime is `sessionKey`'s and
 * nothing else's (NOT the earliest expiry across the jar, which would report a
 * fresh session as half-expired the moment a 30-minute `__cf_bm` landed). Kept
 * pure so the in-app path's completion rule is testable without Electron.
 */
export function webSessionFromElectronCookies(
  cookies: readonly ElectronReadCookie[],
): { hasSessionCookie: boolean; expiresAt: number | null } {
  const session = (cookies ?? []).find((c) => c?.name === CLAUDE_SESSION_COOKIE)
  if (!session) return { hasSessionCookie: false, expiresAt: null }
  // Electron seconds -> epoch ms, matching everything else in the app. A session
  // cookie (no expirationDate / session:true) reports null, treated as active.
  const exp = session.expirationDate
  return {
    hasSessionCookie: true,
    expiresAt: typeof exp === 'number' && exp > 0 ? exp * 1000 : null,
  }
}

export interface HarvestResult {
  cookies: ElectronCookie[]
  /** True when the cookie that actually carries the session is present. */
  hasSessionCookie: boolean
  /**
   * When the SESSION cookie expires, epoch MS; null when it is a session cookie
   * (no expiry of its own).
   *
   * The session's lifetime is `sessionKey`'s lifetime and nothing else. This
   * used to be the EARLIEST expiry across every harvested cookie, which sounds
   * conservative and is simply wrong: the jar contains infrastructure cookies
   * with short lives — `__cf_bm` is Cloudflare's and lasts 30 minutes — so a
   * freshly harvested, perfectly good session reported half an hour of life and
   * `statusOf` would then call it expired. Observed 2026-08-08.
   */
  expiresAt: number | null
  /** How many input cookies were dropped for not being claude.ai's. */
  dropped: number
}

/**
 * Filter and convert a browser's cookie jar down to one account's claude.ai
 * session.
 *
 * `hasSessionCookie` is the meaningful success signal — a jar full of analytics
 * cookies with no `sessionKey` is not a session, and injecting it would leave
 * the partition looking authenticated while every request 401s.
 */
export function harvestClaudeCookies(all: readonly CdpCookie[]): HarvestResult {
  const cookies: ElectronCookie[] = []
  let dropped = 0

  for (const c of all ?? []) {
    const mapped = toElectronCookie(c)
    if (mapped) cookies.push(mapped)
    else dropped++
  }

  const session = cookies.find((c) => c.name === CLAUDE_SESSION_COOKIE)
  const sessionExpiry = session?.expirationDate

  return {
    cookies,
    hasSessionCookie: session !== undefined,
    // CDP seconds -> epoch ms, to match everything else in the app.
    expiresAt: typeof sessionExpiry === 'number' && sessionExpiry > 0 ? sessionExpiry * 1000 : null,
    dropped,
  }
}
