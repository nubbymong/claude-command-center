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
  domain: string
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
  const secure = c.secure !== false
  const out: ElectronCookie = {
    // Electron derives the store key from the url; claude.ai is https-only.
    url: `https://${host}${c.path && c.path !== '/' ? c.path : ''}`,
    name: c.name,
    value: c.value ?? '',
    domain: c.domain,
    path: c.path || '/',
    secure,
    httpOnly: c.httpOnly === true,
    sameSite: mapSameSite(c.sameSite),
  }
  // A session cookie (expires -1 / absent) must NOT get an expirationDate, or
  // Electron turns it into a persistent one that outlives the browser session
  // it came from.
  if (typeof c.expires === 'number' && c.expires > 0) out.expirationDate = c.expires
  return out
}

export interface HarvestResult {
  cookies: ElectronCookie[]
  /** True when the cookie that actually carries the session is present. */
  hasSessionCookie: boolean
  /** Earliest expiry across persistent cookies, epoch MS; null when all are session cookies. */
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

  const expiries = cookies
    .map((c) => c.expirationDate)
    .filter((e): e is number => typeof e === 'number' && e > 0)

  return {
    cookies,
    hasSessionCookie: cookies.some((c) => c.name === CLAUDE_SESSION_COOKIE),
    // CDP seconds -> epoch ms, to match everything else in the app.
    expiresAt: expiries.length ? Math.min(...expiries) * 1000 : null,
    dropped,
  }
}
