import { describe, it, expect } from 'vitest'
import { defaultPickerProfileId } from '../../../src/renderer/lib/account-picker'
import type { AccountProfile } from '../../../src/shared/account-types'

function profile(id: string, overrides: Partial<AccountProfile> = {}): AccountProfile {
  return {
    id,
    name: id,
    accountEmail: `${id}@example.com`,
    createdAt: 0,
    ...overrides,
  }
}

describe('defaultPickerProfileId', () => {
  it('returns the explicit initial profileId when provided, even if a primary exists', () => {
    const profiles = [profile('a', { isPrimary: true }), profile('b')]
    expect(defaultPickerProfileId(profiles, 'b')).toBe('b')
  })

  it('returns the primary profile id when no initial is provided', () => {
    const profiles = [profile('a'), profile('b', { isPrimary: true })]
    expect(defaultPickerProfileId(profiles, undefined)).toBe('b')
  })

  it('returns empty string (default account) when no initial and no primary', () => {
    const profiles = [profile('a'), profile('b')]
    expect(defaultPickerProfileId(profiles, undefined)).toBe('')
  })

  it('returns empty string when there are no profiles at all', () => {
    expect(defaultPickerProfileId([], undefined)).toBe('')
  })

  it('treats an empty-string initial the same as no initial (falls back to primary)', () => {
    const profiles = [profile('a', { isPrimary: true })]
    expect(defaultPickerProfileId(profiles, '')).toBe('a')
  })

  it('honours an explicit empty initial that does not match any primary by falling back', () => {
    // Empty initial is indistinguishable from "no selection"; primary wins.
    const profiles = [profile('a'), profile('b')]
    expect(defaultPickerProfileId(profiles, '')).toBe('')
  })
})
