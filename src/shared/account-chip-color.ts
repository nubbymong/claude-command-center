// src/shared/account-chip-color.ts
import type { IdentityColorKey } from './identity-colors'

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
 * Truncate an email to `max` chars, removing from the MIDDLE so the local-part
 * start and the domain end (the disambiguating parts) stay visible. Callers
 * keep the full address in a `title` attribute.
 */
export function middleTruncateEmail(email: string, max = 28): string {
  if (email.length <= max) return email
  const ell = '...'
  const keep = max - ell.length
  const head = Math.ceil(keep / 2)
  const tail = Math.floor(keep / 2)
  return email.slice(0, head) + ell + email.slice(email.length - tail)
}
