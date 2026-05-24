import { describe, it, expect } from 'vitest'
import { colourForEmail } from '../../../src/main/account-color'

describe('colourForEmail', () => {
  it('returns a value from the Catppuccin palette', () => {
    const PALETTE = ['red','peach','yellow','green','teal','sky','blue','lavender','mauve','pink','flamingo','rosewater']
    expect(PALETTE).toContain(colourForEmail('alice@example.com'))
  })

  it('is deterministic: same email always returns same colour', () => {
    const e = 'alice@example.com'
    expect(colourForEmail(e)).toBe(colourForEmail(e))
  })

  it('is case-insensitive', () => {
    expect(colourForEmail('Alice@Example.COM')).toBe(colourForEmail('alice@example.com'))
  })

  it('is whitespace-insensitive', () => {
    expect(colourForEmail('  alice@example.com  ')).toBe(colourForEmail('alice@example.com'))
  })

  it('produces palette coverage: 10 distinct emails yield at least 5 distinct colours', () => {
    const emails = [
      'a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com',
      'f@x.com', 'g@x.com', 'h@x.com', 'i@x.com', 'j@x.com',
    ]
    const colours = new Set(emails.map(colourForEmail))
    expect(colours.size).toBeGreaterThanOrEqual(5)
  })
})
