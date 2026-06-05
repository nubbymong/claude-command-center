// tests/unit/shared/account-chip-color.test.ts
import { describe, it, expect } from 'vitest'
import {
  canonicaliseEmail,
  resolveAccountChipColorKey,
  resolveAccountNameByEmail,
  resolveAccountColourKey,
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

describe('resolveAccountNameByEmail', () => {
  const profiles = [
    { accountEmail: 'me@example.com', name: 'Personal' },
    { accountEmail: 'work@corp.com', name: 'Work' },
    { accountEmail: '', name: 'Incomplete' },
  ]

  it('returns the profile name when email matches exactly', () => {
    expect(resolveAccountNameByEmail('me@example.com', profiles, undefined)).toBe('Personal')
  })

  it('matches case-insensitively', () => {
    expect(resolveAccountNameByEmail('Me@EXAMPLE.COM', profiles, undefined)).toBe('Personal')
  })

  it('falls back to the email when no profile matches', () => {
    expect(resolveAccountNameByEmail('other@example.com', profiles, undefined)).toBe('other@example.com')
  })

  it('does not match a profile with empty accountEmail', () => {
    // the empty-email profile should never match any real email
    expect(resolveAccountNameByEmail('', profiles, undefined)).toBe('')
  })

  it('falls back to alias when no profile name matches but alias exists', () => {
    const aliases = { 'other@example.com': 'Alias Name' }
    expect(resolveAccountNameByEmail('other@example.com', profiles, aliases)).toBe('Alias Name')
  })

  it('profile name wins over alias', () => {
    const aliases = { 'me@example.com': 'Alias Name' }
    expect(resolveAccountNameByEmail('me@example.com', profiles, aliases)).toBe('Personal')
  })
})

describe('resolveAccountColourKey', () => {
  it('override wins when email and overrides are provided', () => {
    const overrides = { 'me@example.com': 'rose' as const }
    expect(resolveAccountColourKey('Me@Example.com', overrides, 'violet')).toBe('rose')
  })

  it('falls back to the provided fallback when no override', () => {
    expect(resolveAccountColourKey('me@example.com', {}, 'violet')).toBe('violet')
  })

  it('returns mauve when nothing is supplied', () => {
    expect(resolveAccountColourKey(undefined, undefined, undefined)).toBe('mauve')
  })

  it('returns mauve when email is undefined even with overrides', () => {
    const overrides = { 'me@example.com': 'rose' as const }
    expect(resolveAccountColourKey(undefined, overrides, undefined)).toBe('mauve')
  })

  it('returns fallback when override map does not contain the email', () => {
    const overrides = { 'other@example.com': 'rose' as const }
    expect(resolveAccountColourKey('me@example.com', overrides, 'indigo')).toBe('indigo')
  })

  it('returns mauve when fallback is also undefined', () => {
    expect(resolveAccountColourKey('me@example.com', {}, undefined)).toBe('mauve')
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
