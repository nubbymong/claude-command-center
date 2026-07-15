import { createHash } from 'crypto'
import { IDENTITY_COLOR_KEYS, type IdentityColorKey } from '../shared/identity-colors'

/**
 * Map an email to a stable identity-palette KEY (V2 Shell UX spec section 5).
 * Lowercased + trimmed so casing variations don't produce different colours.
 * Deterministic across machines (same email -> same key everywhere). The key
 * is resolved to a theme-specific hex at render time via resolveIdentityColor,
 * so an account colour can never collide with reserved status / brand / link
 * hues. This is an algorithm update, not a stored-data migration -- account
 * colour is recomputed on every statusline update and never persisted.
 */
export function colourForEmail(email: string): IdentityColorKey {
  const normalised = email.toLowerCase().trim()
  const hash = createHash('sha256').update(normalised).digest()
  return IDENTITY_COLOR_KEYS[hash[0] % IDENTITY_COLOR_KEYS.length]
}

/**
 * Enrich a StatuslineData-shaped payload with an accountColour computed from
 * accountEmail. Pure statusline-decoration concern (formerly lived in
 * tokenomics-manager.ts); the statusline fan-out calls this at the renderer-send
 * site so the ContextBar sees a fully-enriched object. No-op when the payload
 * carries no accountEmail.
 */
export function decorateStatuslineWithColour<T extends { accountEmail?: string }>(
  sl: T,
): T & { accountColour?: IdentityColorKey } {
  if (typeof sl.accountEmail === 'string' && sl.accountEmail.trim().length > 0) {
    return { ...sl, accountColour: colourForEmail(sl.accountEmail) }
  }
  return sl
}
