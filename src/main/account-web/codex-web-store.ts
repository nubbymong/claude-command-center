// src/main/account-web/codex-web-store.ts
//
// Persisted record of WHICH Codex accounts hold a chatgpt.com web session
// (WP2 PR 4, P4.6, row 58): the twin of session-store.ts for Claude's
// claude.ai sessions, in its own file (codex-web-sessions.json).
//
// METADATA ONLY: the account id, the email the identity read returned, when
// it was signed in, when the session cookie expires, and where. The cookies
// stay in the account's Electron partition and are never written here; no
// token, cookie value or identity answer is ever stored.
//
// Read defensively: a record whose account id is not a registry account id,
// or whose fields are malformed, is dropped rather than trusted.
import {
  isWebSessionAccountId,
  type CodexWebSession,
  type CodexWebSessionStatus,
  type CodexWebSessionView,
} from '../../shared/account-web-session'
import { sanitizeAccountEmail } from './account-email-read'
import { peekJsonFile, quarantinedCopyOf, readJsonFile, writeJsonFile } from '../channel-storage'
import { logError } from '../debug-logger'

const FILE = 'codex-web-sessions.json'
const SCHEMA_VERSION = 1

interface CodexWebSessionsFile {
  schemaVersion: number
  sessions: CodexWebSession[]
}

function seed(): CodexWebSessionsFile {
  return { schemaVersion: SCHEMA_VERSION, sessions: [] }
}

function validRecord(v: unknown): v is CodexWebSession {
  const r = v as Partial<CodexWebSession> | null
  return !!r
    && typeof r === 'object'
    && isWebSessionAccountId(r.accountId)
    && sanitizeAccountEmail(r.accountEmail) !== null
    && typeof r.acquiredAt === 'number' && Number.isFinite(r.acquiredAt)
    && (r.expiresAt === null || (typeof r.expiresAt === 'number' && Number.isFinite(r.expiresAt)))
    && (r.origin === 'in-app' || r.origin === 'in-pane')
}

function read(): CodexWebSessionsFile {
  const f = readJsonFile<CodexWebSessionsFile>(FILE, seed)
  if (!f || f.schemaVersion !== SCHEMA_VERSION || !Array.isArray(f.sessions)) return seed()
  return { schemaVersion: SCHEMA_VERSION, sessions: f.sessions.filter(validRecord) }
}

/** What a row, a refused sign-in and the status say while the record store
 *  was written by a newer build. */
export const NEWER_STORE_REASON = "This account's chatgpt.com records were written by a newer version of the app."

/**
 * Whether the record store was written by a newer build (a higher schema
 * version: a downgrade). Such a store is never overwritten, since this build
 * cannot know what rewriting it would drop, and it is handled as one rule:
 *   - sign-in is refused up front with NEWER_STORE_REASON (the channels), and
 *     a save is refused, so a sign-in finished in a pane is cleared;
 *   - a removal counts as done (it runs after a wipe that succeeded): a
 *     sign-out or an archive is never refused for a record this build cannot
 *     write, nor left with a "Try again" that can never work;
 *   - the status carries the reason, never a plain "none".
 */
export function codexWebStoreIsNewer(): boolean {
  const p = peekJsonFile(FILE)
  if (p.kind !== 'ok') return false
  const v = (p.value as { schemaVersion?: unknown } | null)?.schemaVersion
  return typeof v === 'number' && v > SCHEMA_VERSION
}

/** The record store as the start sweep sees it: the accounts it holds a
 *  record for, or why it cannot be trusted. */
export type CodexWebRecordsForSweep =
  | { ok: true; accounts: ReadonlySet<string> }
  | { ok: false; why: 'unreadable' | 'malformed' | 'other-schema' | 'quarantined'; file?: string }

/**
 * Read the store ONCE for the start sweep, without side effects (a bad file is
 * never renamed on this path). Absent means no records. Any other doubt (the
 * file cannot be read or parsed, another schema version such as a downgrade,
 * sessions that are not a list) is reported, so the sweep can stand down
 * rather than wipe a session the store does hold a record for. A record with
 * a malformed field still counts for its account id: the sweep never wipes on
 * a record it merely could not use.
 */
