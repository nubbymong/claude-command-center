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
  DEFAULT_WEB_SIGN_IN_MODE,
  isAuthBrowser,
  isCliAuthMethod,
  isWebSignInMode,
  PROFILE_ID_RE,
  type AccountWebSession,
  type AuthBrowser,
  type CliAuthMethod,
  type WebSignInMode,
} from '../../shared/account-web-session'
import { peekJsonFile, quarantinedCopyOf, readJsonFile, writeJsonFile } from '../channel-storage'
import { logError } from '../debug-logger'

const FILE = 'account-web-sessions.json'
const SCHEMA_VERSION = 4

interface SessionsFile {
  schemaVersion: number
  sessions: AccountWebSession[]
  /** Per-account CLI sign-in flow. Absent means the default. */
  authMethods: Record<string, CliAuthMethod>
  /** Per-account system browser for the web sign-in. Absent means the default. */
  authBrowsers: Record<string, AuthBrowser>
  /** Per-account web sign-in routing (#439). Absent means 'auto'. */
  webSignInModes: Record<string, WebSignInMode>
}

function seed(): SessionsFile {
  return { schemaVersion: SCHEMA_VERSION, sessions: [], authMethods: {}, authBrowsers: {}, webSignInModes: {} }
}

/** The store, read ONCE per call: its contents as this build reads them, and
 *  whether a newer build wrote it (claudeWebStoreIsNewer's rule, from the
 *  same read). */
interface StoreRead {
  f: SessionsFile
  newer: boolean
}

function readStore(): StoreRead {
  const raw = readJsonFile<SessionsFile>(FILE, seed)
  const v = (raw as { schemaVersion?: unknown } | null)?.schemaVersion
  return { f: fromDisk(raw), newer: typeof v === 'number' && v > SCHEMA_VERSION }
}

function read(): SessionsFile {
  return readStore().f
}

/** The store, read once, for a write: refused (logged, and thrown) when a
 *  newer build wrote it. */
function readForWrite(what: string): SessionsFile {
  const { f, newer } = readStore()
  if (newer) {
    logError(`[account-web] the claude.ai record store was written by a newer version of the app; ${what} was not saved and the file is left as it is`)
    throw new Error(NEWER_WEB_STORE_REASON)
  }
  return f
}

function fromDisk(f: SessionsFile): SessionsFile {
  // MIGRATE a known older version rather than reseeding: discarding the file
  // would silently sign every account out of claude.ai on upgrade, which looks
  // like a bug in the sign-in rather than in the store.
  //   v1 -> v2 added authMethods     (which CLI sign-in flow an account uses)
  //   v2 -> v3 added authBrowsers    (which system browser completes the web sign-in)
  //   v3 -> v4 added webSignInModes  (where the web sign-in runs, #439)
  if (f.schemaVersion === 1 || f.schemaVersion === 2 || f.schemaVersion === 3) {
    return {
      schemaVersion: SCHEMA_VERSION,
      sessions: f.sessions ?? [],
      authMethods: f.authMethods ?? {},
      authBrowsers: f.schemaVersion === 3 ? (f.authBrowsers ?? {}) : {},
      webSignInModes: {},
    }
  }
  // Any other version reads as empty. One written by a newer build is never
  // written over (readStore's `newer`, checked by every write below).
  if (f.schemaVersion !== SCHEMA_VERSION) return seed()
  return {
    schemaVersion: SCHEMA_VERSION,
    sessions: f.sessions ?? [],
    authMethods: f.authMethods ?? {},
    authBrowsers: f.authBrowsers ?? {},
    webSignInModes: f.webSignInModes ?? {},
  }
}

/** What a refused setting and the status say while the record store was
 *  written by a newer build. */
export const NEWER_WEB_STORE_REASON = "This account's claude.ai records were written by a newer version of the app."

/**
 * Whether the record store was written by a newer build (a higher schema
 * version: a downgrade). Such a store is never overwritten, since this build
 * cannot know what rewriting it would drop:
 *   - a save and each per-account setting are refused (a setting throws with
 *     NEWER_WEB_STORE_REASON, so the caller reports it);
 *   - a removal counts as done (it runs after a wipe that succeeded), so a
 *     sign-out is never refused for a record this build cannot write;
 *   - the status carries the reason, never a plain "none".
 */
export function claudeWebStoreIsNewer(): boolean {
  const p = peekJsonFile(FILE)
  if (p.kind !== 'ok') return false
  const v = (p.value as { schemaVersion?: unknown } | null)?.schemaVersion
  return typeof v === 'number' && v > SCHEMA_VERSION
}

/** A write that throws is a write that failed: callers act on false. */
function writeSafely(f: SessionsFile): boolean {
  try {
    return writeJsonFile(FILE, f) === true
  } catch {
    return false
  }
}

/** The record store as the start sweep sees it: the accounts it holds a
 *  record for, or why it cannot be trusted. */
export type ClaudeWebRecordsForSweep =
  | { ok: true; profiles: ReadonlySet<string> }
  | { ok: false; why: 'unreadable' | 'malformed' | 'other-schema' | 'quarantined'; file?: string }

/**
 * Read the store ONCE for the start sweep, without side effects (a bad file is
 * never renamed or reseeded on this path). Absent means no records. Any other
 * doubt (a quarantined copy beside it, a file that cannot be read or parsed,
 * a schema version other than this build's or one it migrates, sessions that
 * are missing or not a list) is reported, so the sweep can stand down rather than wipe a
 * session the store does hold a record for. A record with a malformed field
 * still counts for its account id: the sweep never wipes on a record it merely
 * could not use.
 */
