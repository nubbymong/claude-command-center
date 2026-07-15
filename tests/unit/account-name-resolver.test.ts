// tests/unit/account-name-resolver.test.ts
import { describe, it, expect } from 'vitest'
import { resolveAccountName } from '../../src/shared/account-chip-color'

describe('resolveAccountName', () => {
  it('prefers a non-empty profile name', () => {
    expect(resolveAccountName('a@me.com', 'Work', { 'a@me.com': 'Aliased' })).toBe('Work')
  })
  it('falls back to the alias map (by canonical email) when no profile name', () => {
    expect(resolveAccountName('A@Me.com', undefined, { 'a@me.com': 'Aliased' })).toBe('Aliased')
  })
  it('falls back to the raw email when neither a profile name nor an alias exists', () => {
    expect(resolveAccountName('a@me.com', undefined, {})).toBe('a@me.com')
    expect(resolveAccountName('a@me.com', '   ', undefined)).toBe('a@me.com')
  })
  it('returns empty string for an empty email with no name', () => {
    expect(resolveAccountName('', undefined, undefined)).toBe('')
  })
})
