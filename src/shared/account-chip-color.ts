// src/shared/account-chip-color.ts
import type { IdentityColorKey } from './identity-colors'
import type { AccountProfile } from './account-types'

/** Lowercase + trim, matching colourForEmail's normalisation so override keys
 *  and statusline emails canonicalise identically. */
export function canonicaliseEmail(email: string): string {
  return email.toLowerCase().trim()
}

/**
 * Resolve the identity-palette KEY for an account's email chip.
 * Order: user override (by canonical email) -> statusline-provided colour ->
 * neutral 'mauve'. The hash fallback (colourForEmail) is main-only and already
 * arrives as `statuslineColour`, so it is never recomputed here (keeps this
 * module free of Node `crypto` and renderer-safe).
 */
export function resolveAccountChipColorKey(
  email: string | undefined,
  statuslineColour: IdentityColorKey | undefined,
  overrides: Record<string, IdentityColorKey> | undefined,
): IdentityColorKey {
  if (email && overrides) {
    const override = overrides[canonicaliseEmail(email)]
    if (override) return override
  }
  if (statuslineColour) return statuslineColour
  return 'mauve'
}

/**
 * Friendly display name for an account ("renameable everywhere"):
 * a non-empty profile name wins; else a user alias keyed by canonical email;
 * else the raw email. Used by the status strip + session rows + tokenomics.
 */
export function resolveAccountName(
  email: string,
  profileName: string | undefined,
  aliases: Record<string, string> | undefined,
): string {
  const pn = profileName?.trim()
  if (pn) return pn
  const alias = aliases?.[canonicaliseEmail(email)]?.trim()
  if (alias) return alias
  return email
}

/** Resolve an account's display name from the LIVE email: find the profile whose
 *  accountEmail matches (case-insensitive), use its name; else fall back to alias,
 *  else the email itself. */
export function resolveAccountNameByEmail(
  email: string,
  profiles: Pick<AccountProfile, 'accountEmail' | 'name'>[],
  aliases: Record<string, string> | undefined,
): string {
  const canonical = canonicaliseEmail(email)
  const p = profiles.find((x) => x.accountEmail && canonicaliseEmail(x.accountEmail) === canonical)
  return resolveAccountName(email, p?.name, aliases)
}

/** The colour KEY for an account: a user override (by email) wins; else the
 *  provided fallback (the drift-immune session colour); else 'mauve'. */
export function resolveAccountColourKey(
  email: string | undefined,
  overrides: Record<string, IdentityColorKey> | undefined,
  fallback: IdentityColorKey | undefined,
): IdentityColorKey {
  if (email) {
    const o = overrides?.[canonicaliseEmail(email)]
    if (o) return o
  }
  return fallback ?? 'mauve'
}

/**
 * Truncate an email to `max` chars, removing from the MIDDLE so the local-part
 * start and the domain end (the disambiguating parts) stay visible. Callers
 * keep the full address in a `title` attribute.
 */
export function middleTruncateEmail(email: string, max = 28): string {
  if (email.length <= max) return email
  const ell = '...'
  if (max <= ell.length) return ell.slice(0, max)
  const keep = max - ell.length
  const head = Math.ceil(keep / 2)
  const tail = Math.floor(keep / 2)
  return email.slice(0, head) + ell + email.slice(email.length - tail)
}
