// src/main/claude-account-identity.ts
// Spawn-time Claude account capture, mirroring the Codex pattern in pty-manager.
// RELIABLE + drift-immune: read once at spawn from the session's profile (or the
// default ~/.claude.json for single-account sessions), never re-read. Fixes the
// v1.5.9 chip removal (whose source was the GLOBAL last-login at tick time).
import fs from 'node:fs'; import path from 'node:path'
import { readProfileAccountEmail, sharedRoot } from './account-profiles'

const bySession = new Map<string, string>()

function defaultAccountEmail(): string | null {
  try {
    const raw = fs.readFileSync(path.join(sharedRoot(), '.claude.json'), 'utf8')
    const email = (JSON.parse(raw) as { oauthAccount?: { emailAddress?: unknown } })?.oauthAccount?.emailAddress
    return typeof email === 'string' && email ? email : null
  } catch { return null }
}

/** Capture once at spawn. profileId undefined => single-account/default. */
export function captureClaudeAccount(sessionId: string, profileId: string | undefined): void {
  if (bySession.has(sessionId)) return // drift-immune: first capture wins
  const email = profileId ? readProfileAccountEmail(profileId) : defaultAccountEmail()
  if (email) bySession.set(sessionId, email)
}
export function getClaudeAccount(sessionId: string): string | null { return bySession.get(sessionId) ?? null }
export function getClaudeAccountMap(): ReadonlyMap<string, string> { return bySession }
export function clearClaudeAccount(sessionId: string): void { bySession.delete(sessionId) }
/** Test seam. */
export function _resetClaudeAccounts(): void { bySession.clear() }
