import { describe, it, expect } from 'vitest'
import { colourForEmail } from '../../../src/main/account-color'
import { IDENTITY_COLOR_KEYS } from '../../../src/shared/identity-colors'

describe('colourForEmail', () => {
  it('returns a key from the curated identity palette', () => {
    expect(IDENTITY_COLOR_KEYS).toContain(colourForEmail('alice@example.com'))
  })

  it('never returns a reserved status/brand/link hue', () => {
    const reserved = ['red', 'peach', 'yellow', 'green', 'teal', 'sky', 'blue', 'copper', 'flamingo', 'rosewater']
    for (const e of ['a@x.com', 'b@y.com', 'c@z.com', 'd@w.com', 'e@v.com', 'f@u.com']) {
      expect(reserved).not.toContain(colourForEmail(e))
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
