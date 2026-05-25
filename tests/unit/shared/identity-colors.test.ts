import { describe, it, expect } from 'vitest'
import {
  IDENTITY_COLOR_KEYS,
  IDENTITY_PALETTE,
  resolveIdentityColor,
  type IdentityColorKey,
} from '../../../src/shared/identity-colors'

describe('identity palette + resolver', () => {
  it('has 10 keys, all lowercase, no status/brand/link hues by name', () => {
    expect(IDENTITY_COLOR_KEYS.length).toBe(10)
    for (const k of IDENTITY_COLOR_KEYS) expect(k).toMatch(/^[a-z-]+$/)
    for (const banned of ['red', 'green', 'teal', 'amber', 'yellow', 'sky', 'blue', 'copper']) {
      expect(IDENTITY_COLOR_KEYS).not.toContain(banned)
    }
  })
  it('every key resolves to a 6-digit hex in both themes', () => {
    for (const k of IDENTITY_COLOR_KEYS) {
      expect(resolveIdentityColor(k, 'dark')).toMatch(/^#[0-9a-fA-F]{6}$/)
      expect(resolveIdentityColor(k, 'light')).toMatch(/^#[0-9a-fA-F]{6}$/)
    }
  })
  it('dark and light differ for each key (theme-specific)', () => {
    for (const k of IDENTITY_COLOR_KEYS) {
      expect(resolveIdentityColor(k, 'dark')).not.toBe(resolveIdentityColor(k, 'light'))
    }
  })
  it('resolves the documented mauve values', () => {
    expect(resolveIdentityColor('mauve', 'dark')).toBe('#9a8cf0')
    expect(resolveIdentityColor('mauve', 'light')).toBe('#6d5cc0')
  })
  it('falls back to mauve for an unknown key (defensive)', () => {
    expect(resolveIdentityColor('not-a-key' as IdentityColorKey, 'dark'))
      .toBe(IDENTITY_PALETTE.mauve.dark)
  })
})
