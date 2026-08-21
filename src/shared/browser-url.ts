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
 *
 * Two gates, deliberately different:
 * - `isAllowedBrowserUrl` is for a URL the APP is about to hand to the view
 *   (address bar, favourites, home, a command, the IPC): scheme, no embedded
 *   credentials, and a length cap on the SERIALISED href.
 * - `isAllowedBrowserScheme` is for a navigation the PAGE started (a link, a
 *   form, a redirect): scheme only. An OAuth or SAML hop routinely carries a
 *   URL longer than any cap, and cancelling a will-redirect aborts the whole
 *   navigation -- the cap is an input-hygiene rule, not a security one
 *   (Chromium caps URL length itself), so it must not sit on that path.
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

/** True when `value` parses as a URL using http or https. Nothing else is
 *  checked -- this is the gate for navigations the PAGE starts. */
export function isAllowedBrowserScheme(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    return ALLOWED_PROTOCOLS.has(new URL(value).protocol)
  } catch {
    return false
  }
}

/** True when `value` is a URL the app may hand to the view: http(s), no
 *  embedded user name or password, and a serialised href within the cap. */
export function isAllowedBrowserUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > BROWSER_URL_MAX_LENGTH) return false
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return false
  if (parsed.username || parsed.password) return false
  return parsed.href.length <= BROWSER_URL_MAX_LENGTH
}

/** Hosts a scheme-less address is assumed to mean over plain http: loopback
 *  and private-network addresses, i.e. the local dev servers the pane exists
 *  for. Everything else gets https. Give it the CANONICAL hostname (what
 *  `new URL().hostname` returns -- dotted-quad, bracketed IPv6, lower-cased),
 *  not what was typed: `0177.0.0.1`, `127.1` and `2130706433` are all
 *  127.0.0.1 to the URL parser, and `010.0.0.1` is 8.0.0.1, not a 10/8 host. */
export function isLocalNetworkHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost') || h === '::1' || h === '0.0.0.0') return true
  // IPv4-mapped IPv6. The URL parser serialises `[::ffff:127.0.0.1]` as
  // `[::ffff:7f00:1]`, so the canonical form is the HEX one; accept both.
  if (/^::ffff:(\d{1,3}\.){3}\d{1,3}$/.test(h)) return isLocalNetworkHost(h.slice('::ffff:'.length))
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h)
  if (mapped) {
    const hi = parseInt(mapped[1], 16), lo = parseInt(mapped[2], 16)
    return isLocalNetworkHost(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`)
  }
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
 * - no scheme -> `http://` for localhost / loopback / private-network hosts,
 *   `https://` otherwise (typing `localhost:5173` or `example.com` must just
 *   work). The decision is made on the host the URL parser actually resolves,
 *   never on the typed text, so the scheme always matches the host loaded
 * - any scheme other than http/https is refused BY NAME so the reason is on
 *   screen, not a silent no-op; so is an embedded user name or password
 * - the result is the parsed `href`, never the raw input, so main is handed a
 *   normalised string; the length cap is applied to that href
 */
export function normaliseBrowserInput(raw: string): BrowserInputResult {
  let trimmed = (raw ?? '').trim()
  if (!trimmed) return { ok: false, error: 'Type an address' }
  if (trimmed.length > BROWSER_URL_MAX_LENGTH) return { ok: false, error: 'That address is too long' }
  // The common typo `http//host` (colon dropped) would otherwise read as a
  // scheme-less host called "http" and come out as https://http//host.
  trimmed = trimmed.replace(/^(https?)\/\//i, '$1://')

  // A scheme is `letters[letters/digits/+/-/.]*:`. `localhost:5173` matches
  // that shape (scheme "localhost"), so treat a scheme whose "path" starts
  // with digits as host:port and a bare word with a dot or a port as a host.
  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.*)$/.exec(trimmed)
  let candidate = trimmed
  let schemeless = false
  if (!schemeMatch || /^\d+(\/|$|\?|#)/.test(schemeMatch[2])) {
    // No scheme (or host:port). Parse as https first to learn the canonical
    // host, then decide http vs https from THAT host.
    schemeless = true
    candidate = `https://${trimmed.replace(/^\/\//, '')}`
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
  if (parsed.username || parsed.password) {
    return { ok: false, error: 'Addresses with a user name or password are not opened here' }
  }
  if (schemeless && isLocalNetworkHost(parsed.hostname)) {
    // Same canonical host, plain http. Re-parse rather than string-replace so
    // a default port (`:443` dropped by the https parse) cannot sneak back.
    try {
      parsed = new URL(`http://${trimmed.replace(/^\/\//, '')}`)
    } catch {
      return { ok: false, error: 'That is not an address the browser can open' }
    }
  }
  if (parsed.href.length > BROWSER_URL_MAX_LENGTH) return { ok: false, error: 'That address is too long' }
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

/** Code-point ranges the pane must never RENDER in a label: C0/C1 controls,
 *  zero-width and bidi controls, line/paragraph separators, bidi
 *  embeddings/overrides/isolates, word joiners, the BOM. Expressed as numbers,
 *  not escapes, so the rule is readable and no invisible character lives in
 *  this source file. */
const CONTROL_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x001f], [0x007f, 0x009f], [0x200b, 0x200f], [0x2028, 0x202e],
  [0x2060, 0x2064], [0x2066, 0x206f], [0xfeff, 0xfeff],
]

function isControlCodePoint(cp: number): boolean {
  for (const [lo, hi] of CONTROL_RANGES) if (cp >= lo && cp <= hi) return true
  return false
}

/** Text the pane will RENDER (favourite titles, page titles): control and
 *  format characters removed, bounded to `max` code units. */
export function cleanDisplayText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  let out = ''
  for (const ch of value) {
    if (!isControlCodePoint(ch.codePointAt(0) ?? 0)) out += ch
  }
  return out.slice(0, max)
}
