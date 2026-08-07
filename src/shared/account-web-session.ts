/**
 * account-web-session.ts — shared types for the per-account claude.ai web session (#216).
 *
 * Dependency-free (no node, no electron): both processes import it.
 *
 * WHY THIS EXISTS. A CCC session authenticates to the Claude Code CLI with an
 * OAuth token, but three things the app wants — importing an organisation-scoped
 * share, listing a secondary account's conversations, and opening artifacts as
 * the account that produced them — are claude.ai WEB features, and the web
 * backend does not accept that token. Verified 2026-08-04:
 *
 *   GET https://claude.ai/api/organizations        Bearer <oauth>  -> 403
 *   GET https://claude.ai/api/bootstrap             Bearer <oauth>  -> 200, account: False
 *   GET https://api.anthropic.com/api/oauth/profile Bearer <oauth>  -> 200
 *
 * `account: False` on an authenticated bootstrap is the proof: the token is for
 * `api.anthropic.com`, not `claude.ai`. There is no way to derive the web
 * session from it, so the web session has to be acquired separately — once per
 * account, in the user's own browser.
 *
 * No default export (project convention).
 */

/** Where a web session came from. Recorded so a stale one can be explained. */
export type WebSessionOrigin = 'system-browser'

/**
 * How an account signs in to the Claude Code CLI.
 *
 * PER ACCOUNT, because it genuinely varies: an org account goes through SSO, a
 * personal subscription does not, and a Console account bills API usage instead
 * of using a subscription. These are the flows `claude auth login` actually
 * offers (`--claudeai` (default) / `--console` / `--sso`), read off its own
 * `--help` rather than assumed.
 *
 * Defaulting every account to `sso` — as the first cut did — is wrong for anyone
 * whose account is not an SSO one, and it fails in a confusing place: at the
 * identity provider, not in CCC.
 */
export type CliAuthMethod = 'claudeai' | 'console' | 'sso'

export const CLI_AUTH_METHODS: readonly CliAuthMethod[] = ['claudeai', 'sso', 'console']

/** The default when an account has never been told otherwise. */
export const DEFAULT_CLI_AUTH_METHOD: CliAuthMethod = 'claudeai'

/** Human labels for the picker. */
export const CLI_AUTH_METHOD_LABELS: Record<CliAuthMethod, string> = {
  claudeai: 'Claude subscription',
  sso: 'Single sign-on (SSO)',
  console: 'Anthropic Console (API billing)',
}

/** True when the value is one of the CLI's actual choices. */
export function isCliAuthMethod(v: unknown): v is CliAuthMethod {
  return typeof v === 'string' && (CLI_AUTH_METHODS as readonly string[]).includes(v)
}

/**
 * Which system browser completes an account's claude.ai sign-in.
 *
 * PER ACCOUNT AND USER-CHOSEN, because the browsers are not interchangeable for
 * SSO and the difference is invisible until the login fails. Measured on the
 * target managed workstation, 2026-08-06:
 *
 *   Chrome  ExtensionInstallForcelist (HKCU) forces `Microsoft Single Sign On`.
 *           A FRESH profile — which this feature creates by design — does not
 *           have it yet: Chrome fetches force-installed extensions
 *           asynchronously after launch, so claude.ai loads before the
 *           extension exists and the SSO step fails.
 *   Edge    Does Entra SSO natively, with no extension to wait for. A fresh
 *           profile completed the login. Verified by hand.
 *
 * So Edge is the default. It stays a CHOICE rather than a hardcoded switch
 * because neither the policy nor the identity provider is CCC's to assume: an
 * account on a personal machine, an org that forces Chrome, or a box with no
 * Edge at all all want the other answer.
 */
export type AuthBrowser = 'chrome' | 'edge'

export const AUTH_BROWSERS: readonly AuthBrowser[] = ['edge', 'chrome']

/**
 * The default when an account has never been told otherwise.
 *
 * Edge, because it is the one verified to complete an SSO login in a fresh
 * profile. `resolveBrowserBinary` still falls back when it is absent.
 */
export const DEFAULT_AUTH_BROWSER: AuthBrowser = 'edge'

/** Human labels for the picker. */
export const AUTH_BROWSER_LABELS: Record<AuthBrowser, string> = {
  edge: 'Microsoft Edge',
  chrome: 'Google Chrome',
}

/** True when the value names a browser this app can drive. */
export function isAuthBrowser(v: unknown): v is AuthBrowser {
  return typeof v === 'string' && (AUTH_BROWSERS as readonly string[]).includes(v)
}

export interface AccountWebSession {
  /** The account profile this session belongs to. Never shared between accounts. */
  profileId: string
  /** claude.ai account email as reported by the session itself, for display. */
  accountEmail: string | null
  /** Epoch ms when the cookies were harvested. */
  acquiredAt: number
  /** Earliest expiry across the harvested cookies, epoch ms; null when unknown. */
  expiresAt: number | null
  origin: WebSessionOrigin
}

/**
 * The Electron partition that holds one account's claude.ai cookies.
 *
 * ONE PARTITION PER ACCOUNT is the whole isolation model — a shared partition
 * would let a session running as account B read account A's claude.ai cookies,
 * which is the failure this feature must not introduce. The profile id is
 * already a filesystem-safe `profile-<random>` (it is used as an on-disk
 * directory name), and it is re-validated here anyway: this string names a
 * security boundary, so it does not get to be whatever the caller passed.
 */
export function webPartitionForProfile(profileId: string): string {
  if (!PROFILE_ID_RE.test(profileId)) {
    throw new Error(`refusing to build a web partition for an unexpected profile id: ${profileId}`)
  }
  return `persist:claude-web-${profileId}`
}

/** `profile-<alnum/dash>`, matching the on-disk account-profile directory name. */
export const PROFILE_ID_RE = /^profile-[A-Za-z0-9-]{1,64}$/

/** Hosts whose cookies are harvested. Nothing else is ever copied out of the browser. */
export const CLAUDE_COOKIE_HOSTS = ['claude.ai', '.claude.ai'] as const

/**
 * The cookie that actually carries the claude.ai web session. Harvesting is
 * scoped rather than "copy every cookie the browser has": the browser profile
 * is the user's, and a wholesale copy would sweep up unrelated sites' sessions
 * into CCC's storage for no benefit.
 */
export const CLAUDE_SESSION_COOKIE = 'sessionKey'
