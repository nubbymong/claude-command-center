import { describe, it, expect } from 'vitest'
import { colourForEmail } from '../../../src/main/account-color'
import { IDENTITY_COLOR_KEYS } from '../../../src/shared/identity-colors'

describe('colourForEmail', () => {
  it('returns a key from the curated identity palette', () => {
    expect(IDENTITY_COLOR_KEYS).toContain(colourForEmail('alice@example.com'))
  })

  it('stays inside the curated identity palette across a large sample', () => {
    // The curation guarantee: every output is a member of the curated palette,
    // which by construction excludes every reserved status / brand / link hue.
    // Sampling many distinct emails exercises the full modulo index range and
    // proves the implementation never produces an out-of-range / undefined key.
    for (let i = 0; i < 200; i++) {
      expect(IDENTITY_COLOR_KEYS).toContain(colourForEmail(`sample${i}@example.com`))
    }
  })

  it('is deterministic: same email always returns same key', () => {
    const e = 'alice@example.com'
    expect(colourForEmail(e)).toBe(colourForEmail(e))
  })

  it('is case-insensitive', () => {
    expect(colourForEmail('Alice@Example.COM')).toBe(colourForEmail('alice@example.com'))
  })

  it('is whitespace-insensitive', () => {
    expect(colourForEmail('  alice@example.com  ')).toBe(colourForEmail('alice@example.com'))
  })

  it('produces palette coverage: 20 distinct emails yield at least 5 distinct keys', () => {
    const emails = Array.from({ length: 20 }, (_, i) => `user${i}@example.com`)
    const keys = new Set(emails.map(colourForEmail))
    expect(keys.size).toBeGreaterThanOrEqual(5)
  })
})
