// src/shared/account-alias.ts
//
// v1.5.9: manual user-managed account aliases. Replaces the v1.5.7
// auto-detected email chip, which read ~/.claude.json:oauthAccount.emailAddress
// -- a GLOBAL field that lied for every session except the most recently
// authed one. The replacement stores a small user list in AppSettings and
// tags each session by right-click. This module holds the canonicalisation,
// resolution and validation helpers; lives in shared/ because both the
// settings UI and the SessionRow renderer use the same lookup.

export interface AccountAlias {
  /** Lookup key. Canonicalise via canonicaliseEmail() before storing or matching. */
  email: string
  /** Free text, max 16 chars after trim. Display only -- not used for auth. */
  alias: string
}

/** Lowercase + trim. Mirrors v1.5.7 account-chip-color helper so any data
 *  carried across the chip -> alias migration matches under the same key. */
export function canonicaliseEmail(email: string): string {
  return email.toLowerCase().trim()
}

/**
 * Look up the alias label for a session's `accountAliasEmail`. Returns the
 * alias string for display, or undefined when:
 *   - the session has no aliasEmail set, or
 *   - the aliases list is missing / empty, or
 *   - no entry's canonical email matches.
 *
 * Matching is canonical on both sides so a row stored as `Me@X.com` and a
 * session field set via the menu (which we also canonicalise at write time)
 * still resolve, even if older state slipped in case-mismatched.
 */
export function resolveAliasForSession(
  aliasEmail: string | undefined,
  aliases: ReadonlyArray<AccountAlias> | undefined,
): string | undefined {
  if (!aliasEmail || !aliases || aliases.length === 0) return undefined
  const key = canonicaliseEmail(aliasEmail)
  for (const entry of aliases) {
    if (canonicaliseEmail(entry.email) === key) return entry.alias
  }
  return undefined
}

/** Loose email shape check -- mirrors AccountColoursSection's validator
 *  (`/^[^@\s]+@[^@\s]+\.[^@\s]+$/`). Not RFC-strict; just enough to catch
 *  typos before a row hits the settings list. */
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
export function isValidEmailShape(s: string): boolean {
  return EMAIL_RE.test(s)
}

/** Alias must have 1..16 visible characters after trim. */
export function isValidAliasLength(s: string): boolean {
  const trimmed = s.trim()
  return trimmed.length >= 1 && trimmed.length <= 16
}
