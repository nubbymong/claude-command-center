import { describe, it, expect } from 'vitest'
import { coerceArray, coerceObject } from '../../../src/renderer/utils/configHydration'

// P2.4 hydration guards. The load-bearing property: VALID config passes through
// untouched (these run on the boot path and must never wipe a real config
// section). Only genuinely-malformed shapes — wrong-type sections, non-object
// array entries — are dropped, with a warning.
describe('coerceArray (P2.4)', () => {
  it('passes a valid array of objects through untouched', () => {
    const warnings: string[] = []
    const input = [{ id: 'a' }, { id: 'b', extra: 1 }]
    expect(coerceArray(input, 'configs', warnings)).toEqual(input)
    expect(warnings).toEqual([])
  })

  it('drops non-object entries with a warning, keeping the valid ones', () => {
    const warnings: string[] = []
    const out = coerceArray([{ id: 'a' }, 'bad', null, 42, ['x'], { id: 'b' }], 'configs', warnings)
    expect(out).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('configs')
  })

  it('defaults a present-but-non-array section to [] with a warning', () => {
    const warnings: string[] = []
    expect(coerceArray({ not: 'an array' }, 'configs', warnings)).toEqual([])
    expect(warnings.length).toBe(1)
  })

  it('treats absent (undefined/null) sections as [] WITHOUT warning', () => {
    const warnings: string[] = []
    expect(coerceArray(undefined, 'configs', warnings)).toEqual([])
    expect(coerceArray(null, 'configs', warnings)).toEqual([])
    expect(warnings).toEqual([])
  })
})

describe('coerceObject (P2.4)', () => {
  it('passes a plain object through untouched', () => {
    const warnings: string[] = []
    const input = { a: 1, b: { c: 2 } }
    expect(coerceObject(input, 'settings', warnings)).toEqual(input)
    expect(warnings).toEqual([])
  })

  it('defaults arrays and primitives to {} with a warning', () => {
    const warnings: string[] = []
    expect(coerceObject(['array'], 'settings', warnings)).toEqual({})
    expect(coerceObject('str', 'settings', warnings)).toEqual({})
    expect(warnings.length).toBe(2)
  })

  it('treats absent (undefined/null) sections as {} WITHOUT warning', () => {
    const warnings: string[] = []
    expect(coerceObject(undefined, 'settings', warnings)).toEqual({})
    expect(coerceObject(null, 'settings', warnings)).toEqual({})
    expect(warnings).toEqual([])
  })
})
