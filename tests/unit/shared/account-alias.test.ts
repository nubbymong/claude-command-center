import { describe, it, expect } from 'vitest'
import {
  canonicaliseEmail,
  resolveAliasForSession,
  isValidEmailShape,
  isValidAliasLength,
} from '../../../src/shared/account-alias'

describe('canonicaliseEmail', () => {
  it('lowercases the address', () => {
    expect(canonicaliseEmail('Nicholas@Example.com')).toBe('nicholas@example.com')
  })

  it('trims surrounding whitespace', () => {
    expect(canonicaliseEmail('  me@x.com  ')).toBe('me@x.com')
  })
})

describe('resolveAliasForSession', () => {
  const aliases = [
    { email: 'nicholas@live.co.uk', alias: 'personal' },
    { email: 'nicholas.moger@me.com', alias: 'work' },
  ]

  it('returns the alias when the email matches an entry', () => {
    expect(resolveAliasForSession('nicholas.moger@me.com', aliases)).toBe('work')
  })

  it('matches case-insensitively / with whitespace via canonicalisation', () => {
    expect(resolveAliasForSession('  Nicholas@Live.CO.UK ', aliases)).toBe('personal')
  })

  it('returns undefined when no alias matches', () => {
    expect(resolveAliasForSession('stranger@x.com', aliases)).toBeUndefined()
  })

  it('returns undefined when aliasEmail is undefined', () => {
    expect(resolveAliasForSession(undefined, aliases)).toBeUndefined()
  })

  it('returns undefined when aliases list is undefined or empty', () => {
    expect(resolveAliasForSession('a@b.com', undefined)).toBeUndefined()
    expect(resolveAliasForSession('a@b.com', [])).toBeUndefined()
  })
})

describe('isValidEmailShape', () => {
  it('accepts a simple email', () => {
    expect(isValidEmailShape('me@example.com')).toBe(true)
  })

  it('rejects missing @ or domain pieces', () => {
    expect(isValidEmailShape('notanemail')).toBe(false)
    expect(isValidEmailShape('foo@bar')).toBe(false)
    expect(isValidEmailShape('@x.com')).toBe(false)
    expect(isValidEmailShape('a@@b.com')).toBe(false)
  })

  it('rejects whitespace inside the address', () => {
    expect(isValidEmailShape('a b@c.com')).toBe(false)
  })
})

describe('isValidAliasLength', () => {
  it('accepts 1 to 16 characters after trim', () => {
    expect(isValidAliasLength('a')).toBe(true)
    expect(isValidAliasLength('work')).toBe(true)
    expect(isValidAliasLength('sixteenchars1234')).toBe(true) // exactly 16
  })

  it('rejects empty or whitespace-only', () => {
    expect(isValidAliasLength('')).toBe(false)
    expect(isValidAliasLength('   ')).toBe(false)
  })

  it('rejects > 16 characters after trim', () => {
    expect(isValidAliasLength('seventeenchars123')).toBe(false)
  })

  it('trims before measuring length', () => {
    expect(isValidAliasLength('  work  ')).toBe(true)
  })
})
