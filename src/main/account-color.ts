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
