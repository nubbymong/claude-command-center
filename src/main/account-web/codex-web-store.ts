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
import { readJsonFile, writeJsonFile } from '../channel-storage'

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
  const s = getCodexWebSession(accountId)
  return { ...(s ?? {}), accountId, status: codexWebStatusOf(s, now) }
}

/** Insert or replace one account's record. Refuses a malformed one. */
export function saveCodexWebSession(s: CodexWebSession): void {
  if (!validRecord(s)) throw new Error('refusing to save a malformed chatgpt.com session record')
  const record: CodexWebSession = {
    accountId: s.accountId,
    accountEmail: s.accountEmail,
    acquiredAt: s.acquiredAt,
    expiresAt: s.expiresAt,
    origin: s.origin,
  }
  const f = read()
  f.sessions = [...f.sessions.filter((x) => x.accountId !== s.accountId), record]
  writeJsonFile(FILE, f)
}

/** Forget the record. The caller clears the partition separately. */
export function removeCodexWebSession(accountId: string): void {
  const f = read()
  const next = f.sessions.filter((s) => s.accountId !== accountId)
  if (next.length === f.sessions.length) return
  writeJsonFile(FILE, { ...f, sessions: next })
}