export function readCodexWebRecordsForSweep(): CodexWebRecordsForSweep {
  // A quarantined copy (an earlier read could not parse the store and moved
  // it aside) may hold the records the fresh store lacks: stand down while it
  // is there, not just for one start.
  const quarantined = quarantinedCopyOf(FILE)
  if (quarantined === 'unknown') return { ok: false, why: 'unreadable' }
  if (quarantined) return { ok: false, why: 'quarantined', file: quarantined }
  const peek = peekJsonFile(FILE)
  if (peek.kind === 'absent') return { ok: true, accounts: new Set() }
  if (peek.kind === 'unreadable') return { ok: false, why: 'unreadable' }
  if (peek.kind === 'malformed') return { ok: false, why: 'malformed' }
  const f = peek.value as Partial<CodexWebSessionsFile> | null
  if (!f || typeof f !== 'object') return { ok: false, why: 'malformed' }
  if (f.schemaVersion !== SCHEMA_VERSION) return { ok: false, why: 'other-schema' }
  if (!Array.isArray(f.sessions)) return { ok: false, why: 'malformed' }
  const accounts = new Set<string>()
  for (const r of f.sessions) {
    const id = (r as { accountId?: unknown } | null)?.accountId
    if (isWebSessionAccountId(id)) accounts.add(id)
  }
  return { ok: true, accounts }
}

export function getCodexWebSession(accountId: string): CodexWebSession | undefined {
  return read().sessions.find((s) => s.accountId === accountId)
}

/** PURE: a session's status at `now`. A null expiry (a session cookie) is
 *  active until something says otherwise, as Claude's statusOf. */
export function codexWebStatusOf(s: CodexWebSession | undefined, now: number): CodexWebSessionStatus {
  if (!s) return 'none'
  if (s.expiresAt !== null && s.expiresAt <= now) return 'expired'
  return 'active'
}

export function codexWebViewFor(accountId: string, now: number = Date.now()): CodexWebSessionView {
  if (codexWebStoreIsNewer()) return { accountId, status: 'none', unavailable: NEWER_STORE_REASON }
  const s = getCodexWebSession(accountId)
  return { ...(s ?? {}), accountId, status: codexWebStatusOf(s, now) }
}

/** Insert or replace one account's record. Refuses a malformed one (throws);
 *  true once the record is on disk, false when the write failed or threw. */
export function saveCodexWebSession(s: CodexWebSession): boolean {
  if (!validRecord(s)) throw new Error('refusing to save a malformed chatgpt.com session record')
  if (codexWebStoreIsNewer()) {
    logError('[codex-web] the chatgpt.com record store was written by a newer version of the app; it is left as it is')
    return false
  }
  const record: CodexWebSession = {
    accountId: s.accountId,
    accountEmail: s.accountEmail,
    acquiredAt: s.acquiredAt,
    expiresAt: s.expiresAt,
    origin: s.origin,
  }
  const f = read()
  f.sessions = [...f.sessions.filter((x) => x.accountId !== s.accountId), record]
  return writeSafely(f)
}

/** Forget the record. The caller clears the partition separately. True when
 *  there is no record left (none, or removed); false when the write failed,
 *  so a caller never reports "signed out" over a record still on disk. */
export function removeCodexWebSession(accountId: string): boolean {
  // A newer store is left as it is; the removal counts as done, since it runs
  // after a wipe that succeeded (codexWebStoreIsNewer).
  if (codexWebStoreIsNewer()) return true
  const f = read()
  const next = f.sessions.filter((s) => s.accountId !== accountId)
  if (next.length === f.sessions.length) return true
  return writeSafely({ ...f, sessions: next })
}

/** A write that throws (its folder could not be made, say) is a write that
 *  failed: the callers act on false, never on an exception. */
function writeSafely(f: unknown): boolean {
  try {
    return writeJsonFile(FILE, f) === true
  } catch {
    return false
  }
}
