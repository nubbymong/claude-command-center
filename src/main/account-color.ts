import { createHash } from 'crypto'
import type { CatppuccinAccent } from '../shared/types'

const PALETTE: readonly CatppuccinAccent[] = [
  'red', 'peach', 'yellow', 'green', 'teal', 'sky',
  'blue', 'lavender', 'mauve', 'pink', 'flamingo', 'rosewater',
]

/**
 * Map an email to a stable Catppuccin palette accent. Lowercased + trimmed
 * so casing variations don't produce different colours. Deterministic
 * across machines (same email -> same colour everywhere).
 */
export function colourForEmail(email: string): CatppuccinAccent {
  const normalised = email.toLowerCase().trim()
  const hash = createHash('sha256').update(normalised).digest()
  return PALETTE[hash[0] % PALETTE.length]
}
