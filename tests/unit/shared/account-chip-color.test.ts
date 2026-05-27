// tests/unit/shared/account-chip-color.test.ts
import { describe, it, expect } from 'vitest'
import {
  canonicaliseEmail,
  resolveAccountChipColorKey,
  middleTruncateEmail,
} from '../../../src/shared/account-chip-color'

describe('canonicaliseEmail', () => {
  it('lowercases and trims', () => {
    expect(canonicaliseEmail('  Me@Example.COM ')).toBe('me@example.com')
  })
})

describe('resolveAccountChipColorKey', () => {
  it('prefers a user override, matched by canonical email', () => {
    const overrides = { 'me@example.com': 'rose' as const }
    expect(resolveAccountChipColorKey('  Me@Example.com', 'violet', overrides)).toBe('rose')
  })

  it('falls back to the statusline colour when no override', () => {
    expect(resolveAccountChipColorKey('me@example.com', 'violet', {})).toBe('violet')
  })

  it('falls back to neutral mauve when nothing is supplied', () => {
    expect(resolveAccountChipColorKey('me@example.com', undefined, undefined)).toBe('mauve')
  })

  it('returns neutral when email is undefined', () => {
    expect(resolveAccountChipColorKey(undefined, undefined, { 'x@y.com': 'rose' })).toBe('mauve')
  })
})

describe('middleTruncateEmail', () => {
  it('returns the email unchanged when within the limit', () => {
    expect(middleTruncateEmail('a@b.com', 28)).toBe('a@b.com')
  })

  it('middle-truncates long emails keeping head and tail', () => {
    const out = middleTruncateEmail('nicholas.moger@somecompany.com', 24)
    expect(out.length).toBeLessThanOrEqual(24)
    expect(out).toContain('...')
    expect(out.startsWith('nicholas')).toBe(true)
    expect(out.endsWith('.com')).toBe(true)
  })

  it('returns the email unchanged when max equals its length', () => {
    expect(middleTruncateEmail('abc@d.com', 'abc@d.com'.length)).toBe('abc@d.com')
  })

  it('never exceeds max for tiny max values', () => {
    for (const m of [0, 1, 2, 3]) {
      expect(middleTruncateEmail('someone@example.com', m).length).toBeLessThanOrEqual(m)
    }
  })
})
