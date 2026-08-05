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
import type { AccountWebSession } from '../../shared/account-web-session'
import { readJsonFile, writeJsonFile } from '../channel-storage'

const FILE = 'account-web-sessions.json'
const SCHEMA_VERSION = 1

interface SessionsFile {
  schemaVersion: number
  sessions: AccountWebSession[]
}

function seed(): SessionsFile {
  return { schemaVersion: SCHEMA_VERSION, sessions: [] }
}

function read(): SessionsFile {
  const f = readJsonFile<SessionsFile>(FILE, seed)
  return f.schemaVersion === SCHEMA_VERSION
    ? { schemaVersion: SCHEMA_VERSION, sessions: f.sessions ?? [] }
    : seed()
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
  if (next.length !== f.sessions.length) writeJsonFile(FILE, { schemaVersion: SCHEMA_VERSION, sessions: next })
}