export function readClaudeWebRecordsForSweep(): ClaudeWebRecordsForSweep {
  // A quarantined copy (an earlier read could not parse the store and moved
  // it aside) may hold the records the fresh store lacks: stand down while it
  // is there, not just for one start.
  const quarantined = quarantinedCopyOf(FILE)
  if (quarantined === 'unknown') return { ok: false, why: 'unreadable' }
  if (quarantined) return { ok: false, why: 'quarantined', file: quarantined }
  const peek = peekJsonFile(FILE)
  if (peek.kind === 'absent') return { ok: true, profiles: new Set() }
  if (peek.kind === 'unreadable') return { ok: false, why: 'unreadable' }
  if (peek.kind === 'malformed') return { ok: false, why: 'malformed' }
  const f = peek.value as Partial<SessionsFile> | null
  if (!f || typeof f !== 'object') return { ok: false, why: 'malformed' }
  const v = f.schemaVersion
  if (v !== 1 && v !== 2 && v !== 3 && v !== SCHEMA_VERSION) return { ok: false, why: 'other-schema' }
  if (!Array.isArray(f.sessions)) return { ok: false, why: 'malformed' }
  const profiles = new Set<string>()
  for (const r of f.sessions) {
    const id = (r as { profileId?: unknown } | null)?.profileId
    if (typeof id === 'string' && PROFILE_ID_RE.test(id)) profiles.add(id)
  }
  return { ok: true, profiles }
}

/** The account's chosen CLI sign-in flow, or the default. */
export function getAuthMethod(profileId: string): CliAuthMethod {
  const v = read().authMethods[profileId]
  return isCliAuthMethod(v) ? v : DEFAULT_CLI_AUTH_METHOD
}

/** Record the account's CLI sign-in flow. Refuses anything the CLI does not
 *  offer, and a store written by a newer build. */
export function setAuthMethod(profileId: string, method: CliAuthMethod): void {
  if (!isCliAuthMethod(method)) throw new Error(`unknown auth method: ${method}`)
  const f = readForWrite('the sign-in method')
  f.authMethods = { ...f.authMethods, [profileId]: method }
  writeJsonFile(FILE, f)
}

/** The account's chosen sign-in browser, or the default. */
export function getAuthBrowser(profileId: string): AuthBrowser {
  const v = read().authBrowsers[profileId]
  return isAuthBrowser(v) ? v : DEFAULT_AUTH_BROWSER
}

/** Where this account's web sign-in runs (#439), or the default ('auto'). */
export function getWebSignInMode(profileId: string): WebSignInMode {
  const v = read().webSignInModes[profileId]
  return isWebSignInMode(v) ? v : DEFAULT_WEB_SIGN_IN_MODE
}

/** Record where this account's web sign-in runs. Refuses unknown values, and
 *  a store written by a newer build. */
export function setWebSignInMode(profileId: string, mode: WebSignInMode): void {
  if (!isWebSignInMode(mode)) throw new Error(`unknown web sign-in mode: ${mode}`)
  const f = readForWrite('the sign-in mode')
  f.webSignInModes = { ...f.webSignInModes, [profileId]: mode }
  writeJsonFile(FILE, f)
}

/**
 * Record the account's sign-in browser.
 *
 * Refuses anything but the two known values: this string selects an executable
 * to spawn, so it does not get to be arbitrary even having come from our own UI.
 * Refuses a store written by a newer build too.
 */
export function setAuthBrowser(profileId: string, browser: AuthBrowser): void {
  if (!isAuthBrowser(browser)) throw new Error(`unknown sign-in browser: ${browser}`)
  const f = readForWrite('the sign-in browser')
  f.authBrowsers = { ...f.authBrowsers, [profileId]: browser }
  writeJsonFile(FILE, f)
}

/** How a stored session looks to the UI once expiry is taken into account. */
export type WebSessionStatus = 'none' | 'active' | 'expired'

export interface WebSessionView extends Partial<AccountWebSession> {
  profileId: string
  status: WebSessionStatus
  /** Why the record cannot be shown (the store was written by a newer build). */
  unavailable?: string
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
  const { f, newer } = readStore()
  if (newer) return { profileId, status: 'none', unavailable: NEWER_WEB_STORE_REASON }
  const s = f.sessions.find((x) => x.profileId === profileId)
  return { ...(s ?? {}), profileId, status: statusOf(s, now) }
}

/** Insert or replace one account's record. One record per account, always.
 *  True once the record is on disk; false when the write failed, or the store
 *  was written by a newer build (left as it is). */
export function saveWebSession(s: AccountWebSession): boolean {
  const { f, newer } = readStore()
  if (newer) {
    logError('[account-web] the claude.ai record store was written by a newer version of the app; it is left as it is')
    return false
  }
  f.sessions = [...f.sessions.filter((x) => x.profileId !== s.profileId), s]
  return writeSafely(f)
}

/** Forget the record. The caller clears the partition cookies separately.
 *  True when there is no record left (none, or removed, or a store written by
 *  a newer build, left as it is); false when the write failed. */
export function removeWebSession(profileId: string): boolean {
  // A newer store is left as it is; the removal counts as done, since it runs
  // after a wipe that succeeded.
  const { f, newer } = readStore()
  if (newer) return true
  const next = f.sessions.filter((s) => s.profileId !== profileId)
  if (next.length === f.sessions.length) return true
  // Write the WHOLE file back. Writing only `sessions` — as this used to — threw
  // away every per-account setting on sign-out, so an account that signed out of
  // claude.ai silently lost its CLI sign-in flow (and now its browser choice)
  // and reverted to the defaults with nothing to explain why.
  return writeSafely({ ...f, sessions: next })
}
