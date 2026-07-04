import { describe, it, expect } from 'vitest'
import { familyCss, rootFontPx, clampGlobalScale, clampRegionScale } from '../../src/renderer/utils/typography'

describe('familyCss', () => {
  it('maps every key to a distinct stack', () => {
    expect(familyCss('inter')).toContain('Inter')
    expect(familyCss('mono')).toContain('JetBrains Mono')
    expect(familyCss('serif')).toContain('Georgia')
    expect(familyCss('system')).toContain('system-ui')
  })
  it('falls back to inter for an unknown key', () => {
    expect(familyCss('bogus' as never)).toContain('Inter')
  })
})

describe('rootFontPx', () => {
  it('scales a 16px base', () => {
    expect(rootFontPx(1)).toBe(16)
    expect(rootFontPx(1.25)).toBe(20)
    expect(rootFontPx(0.875)).toBe(14)
  })
})

describe('clamps', () => {
  it('bounds global to 0.8..1.3', () => {
    expect(clampGlobalScale(0.5)).toBe(0.8)
    expect(clampGlobalScale(2)).toBe(1.3)
    expect(clampGlobalScale(1.1)).toBe(1.1)
    expect(clampGlobalScale(NaN)).toBe(1)
  })
  it('bounds region to 0.7..1.2', () => {
    expect(clampRegionScale(0.5)).toBe(0.7)
    expect(clampRegionScale(2)).toBe(1.2)
    expect(clampRegionScale(1)).toBe(1)
    expect(clampRegionScale(NaN)).toBe(1)
  })
})
