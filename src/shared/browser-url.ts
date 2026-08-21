/**
 * The browser pane's ONE rule for what it will load, shared by every door in:
 * the address bar, the "Open a page" command kind, the command dialog's URL
 * fields and the main-process IPC handlers. http and https only -- the pane
 * loads arbitrary user URLs inside a sandboxed WebContentsView, and anything
 * else (file://, chrome://, javascript:, custom protocols) is either the local
 * filesystem, privileged Chromium internals, or script.
 *
 * Kept in shared/ so the renderer's inline validation and main's hard gate
 * cannot drift: a URL the address bar accepts is a URL main accepts, and a URL
 * main refuses is one the address bar already refused with a reason.
 */

export const BROWSER_URL_MAX_LENGTH = 4096

/** What main reports about a session's view whenever it moves: the page it
 *  is actually on (after redirects), its title, and whether the history
 *  buttons have anywhere to go. */
export interface WebviewNavState {
  sessionId: string
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
}
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:'])

/** True when `value` parses as a URL and uses http or https. The gate main applies. */
export function isAllowedBrowserUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > BROWSER_URL_MAX_LENGTH) return false
  try {
    return ALLOWED_PROTOCOLS.has(new URL(value).protocol)
  } catch {
    return false
  }
}

/** Hosts a scheme-less address is assumed to mean over plain http: loopback
 *  and private-network addresses, i.e. the local dev servers the pane exists
 *  for. Everything else gets https. */
export function isLocalNetworkHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0') return true
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  const a = Number(m[1]), b = Number(m[2])
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)
}

export type BrowserInputResult = { ok: true; url: string } | { ok: false; error: string }

/**
 * Turn what someone typed into an address bar into a URL the pane may load.
 *
 * - trims; empty is an error
 * - no scheme -> `http://` for localhost / loopback, `https://` otherwise
 *   (typing `localhost:5173` or `example.com` must just work)
 * - any scheme other than http/https is refused BY NAME so the reason is on
 *   screen, not a silent no-op
 * - the result is the parsed `href`, never the raw input, so main is handed a
 *   normalised string
 */
export function normaliseBrowserInput(raw: string): BrowserInputResult {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { ok: false, error: 'Type an address' }
  if (trimmed.length > BROWSER_URL_MAX_LENGTH) return { ok: false, error: 'That address is too long' }

  // A scheme is `letters[letters/digits/+/-/.]*:`. `localhost:5173` matches
  // that shape (scheme "localhost"), so treat a scheme whose "path" starts
  // with digits as host:port and a bare word with a dot or a port as a host.
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/.exec(trimmed)
  let candidate = trimmed
  if (!schemeMatch || /^\d+(\/|$|\?|#)/.test(schemeMatch[2])) {
    // No scheme (or host:port). Decide http vs https from the host.
    const hostPart = trimmed.replace(/^\/\//, '').split(/[/?#]/)[0]
    const hostOnly = hostPart.replace(/:\d+$/, '')
    candidate = `${isLocalNetworkHost(hostOnly) ? 'http' : 'https'}://${trimmed.replace(/^\/\//, '')}`
  }

  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return { ok: false, error: 'That is not an address the browser can open' }
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, error: `Only http and https pages can be opened here (not ${parsed.protocol.replace(/:$/, '')})` }
  }
  if (!parsed.hostname) return { ok: false, error: 'That address has no host' }
  return { ok: true, url: parsed.href }
}

/** A short, human label for a URL: host plus a trimmed path. For favourites and tooltips. */
export function shortUrlLabel(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')
    return `${u.host}${path}`
  } catch {
    return url
  }
}
