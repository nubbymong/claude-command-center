// The arithmetic behind every contrast finding. Pure functions, so this is the
// one part of the snapshot's contrast story that CAN be pinned in Vitest — axe's
// own color-contrast rule does not run under JSDOM (spec §10, testing notes).

import { describe, it, expect } from 'vitest'
import {
  composite,
  contrastRatio,
  extractGradientStops,
  formatRatio,
  parseColor,
  relativeLuminance,
  requiredContrast,
} from '../../../src/main/canvas/bridge/color'

describe('parseColor', () => {
  it('reads the forms a computed style actually returns', () => {
    expect(parseColor('rgb(255, 0, 0)')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseColor('rgba(0, 128, 255, 0.5)')).toEqual({ r: 0, g: 128, b: 255, a: 0.5 })
    // Modern space-separated syntax with a slash alpha.
    expect(parseColor('rgb(10 20 30 / 40%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.4 })
  })

  it('reads authored hex and named colours from gradient stops', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseColor('#1a2b3c')).toEqual({ r: 26, g: 43, b: 60, a: 1 })
    expect(parseColor('#00000080')?.a).toBeCloseTo(0.502, 2)
    expect(parseColor('black')).toEqual({ r: 0, g: 0, b: 0, a: 1 })
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 })
  })

  it('returns null rather than guessing at colour spaces it does not model', () => {
    expect(parseColor('color(display-p3 1 0 0)')).toBeNull()
    expect(parseColor('currentColor')).toBeNull()
    expect(parseColor('')).toBeNull()
    expect(parseColor(null)).toBeNull()
  })
})

describe('composite', () => {
  it('lays a translucent colour over an opaque one the way the compositor does', () => {
    const result = composite({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 })
    expect(result).toEqual({ r: 128, g: 128, b: 128, a: 1 })
  })

  it('is a no-op for a fully opaque overlay', () => {
    const over = { r: 12, g: 34, b: 56, a: 1 }
    expect(composite(over, { r: 255, g: 255, b: 255, a: 1 })).toEqual(over)
  })
})

describe('contrastRatio', () => {
  it('matches the WCAG anchors', () => {
    const white = { r: 255, g: 255, b: 255, a: 1 }
    const black = { r: 0, g: 0, b: 0, a: 1 }
    expect(contrastRatio(white, black)).toBeCloseTo(21, 5)
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5)
    // #767676 on white is the canonical "just passes AA body text" pair.
    expect(contrastRatio({ r: 118, g: 118, b: 118, a: 1 }, white)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio({ r: 128, g: 128, b: 128, a: 1 }, white)).toBeLessThan(4.5)
  })

  it('is symmetric', () => {
    const a = { r: 20, g: 60, b: 90, a: 1 }
    const b = { r: 240, g: 200, b: 10, a: 1 }
    expect(contrastRatio(a, b)).toBeCloseTo(contrastRatio(b, a), 10)
  })

  it('luminance is ordered as expected', () => {
    expect(relativeLuminance({ r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(1, 5)
    expect(relativeLuminance({ r: 0, g: 0, b: 0, a: 1 })).toBeCloseTo(0, 5)
  })
})

describe('requiredContrast', () => {
  it('applies the WCAG large-text threshold', () => {
    expect(requiredContrast(16, 400)).toBe(4.5)
    expect(requiredContrast(24, 400)).toBe(3)
    expect(requiredContrast(19, 700)).toBe(3)
    // Big but not bold enough, and bold but not big enough, both stay at 4.5.
    expect(requiredContrast(19, 400)).toBe(4.5)
    expect(requiredContrast(14, 700)).toBe(4.5)
  })
})

describe('extractGradientStops', () => {
  it('pulls every stop out of a gradient, which is the backdrop axe refuses to judge', () => {
    const stops = extractGradientStops('linear-gradient(90deg, rgb(255, 255, 255) 0%, rgb(17, 17, 17) 100%)')
    expect(stops).toEqual([
      { r: 255, g: 255, b: 255, a: 1 },
      { r: 17, g: 17, b: 17, a: 1 },
    ])
  })

  it('handles radial and repeating flavours, and authored hex stops', () => {
    expect(extractGradientStops('radial-gradient(circle at top, #fff, #000)').length).toBe(2)
    expect(extractGradientStops('repeating-linear-gradient(45deg, #abc 0 10px, #def 10px 20px)').length).toBe(2)
  })

  it('never mistakes gradient keywords for colours', () => {
    // 'to', 'right', 'circle', 'at', 'top', 'deg' units — none are colours.
    expect(extractGradientStops('linear-gradient(to right, rgb(1, 2, 3), rgb(4, 5, 6))')).toHaveLength(2)
  })

  it('ignores non-gradient backgrounds', () => {
    expect(extractGradientStops('url("hero.png")')).toEqual([])
    expect(extractGradientStops('none')).toEqual([])
    expect(extractGradientStops(null)).toEqual([])
  })
})

describe('formatRatio', () => {
  it('renders the wire shape at two decimals', () => {
    expect(formatRatio(2.4712)).toBe('2.47:1')
    expect(formatRatio(21)).toBe('21:1')
  })
})
