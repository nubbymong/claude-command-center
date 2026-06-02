// src/main/claude-account-identity.ts
// Spawn-time Claude account capture, mirroring the Codex pattern in pty-manager.
// RELIABLE + drift-immune: read once at spawn from the session's profile (or the
// default ~/.claude.json for single-account sessions), never re-read. Fixes the
// v1.5.9 chip removal (whose source was the GLOBAL last-login at tick time).
import fs from 'node:fs'; import path from 'node:path'
import { BrowserWindow } from 'electron'
import { readProfileAccountEmail, readSessionHomeEmail, getSessionHomeDir, sharedRoot, listProfiles } from './account-profiles'
import { IPC } from '../shared/ipc-channels'
import { colourForEmail } from './account-color'
import { canonicaliseEmail } from '../shared/account-chip-color'
import type { IdentityColorKey } from '../shared/identity-colors'

const bySession = new Map<string, string>()

export function getDefaultAccountEmail(): string | null {
  try {
    // The default account's identity lives in ~/.claude.json (home root), a
    // SIBLING of sharedRoot() (~/.claude) -- NOT a file inside it. Reading
    // sharedRoot()/.claude.json (the prior bug) always missed on real machines,
    // so the account chip stayed blank for every single-account user.
    // dirname(sharedRoot()) resolves to the home root in production and still
    // routes through the _setRootsForTest seam in tests.
    const raw = fs.readFileSync(path.join(path.dirname(sharedRoot()), '.claude.json'), 'utf8')
    const email = (JSON.parse(raw) as { oauthAccount?: { emailAddress?: unknown } })?.oauthAccount?.emailAddress
    return typeof email === 'string' && email ? email : null
  } catch { return null }
}

/** Capture once at spawn. profileId undefined => single-account/default. */
export function captureClaudeAccount(sessionId: string, profileId: string | undefined): void {
  if (bySession.has(sessionId)) return // drift-immune: first capture wins
  const email = profileId
    ? (readSessionHomeEmail(sessionId) ?? readProfileAccountEmail(profileId))
    : getDefaultAccountEmail()
  if (email) bySession.set(sessionId, email)
}
export function getClaudeAccount(sessionId: string): string | null { return bySession.get(sessionId) ?? null }
export function getClaudeAccountMap(): ReadonlyMap<string, string> { return bySession }
export function clearClaudeAccount(sessionId: string): void { bySession.delete(sessionId) }

export function getAccountIdentity(sessionId: string): { email: string; colourKey: IdentityColorKey } | null {
  const email = bySession.get(sessionId)
  return email ? { email, colourKey: colourForEmail(email) } : null
}

/** Push the captured identity to all renderer windows (one-shot, at spawn). */
export function pushAccountIdentity(sessionId: string): void {
  const id = getAccountIdentity(sessionId)
  if (!id) return
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send(IPC.ACCOUNT_IDENTITY_UPDATE, { sessionId, email: id.email, colourKey: id.colourKey }) } catch { /* window destroyed */ }
  }
}

// ---- mid-session account watch ---------------------------------------------
// The spawn-time capture above is "first capture wins" and never re-reads. But a
// user can change a session's account WITHOUT a respawn by running `/login` in
// the terminal -- that rewrites the session's own .claude.json (the profile dir
// for a profile session, or ~/.claude.json for the default account). We poll
// each live session's identity file and, on a real change, update the map and
// re-push so the status strip, the session-card account line, and the statusline
// chip all follow. mtime-guarded so the JSON is only parsed when the file
// actually changes (the default account's ~/.claude.json can be multi-MB).

const watched = new Map<string, string | undefined>() // sessionId -> profileId
const lastMtimeMs = new Map<string, number>()         // sessionId -> last seen identity-file mtime
let pollTimer: ReturnType<typeof setInterval> | null = null
const POLL_MS = 3000

