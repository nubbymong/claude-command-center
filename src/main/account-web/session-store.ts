// src/main/account-web/session-store.ts
//
// Persisted record of WHICH accounts hold a claude.ai web session (#216).
//
// It stores metadata only — account email, when it was acquired, when the
// earliest cookie expires. The cookies themselves live in Electron's partition
// store and are never written here: duplicating a live session into a JSON file
// beside the config would be a second copy to protect for no benefit.
//
// Follows the standing-approvals-store convention (schemaVersion + readJsonFile
// / writeJsonFile).
import {
  DEFAULT_AUTH_BROWSER,
  DEFAULT_CLI_AUTH_METHOD,
  isAuthBrowser,
  isCliAuthMethod,
  type AccountWebSession,
  type AuthBrowser,
  type CliAuthMethod,
} from '../../shared/account-web-session'
import { readJsonFile, writeJsonFile } from '../channel-storage'

const FILE = 'account-web-sessions.json'
const SCHEMA_VERSION = 3

interface SessionsFile {
  schemaVersion: number
  sessions: AccountWebSession[]
  /** Per-account CLI sign-in flow. Absent means the default. */
  authMethods: Record<string, CliAuthMethod>
  /** Per-account system browser for the web sign-in. Absent means the default. */
  authBrowsers: Record<string, AuthBrowser>
}

function seed(): SessionsFile {
  return { schemaVersion: SCHEMA_VERSION, sessions: [], authMethods: {}, authBrowsers: {} }
}

function read(): SessionsFile {
  const f = readJsonFile<SessionsFile>(FILE, seed)
  // MIGRATE a known older version rather than reseeding: discarding the file
  // would silently sign every account out of claude.ai on upgrade, which looks
  // like a bug in the sign-in rather than in the store.
  //   v1 -> v2 added authMethods  (which CLI sign-in flow an account uses)
  //   v2 -> v3 added authBrowsers (which system browser completes the web sign-in)
  if (f.schemaVersion === 1 || f.schemaVersion === 2) {
    return {
      schemaVersion: SCHEMA_VERSION,
      sessions: f.sessions ?? [],
      authMethods: f.authMethods ?? {},
      authBrowsers: {},
    }
  }
  if (f.schemaVersion !== SCHEMA_VERSION) return seed()
  return {
    schemaVersion: SCHEMA_VERSION,
    sessions: f.sessions ?? [],
    authMethods: f.authMethods ?? {},
    authBrowsers: f.authBrowsers ?? {},
  }
}

/** The account's chosen CLI sign-in flow, or the default. */
export function getAuthMethod(profileId: string): CliAuthMethod {
  const v = read().authMethods[profileId]
  return isCliAuthMethod(v) ? v : DEFAULT_CLI_AUTH_METHOD
}

/** Record the account's CLI sign-in flow. Refuses anything the CLI does not offer. */
export function setAuthMethod(profileId: string, method: CliAuthMethod): void {
  if (!isCliAuthMethod(method)) throw new Error(`unknown auth method: ${method}`)
  const f = read()
  f.authMethods = { ...f.authMethods, [profileId]: method }
  writeJsonFile(FILE, f)
}

/** The account's chosen sign-in browser, or the default. */
export function getAuthBrowser(profileId: string): AuthBrowser {
  const v = read().authBrowsers[profileId]
  return isAuthBrowser(v) ? v : DEFAULT_AUTH_BROWSER
}

/**
 * Record the account's sign-in browser.
 *
 * Refuses anything but the two known values: this string selects an executable
 * to spawn, so it does not get to be arbitrary even having come from our own UI.
 */
export function setAuthBrowser(profileId: string, browser: AuthBrowser): void {
  if (!isAuthBrowser(browser)) throw new Error(`unknown sign-in browser: ${browser}`)
  const f = read()
  f.authBrowsers = { ...f.authBrowsers, [profileId]: browser }
  writeJsonFile(FILE, f)
}

/** How a stored session looks to the UI once expiry is taken into account. */
export type WebSessionStatus = 'none' | 'active' | 'expired'

export interface WebSessionView extends Partial<AccountWebSession> {
  profileId: string
  status: WebSessionStatus
}

/** PURE: decide a session's status. Exported so the expiry rule has a test. */
export function statusOf(s: AccountWebSession | undefined, now: number): WebSessionStatus {
  if (!s) return 'none'
  // A null expiresAt means every cookie was a session cookie. Those do not
  // survive the browser that made them, and CCC destroyed that browser — so it
  // is only usable until something invalidates it. Treat as active and let a
  // 401 be the thing that corrects us, rather than expiring a working session.
  if (s.expiresAt !== null && s.expiresAt !== undefined && s.expiresAt <= now) return 'expired'
  return 'active'
}

export function loadWebSessions(): AccountWebSession[] {
  return read().sessions
}

export function getWebSession(profileId: string): AccountWebSession | undefined {
  return read().sessions.find((s) => s.profileId === profileId)
}

export function viewFor(profileId: string, now: number = Date.now()): WebSessionView {
  const s = getWebSession(profileId)
  return { ...(s ?? {}), profileId, status: statusOf(s, now) }
}

/** Insert or replace one account's record. One record per account, always. */
export function saveWebSession(s: AccountWebSession): void {
  const f = read()
  f.sessions = [...f.sessions.filter((x) => x.profileId !== s.profileId), s]
  writeJsonFile(FILE, f)
}

/** Forget the record. The caller clears the partition cookies separately. */
export function removeWebSession(profileId: string): void {
  const f = read()
  const next = f.sessions.filter((s) => s.profileId !== profileId)
  if (next.length === f.sessions.length) return
  // Write the WHOLE file back. Writing only `sessions` — as this used to — threw
  // away every per-account setting on sign-out, so an account that signed out of
  // claude.ai silently lost its CLI sign-in flow (and now its browser choice)
  // and reverted to the defaults with nothing to explain why.
  writeJsonFile(FILE, { ...f, sessions: next })
}
