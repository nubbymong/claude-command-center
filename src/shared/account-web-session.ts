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

import { isOpaqueId } from './providers/ids'

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

/** The partition prefix of the `profile` id class: a Claude account's claude.ai web session. */
export const CLAUDE_WEB_PARTITION_PREFIX = 'persist:claude-web-'

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
  return `${CLAUDE_WEB_PARTITION_PREFIX}${profileId}`
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

/**
 * The web-session id classes (WP2 PR 4, P4.6, row 58). A Claude account's
 * web session is keyed by its account profile id (`profile`: PROFILE_ID_RE);
 * a provider account the provider registry holds is keyed by its registry
 * account id (`account`: `acct-<16..64 lowercase hex>`, the registry's own
 * pattern, shared/providers/ids.ts). The two shapes cannot overlap, so an id
 * names one class or neither, never both. Each class has its own partition
 * prefix (the `account` class's is CODEX_WEB_PARTITION_PREFIX, built by
 * webPartitionForCodexAccount), and a builder for one class refuses an id of
 * the other, as webPartitionForProfile refuses an `account` id.
 */
export type WebSessionIdClass = 'profile' | 'account'

/** True for a registry account id, the `account` class. */
export function isWebSessionAccountId(id: unknown): id is string {
  return isOpaqueId(id, 'account')
}

/** The class an id belongs to, or null when it is neither. */
export function webSessionIdClass(id: unknown): WebSessionIdClass | null {
  if (typeof id !== 'string') return null
  if (PROFILE_ID_RE.test(id)) return 'profile'
  if (isWebSessionAccountId(id)) return 'account'
  return null
}

/**
 * The partition prefix of the `account` id class: a Codex account's own
 * chatgpt.com web session (P4.6, row 58). Its own prefix, so a partition of
 * one class can never be named like one of the other: neither prefix starts
 * the other, whatever the ids.
 */
export const CODEX_WEB_PARTITION_PREFIX = 'persist:codex-web-'

/**
 * The Electron partition that holds one Codex account's chatgpt.com cookies.
 *
 * The same isolation model as webPartitionForProfile: one partition per
 * account, keyed by the account's registry id and re-validated here against
 * the registry's own id pattern (`acct-<16..64 lowercase hex>`), because this
 * string names a security boundary. A Claude profile id, or anything else off
 * that pattern, is refused, never sanitised into some other account's name.
 *
 * The pattern is the shape only: a registry account of any provider has such
 * an id, so a caller that materialises the partition (the sign-in window and
 * the pane's account surface, after the owner's OR2a run) first confirms from
 * the registry that the account is a Codex account.
 *
 * Nothing is ever copied into this partition from the user's browser: it is
 * filled only by a sign-in inside an app window on it (WP1 design principle
 * 4). Claude's cookie copy (cookie-harvest.ts, the SSO route of sign-in.ts)
 * is keyed by profile id and builds its partition with webPartitionForProfile,
 * which refuses an account id, so it cannot reach this one.
 */
export function webPartitionForCodexAccount(accountId: string): string {
  if (!isWebSessionAccountId(accountId)) {
    const raw: unknown = accountId
    const shown = typeof raw === 'string' ? JSON.stringify(raw.slice(0, 80)) : typeof raw
    throw new Error(`refusing to build a web partition for an unexpected account id: ${shown}`)
  }
  return `${CODEX_WEB_PARTITION_PREFIX}${accountId}`
}

/** The two prefixes as Electron's on-disk directory names (see below). */
const WEB_SESSION_PARTITION_DIR_PREFIXES: readonly string[] = [CLAUDE_WEB_PARTITION_PREFIX, CODEX_WEB_PARTITION_PREFIX]
  .map((prefix) => prefix.slice('persist:'.length))

/**
 * Whether a directory under `<sessionData>/Partitions` holds one of the two
 * web-session partitions. Electron keeps a `persist:<name>` partition in a
 * directory named `<name>`, lower-cased and path-escaped; every id both
 * builders accept is already lower case and path-safe, so the directory is
 * the partition name without `persist:`. Matched by prefix, as the dev
 * start's orphan warning always matched Claude's (account-web/orphan-partitions.ts).
 *
 * The prefix alone is enough for a warning that only lists. It never checks
 * the rest of the name, so it must never become a deletion check: anything
 * that removes a partition directory validates the whole name against its id
 * class (PROFILE_ID_RE, isWebSessionAccountId) instead.
 */
