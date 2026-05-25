import { describe, it, expect } from 'vitest'
import {
  IDENTITY_COLOR_KEYS,
  IDENTITY_PALETTE,
  resolveIdentityColor,
  bucketLegacyColorToKey,
  bucketLegacyColorToKeySource,
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

describe('bucketLegacyColorToKey -- legacy 24-swatch picker hexes', () => {
  const cases: Array<[string, IdentityColorKey]> = [
    ['#FF3366', 'rose'], ['#FF7F50', 'rose'], ['#FFA07A', 'rose'], ['#FF4500', 'rose'],
    ['#FFFF00', 'violet'], ['#FF9933', 'violet'], ['#FFB347', 'violet'], ['#FFD700', 'violet'],
    ['#00FF7F', 'indigo'], ['#32CD32', 'indigo'], ['#7FFF00', 'indigo'], ['#00FA9A', 'indigo'],
    ['#00FFFF', 'slate-blue'], ['#33FFCC', 'slate-blue'], ['#20B2AA', 'slate-blue'], ['#00CED1', 'slate-blue'],
    ['#00BFFF', 'periwinkle'], ['#4169E1', 'periwinkle'],
    ['#FF00FF', 'orchid'], ['#FF6EC7', 'pink'], ['#FF6B9D', 'rose'],
    ['#7B68EE', 'slate-blue'], ['#BA55D3', 'orchid'], ['#FF1493', 'pink'],
  ]
  it.each(cases)('maps %s -> %s', (hex, key) => {
    expect(bucketLegacyColorToKey(hex)).toBe(key)
  })
  it('is case-insensitive and tolerates missing #', () => {
    expect(bucketLegacyColorToKey('ff3366')).toBe('rose')
    expect(bucketLegacyColorToKey('#ff3366')).toBe('rose')
  })
})

describe('bucketLegacyColorToKey -- names, passthrough, fallback', () => {
  const names: Array<[string, IdentityColorKey]> = [
    ['red', 'rose'], ['peach', 'violet'], ['yellow', 'violet'], ['green', 'indigo'],
    ['teal', 'slate-blue'], ['sky', 'periwinkle'], ['blue', 'periwinkle'],
    ['lavender', 'lavender'], ['mauve', 'mauve'], ['pink', 'pink'],
    ['flamingo', 'rose'], ['rosewater', 'pink'],
    ['maroon', 'rose'], ['sapphire', 'periwinkle'], ['gold', 'violet'], ['cyan', 'slate-blue'],
  ]
  it.each(names)('maps catppuccin name %s -> %s', (name, key) => {
    expect(bucketLegacyColorToKey(name)).toBe(key)
  })
  it('passes through an existing identity key', () => {
    expect(bucketLegacyColorToKey('indigo')).toBe('indigo')
    expect(bucketLegacyColorToKey('slate-blue')).toBe('slate-blue')
  })
  it('routes an unknown reserved-ish hex to the reserved bucket key', () => {
    expect(bucketLegacyColorToKey('#ff0000')).toBe('rose')
    expect(bucketLegacyColorToKey('#00ff00')).toBe('indigo')
  })
  it('routes an unknown non-status hex to the nearest identity key (pinned)', () => {
    expect(bucketLegacyColorToKey('#8000ff')).toBe('slate-blue')
  })
  it('falls back to mauve for unparseable input (empty / garbage / 3-digit)', () => {
    expect(bucketLegacyColorToKey('')).toBe('mauve')
    expect(bucketLegacyColorToKey('not-a-hex')).toBe('mauve')
    expect(bucketLegacyColorToKey('#fff')).toBe('mauve')
  })
})

describe('bucketLegacyColorToKeySource', () => {
  it('reports source=key for an existing key', () => {
    expect(bucketLegacyColorToKeySource('indigo')).toEqual({ key: 'indigo', source: 'key' })
  })
  it('reports source=name for a known colour name', () => {
    expect(bucketLegacyColorToKeySource('teal')).toEqual({ key: 'slate-blue', source: 'name' })
  })
  it('reports source=hex for a known legacy swatch hex', () => {
    expect(bucketLegacyColorToKeySource('#00FFFF')).toEqual({ key: 'slate-blue', source: 'hex' })
  })
  it('reports source=nearest for an unknown but parseable hex', () => {
    expect(bucketLegacyColorToKeySource('#8000ff')).toEqual({ key: 'slate-blue', source: 'nearest' })
  })
  it('reports source=fallback for unparseable input', () => {
    expect(bucketLegacyColorToKeySource('not-a-hex')).toEqual({ key: 'mauve', source: 'fallback' })
  })
  it('bucketLegacyColorToKey still returns the same key', () => {
    expect(bucketLegacyColorToKey('#00FFFF')).toBe('slate-blue')
  })
})