/** Resolve the .claude.json that holds a session's account identity. */
function identityFilePath(sessionId: string, profileId: string | undefined): string {
  return profileId
    ? path.join(getSessionHomeDir(sessionId), '.claude.json')
    : path.join(path.dirname(sharedRoot()), '.claude.json')
}

/**
 * Re-read a session's identity file; if the account email changed since the last
 * captured value, update the map and return the NEW email (else null). Exported
 * for the poll loop and for tests. mtime-guarded: returns null fast when the file
 * has not changed, so the (possibly large) JSON is only parsed on a real change.
 */
export function recheckSessionIdentity(sessionId: string, profileId: string | undefined): string | null {
  const file = identityFilePath(sessionId, profileId)
  let mtime: number
  try { mtime = fs.statSync(file).mtimeMs } catch { return null }
  if (lastMtimeMs.get(sessionId) === mtime) return null
  lastMtimeMs.set(sessionId, mtime)
  let email: string | null = null
  try { email = profileId ? readSessionHomeEmail(sessionId) : getDefaultAccountEmail() } catch { return null }
  if (!email || bySession.get(sessionId) === email) return null
  bySession.set(sessionId, email) // mid-session change: bypass the first-capture guard
  return email
}

/** Notify renderers that a session's /login authenticated an account not yet
 *  known as a profile, so the UI can offer to add + name it. */
function broadcastNewAccountDetected(sessionId: string, profileId: string, email: string): void {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send(IPC.ACCOUNT_NEW_DETECTED, { sessionId, profileId, email }) } catch { /* window destroyed */ }
  }
}

export function recheckAll(): void {
  for (const [sessionId, profileId] of watched) {
    const before = bySession.get(sessionId) ?? null
    let changed: string | null = null
    try { changed = recheckSessionIdentity(sessionId, profileId) } catch { /* best-effort */ }
    if (!changed) continue
    pushAccountIdentity(sessionId)
    if (!profileId) continue // bare-global/default session: no profile context to detect against
    // Detection: a /login to an email that is not yet a known account.
    const known = listProfiles().map((p) => p.accountEmail).filter((e): e is string => !!e)
    if (classifyIdentityChange(sessionId, changed, before, known).kind === 'capture') {
      broadcastNewAccountDetected(sessionId, profileId, changed)
    }
  }
}

/** Start polling a live session's identity file for mid-session account changes. */
export function startWatchingAccountIdentity(sessionId: string, profileId: string | undefined): void {
  watched.set(sessionId, profileId)
  if (!pollTimer) {
    pollTimer = setInterval(recheckAll, POLL_MS)
    // Never keep the process alive just for this poll.
    if (typeof (pollTimer as { unref?: () => void }).unref === 'function') (pollTimer as { unref: () => void }).unref()
  }
}

/** Stop polling a session (called alongside clearClaudeAccount on PTY exit). */
export function stopWatchingAccountIdentity(sessionId: string): void {
  watched.delete(sessionId)
  lastMtimeMs.delete(sessionId)
  if (watched.size === 0 && pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

// ---- pure classifier (no side effects, fully unit-testable) ----------------

export type IdentityChange = { kind: 'refresh' | 'adopt' | 'capture' }

/** Classify what a session's identity-file change means. Pure + unit-testable.
 *  refresh = same account (token refresh); adopt = switched to an existing
 *  account; capture = switched to an email not yet known as a profile. */
export function classifyIdentityChange(
  _sessionId: string,
  newEmail: string,
  currentEmail: string | null,
  knownEmails: string[],
): IdentityChange {
  const ne = canonicaliseEmail(newEmail)
  if (currentEmail && canonicaliseEmail(currentEmail) === ne) return { kind: 'refresh' }
  if (knownEmails.some((e) => canonicaliseEmail(e) === ne)) return { kind: 'adopt' }
  return { kind: 'capture' }
}

/** Test seam. */
export function _resetClaudeAccounts(): void {
  bySession.clear()
  watched.clear()
  lastMtimeMs.clear()
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}