export function isWebSessionPartitionDir(name: string): boolean {
  return typeof name === 'string' && WEB_SESSION_PARTITION_DIR_PREFIXES.some((prefix) => name.startsWith(prefix))
}

/**
 * The web services an account's web session can be on (P4.6, row 58).
 * chatgpt.com is to a Codex account what claude.ai is to a Claude account.
 */
export type WebSessionService = 'claude' | 'codex'

/**
 * What the app needs to know about one service's web sign-in, in ONE place.
 *
 * Three of these values are NOT verified yet: the session cookie name(s), the
 * identity read, and the hosts the sign-in methods visit. They come from public
 * knowledge, not from a recorded sign-in, and the owner's sign-in run confirms
 * them (completion plan, P4.6). The design makes a wrong guess fail CLOSED:
 * completion needs the named session cookie AND a valid email from the
 * identity read, so a wrong cookie name or identity read means the sign-in
 * never completes and the partition is wiped, never a false "signed in"; and a
 * wrong host list means a sign-in method is blocked, never that the window may
 * go anywhere. A run that does not complete logs the cookie NAMES it found and
 * the off-site hosts it saw (never values, never query strings), so even a
 * failed owner run yields the right values.
 */
export interface WebServiceDescriptor {
  readonly service: WebSessionService
  /** The name shown to the user (window title, pane strip). */
  readonly label: string
  /** The one origin the identity read trusts. */
  readonly origin: string
  /** The service's own hosts (https, default port). */
  readonly hosts: readonly string[]
  /** Where the pane's account view starts. */
  readonly startUrl: string
  /** Where the sign-in window starts. */
  readonly signInUrl: string
  /** The cookie(s) that carry the signed-in session on `origin`. */
  readonly sessionCookieNames: readonly string[]
  /** Same-origin path whose JSON answer names the signed-in account. */
  readonly identityPath: string
  /** The property path to the email inside that JSON answer. */
  readonly identityEmailPath: readonly string[]
  /** The ONLY off-site hosts the sign-in window (and a signed-out pane) may go
   *  to: the sign-in methods' own hosts. Never "any https host". */
  readonly signInHosts: readonly string[]
}

/**
 * chatgpt.com, for a Codex account's web session.
 *
 * Verified by PB7 (a credential-free load in an Electron window): the sign-in
 * page is https://chatgpt.com/auth/login and its form loads under the app's
 * Chrome user agent with no challenge. The rest is marked below.
 */
export const CODEX_WEB_SERVICE: WebServiceDescriptor = Object.freeze({
  service: 'codex' as const,
  label: 'chatgpt.com',
  origin: 'https://chatgpt.com',
  hosts: Object.freeze(['chatgpt.com']),
  startUrl: 'https://chatgpt.com/',
  signInUrl: 'https://chatgpt.com/auth/login',
  // UNVERIFIED: the owner's sign-in run confirms the session cookie name (a
  // large token is split into numbered chunks, the first one ".0").
  sessionCookieNames: Object.freeze(['__Secure-next-auth.session-token', '__Secure-next-auth.session-token.0']),
  // UNVERIFIED: the owner's sign-in run confirms the identity endpoint.
  identityPath: '/api/auth/session',
  // UNVERIFIED: the owner's sign-in run confirms where the email sits in it.
  identityEmailPath: Object.freeze(['user', 'email']),
  // UNVERIFIED: the owner's sign-in run confirms each sign-in method's hosts
  // (email and phone, Google, Apple: the methods PB7 saw offered).
  signInHosts: Object.freeze(['auth.openai.com', 'accounts.google.com', 'appleid.apple.com']),
})

/**
 * The host of an https URL on its default port: lower-cased, one trailing dot
 * (the fully-qualified form) removed. Null for anything else, so a caller
 * that compares hosts can never be handed a host of a non-https or
 * explicit-port URL.
 */
export function httpsDefaultPortHost(url: unknown): string | null {
  if (typeof url !== 'string') return null
  let u: URL
  try { u = new URL(url) } catch { return null }
  if (u.protocol !== 'https:' || u.port !== '') return null
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  return host || null
}

