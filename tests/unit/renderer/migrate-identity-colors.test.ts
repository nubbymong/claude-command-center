import { describe, it, expect } from 'vitest'
import { migrateColorRecords } from '../../../src/renderer/utils/migrateIdentityColors'

describe('migrateColorRecords', () => {
  it('maps each status-collision bucket to its key', () => {
    const { records } = migrateColorRecords([
      { color: '#FF3366' }, // red -> rose
      { color: '#FFD700' }, // gold -> violet
      { color: '#32CD32' }, // green -> indigo
      { color: '#00FFFF' }, // teal/cyan -> slate-blue
      { color: '#4169E1' }, // link blue -> periwinkle
    ])
    expect(records.map((r) => r.identityColorKey)).toEqual(['rose', 'violet', 'indigo', 'slate-blue', 'periwinkle'])
  })

  it('keeps a non-colliding colour as its equivalent identity hue', () => {
    const { records } = migrateColorRecords([{ color: '#FF00FF' }]) // -> orchid
    expect(records[0].identityColorKey).toBe('orchid')
  })

  it('routes unknown/invalid colour to the neutral fallback (mauve)', () => {
    const { records, summary } = migrateColorRecords([{ color: 'not-a-hex' }, { color: '' }])
    expect(records[0].identityColorKey).toBe('mauve')
    expect(records[1].identityColorKey).toBe('mauve')
    expect(summary.fallback).toBe(2)
  })

  it('does NOT overwrite an existing valid identityColorKey (skips it)', () => {
    const { records, summary } = migrateColorRecords([{ color: '#FF3366', identityColorKey: 'pink' }])
    expect(records[0].identityColorKey).toBe('pink')        // unchanged
    expect(records[0].legacyColor).toBeUndefined()          // not touched
    expect(summary.skipped).toBe(1)
    expect(summary.changed).toBe(0)
  })

  it('retains legacyColor only on records it actually changed', () => {
    const { records } = migrateColorRecords([
      { color: '#FF3366' },                          // changed -> legacyColor set
      { color: '#FF3366', identityColorKey: 'rose' }, // skipped -> no legacyColor
    ])
    expect(records[0].legacyColor).toBe('#FF3366')
    expect(records[1].legacyColor).toBeUndefined()
  })

  it('preserves other fields and does not delete color', () => {
    const { records } = migrateColorRecords([{ color: '#FF3366', label: 'web' } as any])
    expect((records[0] as any).label).toBe('web')
    expect(records[0].color).toBe('#FF3366')
  })

  it('is idempotent: a second pass changes nothing', () => {
    const first = migrateColorRecords([{ color: '#FF3366' }])
    const second = migrateColorRecords(first.records)
    expect(second.summary.changed).toBe(0)
    expect(second.summary.skipped).toBe(1)
    expect(second.records[0].identityColorKey).toBe('rose')
  })

  it('reports accurate summary counts', () => {
    const { summary } = migrateColorRecords([
      { color: '#FF3366' },                           // changed (hex)
      { color: 'not-a-hex' },                         // changed + fallback
      { color: '#FF3366', identityColorKey: 'rose' }, // skipped
    ])
    expect(summary).toEqual({ scanned: 3, changed: 2, skipped: 1, fallback: 1 })
  })

  it('counts nearest-match (parseable unknown hex) as fallback', () => {
    const { summary } = migrateColorRecords([{ color: '#8000ff' }]) // nearest
    expect(summary.fallback).toBe(1)
    expect(summary.changed).toBe(1)
  })
})
