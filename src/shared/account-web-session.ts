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

/**
 * Where a web session came from. Recorded so a stale one can be explained.
 *   - `system-browser`: signed in via a launched Chrome/Edge, cookies read over
 *     CDP and injected into the partition. Kept for SSO accounts, whose identity
 *     provider may need a policy-installed browser extension an in-app window
 *     lacks (see the AuthBrowser note below).
 *   - `in-app`: signed in directly inside an Electron window on the account's
 *     partition — no launched browser, no debug port. This avoids claude.ai's
 *     bot-detection, which flags the remote-debugging port `system-browser` uses
 *     (proven: a browser with that port open is challenged indefinitely; the same
 *     browser without it signs in cleanly). The default for non-SSO accounts.
 */
export type WebSessionOrigin = 'system-browser' | 'in-app' | 'in-pane'

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

/**
 * Where an account's claude.ai WEB sign-in runs (#439, owner call 2026-08-25).
 *
 * 'auto' is the shipped routing, UNCHANGED and the default forever: the
 * dedicated sign-in window for subscription/Console accounts (no launched
 * browser, no debug port — claude.ai's bot-detection flags that port), the
 * system browser for SSO (its identity provider may need a policy-installed
 * extension an Electron window cannot load).
 *
 * 'internal-pane' routes the Settings sign-in button into the baked-in
 * browser pane instead: the pane hosts a claude.ai-only view bound to this
 * ACCOUNT's partition (#475's surface), and the user signs in there once.
 *
 * Whichever runs, the session cookie lands in the account's own partition
 * (webPartitionForProfile), so every in-app surface bound to the account —
 * the artifacts window, the sign-in window, the pane's account view — sees
 * it with no copying.
 */
export type WebSignInMode = 'auto' | 'internal-pane'

export const WEB_SIGN_IN_MODES: readonly WebSignInMode[] = ['auto', 'internal-pane']

/** The default when an account has never been told otherwise: today's routing. */
export const DEFAULT_WEB_SIGN_IN_MODE: WebSignInMode = 'auto'

/** Human labels for the picker. */
export const WEB_SIGN_IN_MODE_LABELS: Record<WebSignInMode, string> = {
  auto: 'Sign-in window (default)',
  'internal-pane': 'Internal browser pane',
}

/** True when the value is a known sign-in mode. */
export function isWebSignInMode(v: unknown): v is WebSignInMode {
  return typeof v === 'string' && (WEB_SIGN_IN_MODES as readonly string[]).includes(v)
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

/**
 * `profile-<alnum/dash>`, matching the on-disk account-profile directory name.
 *
 * LOWERCASE ONLY, deliberately. `createProfile` has only ever emitted lowercase
 * (`profile-<base36 time>-<hex>`), and allowing uppercase created a genuine
 * ambiguity: two ids differing only in case name the SAME directory on
 * Windows — where the filesystem is case-insensitive — while
 * `webPartitionForProfile` treats them as two different accounts. One account's
 * sign-in could then take ownership of another's on-disk profile dir. Narrowing
 * the shape removes the ambiguity instead of teaching every consumer about it.
 */
export const PROFILE_ID_RE = /^profile-[a-z0-9-]{1,64}$/

/** Hosts whose cookies are harvested. Nothing else is ever copied out of the browser. */
export const CLAUDE_COOKIE_HOSTS = ['claude.ai', '.claude.ai'] as const

/**
 * The cookie that actually carries the claude.ai web session. Harvesting is
 * scoped rather than "copy every cookie the browser has": the browser profile
 * is the user's, and a wholesale copy would sweep up unrelated sites' sessions
 * into CCC's storage for no benefit.
 */
export const CLAUDE_SESSION_COOKIE = 'sessionKey'