/** True for an https URL (default port) on one of the service's own hosts. */
export function isWebServiceUrl(desc: WebServiceDescriptor, url: unknown): boolean {
  const host = httpsDefaultPortHost(url)
  return host !== null && desc.hosts.includes(host)
}

/** True for an https URL (default port) on one of the listed sign-in hosts, exactly. */
export function isWebServiceSignInHop(desc: WebServiceDescriptor, url: unknown): boolean {
  const host = httpsDefaultPortHost(url)
  return host !== null && desc.signInHosts.includes(host)
}

/**
 * PURE: does a partition hold the service's session, from the cookies Electron
 * reports on its origin. The named cookie is the only signal and its expiry is
 * the session's lifetime (as Claude's webSessionFromElectronCookies). An exact
 * name match: a near-miss is not the session cookie.
 */
export function webServiceSessionFromCookies(
  desc: WebServiceDescriptor,
  cookies: ReadonlyArray<{ name?: unknown; expirationDate?: unknown }> | null | undefined,
): { hasSessionCookie: boolean; expiresAt: number | null } {
  const session = (cookies ?? []).find((c) => typeof c?.name === 'string' && desc.sessionCookieNames.includes(c.name))
  if (!session) return { hasSessionCookie: false, expiresAt: null }
  const exp = session.expirationDate
  return { hasSessionCookie: true, expiresAt: typeof exp === 'number' && exp > 0 ? exp * 1000 : null }
}

/** How a Codex account's chatgpt.com session was signed in: the sign-in
 *  window, or the pane's account view. Nothing is ever copied in from a
 *  browser (WP1 design principle 4). */
export type CodexWebSessionOrigin = 'in-app' | 'in-pane'

/**
 * The metadata record of a Codex account's chatgpt.com web session. The
 * cookies themselves never leave the account's partition; this is all that is
 * written to disk (codex-web-sessions.json).
 */
export interface CodexWebSession {
  /** The registry account id (the `account` class). */
  accountId: string
  /** The email the identity read returned, for display. A record is only
   *  ever made with one (completion fails closed without it). */
  accountEmail: string
  /** Epoch ms when the sign-in completed. */
  acquiredAt: number
  /** The session cookie's expiry, epoch ms; null for a session cookie. */
  expiresAt: number | null
  origin: CodexWebSessionOrigin
}

export type CodexWebSessionStatus = 'none' | 'active' | 'expired'

/** How a Codex account's web session looks to the UI. */
export interface CodexWebSessionView extends Partial<CodexWebSession> {
  accountId: string
  status: CodexWebSessionStatus
}

export type CodexWebSignInPhase = 'idle' | 'awaiting-user' | 'done' | 'failed'

/** A Codex account's chatgpt.com sign-in run, as main reports it. */
export interface CodexWebSignInState {
  phase: CodexWebSignInPhase
  accountId: string | null
  /** Populated on 'failed'. Shown to the user verbatim. */
  error?: string
  /** Populated on 'done': metadata only. */
  session?: CodexWebSession
}

/**
 * What main pushes for the browser pane's account strip (account-pane.ts): a
 * Claude profile's claude.ai surface, or a Codex account's chatgpt.com one.
 * `authed` is null while the first cookie read is in flight; `email` is the
 * recorded account email, when one is known.
 */
export type AccountPaneStateView =
  | { sessionId: string; service?: undefined; profileId: string; accountId?: undefined; authed: boolean | null; email: string | null }
  // `profileId` is declared absent, so a Claude consumer comparing it to a
  // profile id reads a Codex push as "not this profile".
  | { sessionId: string; service: 'codex'; accountId: string; profileId?: undefined; authed: boolean | null; email: string | null }

/** Hosts whose cookies are harvested. Nothing else is ever copied out of the browser. */
export const CLAUDE_COOKIE_HOSTS = ['claude.ai', '.claude.ai'] as const

/**
 * The cookie that actually carries the claude.ai web session. Harvesting is
 * scoped rather than "copy every cookie the browser has": the browser profile
 * is the user's, and a wholesale copy would sweep up unrelated sites' sessions
 * into CCC's storage for no benefit.
 */
export const CLAUDE_SESSION_COOKIE = 'sessionKey'
