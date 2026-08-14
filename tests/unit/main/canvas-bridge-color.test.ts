// The arithmetic behind every contrast finding. Pure functions, so this is the
// one part of the snapshot's contrast story that CAN be pinned in Vitest — axe's
// own color-contrast rule does not run under JSDOM (spec §10, testing notes).

import { describe, it, expect } from 'vitest'
import {
  composite,
  contrastRatio,
  formatRatio,
  parseColor,
  readBackgroundImage,
  relativeLuminance,
  requiredContrast,
  type Rgba,
} from '../../../src/main/canvas/bridge/color'

/** OKLab of an sRGB colour, computed HERE rather than imported, so a test of
 *  the converter is not written in terms of the converter. */
function oklabOf(c: Rgba): [number, number, number] {
  const lin = (v: number): number => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  const r = lin(c.r)
  const g = lin(c.g)
  const b = lin(c.b)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

describe('parseColor', () => {
  it('reads the forms a computed style actually returns', () => {
    expect(parseColor('rgb(255, 0, 0)')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseColor('rgba(0, 128, 255, 0.5)')).toEqual({ r: 0, g: 128, b: 255, a: 0.5 })
    // Modern space-separated syntax with a slash alpha.
    expect(parseColor('rgb(10 20 30 / 40%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.4 })
    expect(parseColor('rgb(50% 0% 100%)')).toEqual({ r: 128, g: 0, b: 255, a: 1 })
    // `none` is zero everywhere except interpolation (CSS Color 4).
    expect(parseColor('rgb(none 128 none)')).toEqual({ r: 0, g: 128, b: 0, a: 1 })
  })

  it('reads authored hex and named colours from gradient stops', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseColor('#1a2b3c')).toEqual({ r: 26, g: 43, b: 60, a: 1 })
    expect(parseColor('#00000080')?.a).toBeCloseTo(0.502, 2)
    expect(parseColor('black')).toEqual({ r: 0, g: 0, b: 0, a: 1 })
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 })
    // The FULL named table, not a handful: a bare word inside a gradient is a
    // colour if and only if it is in that table, so a partial one cannot tell
    // `rebeccapurple` from `farthest-corner`.
    expect(parseColor('rebeccapurple')).toEqual({ r: 102, g: 51, b: 153, a: 1 })
  })

  it('reads hsl and hwb', () => {
    expect(parseColor('hsl(0, 100%, 50%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseColor('hsl(120 100% 50%)')).toEqual({ r: 0, g: 255, b: 0, a: 1 })
    expect(parseColor('hsl(0 0% 50%)')).toEqual({ r: 128, g: 128, b: 128, a: 1 })
    // C=(1-|2L-1|)S=0.48, X=0.24, m=L-C/2=0.16; hue 30 is the (C,X,0) sector.
    expect(parseColor('hsl(30 60% 40%)')).toEqual({ r: 163, g: 102, b: 41, a: 1 })
    expect(parseColor('hsl(0.5turn 100% 50%)')).toEqual({ r: 0, g: 255, b: 255, a: 1 })
    expect(parseColor('hwb(0 0% 0%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseColor('hwb(0 50% 0%)')).toEqual({ r: 255, g: 128, b: 128, a: 1 })
    // Whiteness + blackness ≥ 1 is achromatic, in their ratio.
    expect(parseColor('hwb(0 60% 60%)')).toEqual({ r: 128, g: 128, b: 128, a: 1 })
  })

  it('reads the CSS Color 4 spaces — which is what Tailwind v4 emits', () => {
    // ANCHORS, not remembered outputs: these are sRGB's own primaries expressed
    // in D50 Lab and in OKLab, so the trip back to sRGB has one right answer and
    // it is a number that is already known.
    const near = (got: Rgba | null, r: number, g: number, b: number): void => {
      expect(got).not.toBeNull()
      expect(Math.abs((got as Rgba).r - r)).toBeLessThanOrEqual(2)
      expect(Math.abs((got as Rgba).g - g)).toBeLessThanOrEqual(2)
      expect(Math.abs((got as Rgba).b - b)).toBeLessThanOrEqual(2)
    }
    near(parseColor('lab(100% 0 0)'), 255, 255, 255)
    near(parseColor('lab(54.2905% 80.8124 69.8851)'), 255, 0, 0)
    near(parseColor('lab(87.8181% -79.2711 80.9906)'), 0, 255, 0)
    near(parseColor('lab(29.5683% 68.2986 -112.0294)'), 0, 0, 255)
    near(parseColor('lch(54.2905% 107.0177 40.8526)'), 255, 0, 0)
    near(parseColor('oklab(1 0 0)'), 255, 255, 255)
    near(parseColor('oklab(0.62796 0.22486 0.12585)'), 255, 0, 0)
    near(parseColor('oklab(0.86644 -0.23389 0.17950)'), 0, 255, 0)
    near(parseColor('oklab(0.45201 -0.03246 -0.31153)'), 0, 0, 255)
    near(parseColor('oklch(0.62796 0.25768 29.234)'), 255, 0, 0)
    // Tailwind v4's own palette spelling, against the hex Tailwind publishes.
    near(parseColor('oklch(0.208 0.042 265.755)'), 15, 23, 42) // slate-900 #0f172a
    near(parseColor('oklch(0.984 0.003 247.858)'), 248, 250, 252) // slate-50 #f8fafc
    near(parseColor('color(srgb 1 0 0)'), 255, 0, 0)
    near(parseColor('color(srgb-linear 1 1 1)'), 255, 255, 255)
    near(parseColor('color(xyz-d65 0.35758 0.71517 0.11919)'), 0, 255, 0)
    near(parseColor('color(rec2020 1 1 1)'), 255, 255, 255)
    near(parseColor('color(a98-rgb 1 1 1)'), 255, 255, 255)
    near(parseColor('color(display-p3 0.5 0.5 0.5)'), 128, 128, 128)
  })

  it('gamut-maps rather than clipping, and leaves in-gamut colours alone', () => {
    // Tailwind v4 authors its palette OUTSIDE sRGB (v3's hexes had lower
    // chroma). CSS Color 4 §13.2 keeps lightness and hue and gives up chroma;
    // per-channel clipping — the obvious alternative — moves lightness, and a
    // contrast ratio is almost entirely a statement about lightness.
    for (const [input, wantL, wantHue] of [
      ['oklch(0.577 0.245 27.325)', 0.577, 27.325], // red-600
      ['oklch(0.606 0.25 292.717)', 0.606, 292.717], // violet-500
      ['oklch(0.696 0.17 162.48)', 0.696, 162.48], // emerald-500
      // FAR outside sRGB, which is where clipping and mapping actually part
      // company: the three above are only just outside, and a per-channel clip
      // lands within a JND of the right answer for all of them. Clipped, this
      // one reads L=0.636 against an authored 0.5 and its hue swings 14°.
      ['oklch(0.5 0.5 0)', 0.5, 0],
      ['oklch(0.8 0.4 140)', 0.8, 140],
    ] as const) {
      const got = parseColor(input)
      expect(got).not.toBeNull()
      const [L, a, b] = oklabOf(got as Rgba)
      const hue = ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360
      let dHue = Math.abs(hue - wantHue)
      if (dHue > 180) dHue = 360 - dHue
      // One JND is the tolerance the algorithm itself is allowed to spend.
      expect(Math.abs(L - wantL)).toBeLessThanOrEqual(0.02)
      expect(dHue).toBeLessThanOrEqual(3)
    }

    // And the 99% case is untouched: every in-gamut sRGB colour round-trips
    // through OKLCh back to itself.
    for (const hex of ['#000000', '#ffffff', '#7f7f7f', '#1d4ed8', '#dc2626', '#0f172a']) {
      const direct = parseColor(hex) as Rgba
      const [L, a, b] = oklabOf(direct)
      const round = parseColor(`oklch(${L} ${Math.hypot(a, b)} ${(Math.atan2(b, a) * 180) / Math.PI})`)
      expect(round).not.toBeNull()
      expect(Math.abs((round as Rgba).r - direct.r)).toBeLessThanOrEqual(1)
      expect(Math.abs((round as Rgba).g - direct.g)).toBeLessThanOrEqual(1)
      expect(Math.abs((round as Rgba).b - direct.b)).toBeLessThanOrEqual(1)
    }
  })

  it('returns null rather than guessing at what it does not model', () => {
    // Declining is safe; guessing is the bug. Each of these used to fall through
    // to "no colour here", which the backdrop climb cannot tell from "nothing
    // painted here" — and that composites against page white.
    expect(parseColor('color-mix(in oklab, red, blue)')).toBeNull()
    expect(parseColor('rgb(from red r g b)')).toBeNull()
    expect(parseColor('color(prophoto-rgb 1 1 1)')).toBeNull()
    expect(parseColor('light-dark(#fff, #000)')).toBeNull()
    expect(parseColor('#gg0000')).toBeNull()
    expect(parseColor('rgb(1, 2)')).toBeNull()
    expect(parseColor('currentColor')).toBeNull()
    expect(parseColor('')).toBeNull()
    expect(parseColor(null)).toBeNull()
  })

  it('resolves currentcolor only when given one', () => {
    expect(parseColor('currentcolor', { r: 9, g: 8, b: 7, a: 1 })).toEqual({ r: 9, g: 8, b: 7, a: 1 })
    expect(parseColor('currentcolor', null)).toBeNull()
  })

  it('hands every caller its own object, on the way in AND the way out', () => {
    // The parse memo would otherwise leak one shared record into thousands of
    // call sites, where a single mutation becomes everyone's colour — and the
    // memo outlives the capture.
    //
    // Both directions, because they are separate copies and only one of them is
    // exercised by mutating a MISS: the insert already stores a copy, so
    // scribbling on the first result proves nothing about the read side. The
    // second call is the cache HIT, and that is the one to scribble on.
    const miss = parseColor('rgb(4, 5, 6)') as Rgba
    miss.r = 200
    expect(parseColor('rgb(4, 5, 6)')).toEqual({ r: 4, g: 5, b: 6, a: 1 })
    const hit = parseColor('rgb(4, 5, 6)') as Rgba
    hit.g = 201
    expect(parseColor('rgb(4, 5, 6)')).toEqual({ r: 4, g: 5, b: 6, a: 1 })
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

describe('readBackgroundImage', () => {
  it('pulls every stop out of a gradient, which is the backdrop axe refuses to judge', () => {
    const read = readBackgroundImage('linear-gradient(90deg, rgb(255, 255, 255) 0%, rgb(17, 17, 17) 100%)')
    expect(read.stops).toEqual([
      { r: 255, g: 255, b: 255, a: 1 },
      { r: 17, g: 17, b: 17, a: 1 },
    ])
    expect(read.parsed).toBe(true)
    expect(read.hasImage).toBe(false)
  })

  it('handles every gradient flavour, and authored hex stops', () => {
    expect(readBackgroundImage('radial-gradient(circle at top, #fff, #000)').stops).toHaveLength(2)
    expect(readBackgroundImage('repeating-linear-gradient(45deg, #abc 0 10px, #def 10px 20px)').stops).toHaveLength(2)
    expect(readBackgroundImage('conic-gradient(from 90deg, red, green, blue)').stops).toHaveLength(3)
    expect(readBackgroundImage('-webkit-linear-gradient(top, #fff, #000)').stops).toHaveLength(2)
  })

  it('never mistakes gradient keywords for colours', () => {
    // 'to', 'right', 'circle', 'at', 'top', 'deg' units — none are colours. Nor
    // is `in oklab`, whose space name is spelled like a colour function.
    expect(readBackgroundImage('linear-gradient(to right, rgb(1, 2, 3), rgb(4, 5, 6))').stops).toHaveLength(2)
    expect(readBackgroundImage('linear-gradient(in oklab, red, blue)').stops).toHaveLength(2)
    expect(readBackgroundImage('linear-gradient(90deg, #fff calc(10px + 2%), #000)').stops).toHaveLength(2)
  })

  it('reads the oklch stops Tailwind v4 writes', () => {
    const read = readBackgroundImage('linear-gradient(in oklab, oklch(0.208 0.042 265.755) 0%, oklch(0.129 0.042 264.695) 100%)')
    expect(read.parsed).toBe(true)
    expect(read.stops).toHaveLength(2)
  })

  it('separates "no gradient" from "a gradient I could not read"', () => {
    // The distinction the shipped version did not have. An empty stop list meant
    // both, and the caller took it as permission to composite against page
    // white — so unreadable stops were reported as PASSING.
    expect(readBackgroundImage('none')).toEqual({ stops: [], parsed: true, hasImage: false })
    expect(readBackgroundImage(null)).toEqual({ stops: [], parsed: true, hasImage: false })
    expect(readBackgroundImage('')).toEqual({ stops: [], parsed: true, hasImage: false })

    const mixed = readBackgroundImage('linear-gradient(color-mix(in oklab, red, blue), #000)')
    expect(mixed.parsed).toBe(false)
    // A gradient painted with NOTHING does not exist, so zero stops from a scan
    // that raised no complaint means the scanner is wrong, not that the gradient
    // is empty. Fail closed rather than hand the caller an empty list it cannot
    // tell from "no gradient here".
    expect(readBackgroundImage('linear-gradient(to right)')).toEqual({ stops: [], parsed: false, hasImage: false })
    const relative = readBackgroundImage('linear-gradient(rgb(from red r g b), #000)')
    expect(relative.parsed).toBe(false)
    // Past the scan cap the value is not read at all, and says so.
    const huge = readBackgroundImage(`linear-gradient(${'#fff 0px, '.repeat(2000)}#000)`)
    expect(huge).toEqual({ stops: [], parsed: false, hasImage: false })
  })

  it('classifies picture layers per LAYER, not per value', () => {
    expect(readBackgroundImage('url("hero.png")')).toEqual({ stops: [], parsed: true, hasImage: true })
    expect(readBackgroundImage('image-set("a.png" 1x, "a2.png" 2x)').hasImage).toBe(true)
    // The hole this closes: the whole string matched /gradient\(/, which is what
    // the image test excluded on, so a photographic layer next to a gradient
    // read as "gradient only" and its stops were measured as the backdrop.
    const both = readBackgroundImage('url("hero.png"), linear-gradient(red, blue)')
    expect(both.hasImage).toBe(true)
    expect(both.stops).toHaveLength(2)
    // A comma inside a quoted url is not a layer separator, and a colour word in
    // a filename is not a stop.
    expect(readBackgroundImage('url("a,b.png")')).toEqual({ stops: [], parsed: true, hasImage: true })
    expect(readBackgroundImage('url(red-hero.png)')).toEqual({ stops: [], parsed: true, hasImage: true })
  })
})

describe('formatRatio', () => {
  it('renders the wire shape at two decimals', () => {
    expect(formatRatio(2.4712)).toBe('2.47:1')
    expect(formatRatio(21)).toBe('21:1')
  })
})
