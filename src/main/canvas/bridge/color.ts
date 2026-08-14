// Colour maths for the snapshot's contrast pass.
//
// Deliberately DOM-free so it unit-tests as plain functions: the P0 gate turned
// on contrast findings being trustworthy, and the part that decides whether a
// finding is real is arithmetic, not layout.
//
// Why this exists next to axe-core at all: axe computes contrast from the
// composited background COLOUR and gives up (`incomplete`) the moment a
// background-image is in play — which on a modern page means every gradient
// surface silently goes unchecked. This module keeps axe's answer where axe has
// one and covers the gradient case by taking the worst stop.
//
// EVERY parse failure here used to be silent, and silence in this file is the
// dangerous direction: a colour that does not parse is skipped, a skipped
// background layer is treated as transparent, and the text is then measured
// against PAGE WHITE and reported as passing. Tailwind v4 emits `oklch()` for
// its whole default palette, so "not understood" was the common case, not the
// exotic one. Two answers to that, in this order: understand the CSS Color 4
// functions (below), and make what is still not understood say so
// (`parsed: false` on a gradient read, `null` from parseColor, both of which
// the caller must now turn into `contrast-not-assessed` rather than a pass).

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/**
 * The CSS named colours, in full.
 *
 * The full list rather than a handful, for a reason beyond completeness: a
 * gradient's argument list is a mix of colours and KEYWORDS (`to`, `right`,
 * `circle`, `at`, `in`, `oklch`, `closest-side`), and the read has to be able to
 * say which bare words it failed to understand. With a partial table
 * `rebeccapurple` is indistinguishable from `farthest-corner` — both are "a word
 * that is not a colour I know" — so either every unknown word makes the gradient
 * unreadable (every gradient on earth) or none does (silently wrong stops). With
 * the full table, a bare word is a colour iff it is in here.
 */
const NAMED: Record<string, string> = {
  transparent: '#00000000',
  aliceblue: '#f0f8ff', antiquewhite: '#faebd7', aqua: '#00ffff', aquamarine: '#7fffd4',
  azure: '#f0ffff', beige: '#f5f5dc', bisque: '#ffe4c4', black: '#000000',
  blanchedalmond: '#ffebcd', blue: '#0000ff', blueviolet: '#8a2be2', brown: '#a52a2a',
  burlywood: '#deb887', cadetblue: '#5f9ea0', chartreuse: '#7fff00', chocolate: '#d2691e',
  coral: '#ff7f50', cornflowerblue: '#6495ed', cornsilk: '#fff8dc', crimson: '#dc143c',
  cyan: '#00ffff', darkblue: '#00008b', darkcyan: '#008b8b', darkgoldenrod: '#b8860b',
  darkgray: '#a9a9a9', darkgreen: '#006400', darkgrey: '#a9a9a9', darkkhaki: '#bdb76b',
  darkmagenta: '#8b008b', darkolivegreen: '#556b2f', darkorange: '#ff8c00', darkorchid: '#9932cc',
  darkred: '#8b0000', darksalmon: '#e9967a', darkseagreen: '#8fbc8f', darkslateblue: '#483d8b',
  darkslategray: '#2f4f4f', darkslategrey: '#2f4f4f', darkturquoise: '#00ced1', darkviolet: '#9400d3',
  deeppink: '#ff1493', deepskyblue: '#00bfff', dimgray: '#696969', dimgrey: '#696969',
  dodgerblue: '#1e90ff', firebrick: '#b22222', floralwhite: '#fffaf0', forestgreen: '#228b22',
  fuchsia: '#ff00ff', gainsboro: '#dcdcdc', ghostwhite: '#f8f8ff', gold: '#ffd700',
  goldenrod: '#daa520', gray: '#808080', green: '#008000', greenyellow: '#adff2f',
  grey: '#808080', honeydew: '#f0fff0', hotpink: '#ff69b4', indianred: '#cd5c5c',
  indigo: '#4b0082', ivory: '#fffff0', khaki: '#f0e68c', lavender: '#e6e6fa',
  lavenderblush: '#fff0f5', lawngreen: '#7cfc00', lemonchiffon: '#fffacd', lightblue: '#add8e6',
  lightcoral: '#f08080', lightcyan: '#e0ffff', lightgoldenrodyellow: '#fafad2', lightgray: '#d3d3d3',
  lightgreen: '#90ee90', lightgrey: '#d3d3d3', lightpink: '#ffb6c1', lightsalmon: '#ffa07a',
  lightseagreen: '#20b2aa', lightskyblue: '#87cefa', lightslategray: '#778899', lightslategrey: '#778899',
  lightsteelblue: '#b0c4de', lightyellow: '#ffffe0', lime: '#00ff00', limegreen: '#32cd32',
  linen: '#faf0e6', magenta: '#ff00ff', maroon: '#800000', mediumaquamarine: '#66cdaa',
  mediumblue: '#0000cd', mediumorchid: '#ba55d3', mediumpurple: '#9370db', mediumseagreen: '#3cb371',
  mediumslateblue: '#7b68ee', mediumspringgreen: '#00fa9a', mediumturquoise: '#48d1cc',
  mediumvioletred: '#c71585', midnightblue: '#191970', mintcream: '#f5fffa', mistyrose: '#ffe4e1',
  moccasin: '#ffe4b5', navajowhite: '#ffdead', navy: '#000080', oldlace: '#fdf5e6',
  olive: '#808000', olivedrab: '#6b8e23', orange: '#ffa500', orangered: '#ff4500',
  orchid: '#da70d6', palegoldenrod: '#eee8aa', palegreen: '#98fb98', paleturquoise: '#afeeee',
  palevioletred: '#db7093', papayawhip: '#ffefd5', peachpuff: '#ffdab9', peru: '#cd853f',
  pink: '#ffc0cb', plum: '#dda0dd', powderblue: '#b0e0e6', purple: '#800080',
  rebeccapurple: '#663399', red: '#ff0000', rosybrown: '#bc8f8f', royalblue: '#4169e1',
  saddlebrown: '#8b4513', salmon: '#fa8072', sandybrown: '#f4a460', seagreen: '#2e8b57',
  seashell: '#fff5ee', sienna: '#a0522d', silver: '#c0c0c0', skyblue: '#87ceeb',
  slateblue: '#6a5acd', slategray: '#708090', slategrey: '#708090', snow: '#fffafa',
  springgreen: '#00ff7f', steelblue: '#4682b4', tan: '#d2b48c', teal: '#008080',
  thistle: '#d8bfd8', tomato: '#ff6347', turquoise: '#40e0d0', violet: '#ee82ee',
  wheat: '#f5deb3', white: '#ffffff', whitesmoke: '#f5f5f5', yellow: '#ffff00',
  yellowgreen: '#9acd32',
}

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/** One numeric component. `none` is zero (CSS Color 4 treats it as such for
 *  everything except interpolation); a percentage is relative to `pct`. */
function component(token: string | undefined, pct: number): number {
  if (token == null) return NaN
  const t = token.trim().toLowerCase()
  if (t === 'none') return 0
  const n = parseFloat(t)
  if (!Number.isFinite(n)) return NaN
  return t.endsWith('%') ? (n / 100) * pct : n
}

/** An <angle>, in degrees. Bare numbers are degrees (CSS Color 4). */
function angle(token: string | undefined): number {
  if (token == null) return NaN
  const t = token.trim().toLowerCase()
  if (t === 'none') return 0
  const n = parseFloat(t)
  if (!Number.isFinite(n)) return NaN
  if (t.endsWith('turn')) return n * 360
  if (t.endsWith('rad')) return (n * 180) / Math.PI
  if (t.endsWith('grad')) return n * 0.9
  return n
}

function alphaOf(token: string | undefined): number {
  if (token == null) return 1
  const t = token.trim().toLowerCase()
  if (t === '') return 1
  if (t === 'none') return 0
  const n = t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t)
  return Number.isFinite(n) ? clamp01(n) : 1
}

/** Split a colour function's arguments into components plus an optional
 *  slash-separated alpha. Returns null for a shape no colour function has. */
function splitArgs(inner: string): { parts: string[]; alpha: string | undefined } | null {
  const bySlash = inner.split('/')
  if (bySlash.length > 2) return null
  const parts = bySlash[0].trim().split(/[\s,]+/).filter((p) => p.length > 0)
  if (parts.length === 0) return null
  return { parts, alpha: bySlash.length === 2 ? bySlash[1] : undefined }
}

// ── colour-space conversions (CSS Color 4) ──────────────────────────────────
// Everything lands in sRGB because WCAG contrast is defined there. A wide-gamut
// colour outside sRGB is CLAMPED, which is what an sRGB display shows anyway;
// the alternative (declining) would make an ordinary `color(display-p3 …)` page
// unreviewable.

function gammaEncode(v: number): number {
  const sign = v < 0 ? -1 : 1
  const abs = Math.abs(v)
  return abs <= 0.0031308 ? v * 12.92 : sign * (1.055 * Math.pow(abs, 1 / 2.4) - 0.055)
}

function gammaDecode(v: number): number {
  const sign = v < 0 ? -1 : 1
  const abs = Math.abs(v)
  return abs <= 0.04045 ? v / 12.92 : sign * Math.pow((abs + 0.055) / 1.055, 2.4)
}

type Vec3 = [number, number, number]
type Mat3 = [Vec3, Vec3, Vec3]

function apply(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
    m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
    m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
  ]
}

const XYZ_D65_TO_LINEAR_SRGB: Mat3 = [
  [3.2409699419045226, -1.537383177570094, -0.4986107602930034],
  [-0.9692436362808796, 1.8759675015077202, 0.04155505740717559],
  [0.05563007969699366, -0.20397695888897652, 1.0569715142428786],
]

/** Bradford chromatic adaptation, the transform CSS Color 4 specifies for the
 *  D50-referred spaces (`lab()`, `lch()`, `color(prophoto-rgb …)`). */
const XYZ_D50_TO_XYZ_D65: Mat3 = [
  [0.9554734527042182, -0.023098536874261423, 0.0632593086610217],
  [-0.028369706963208136, 1.0099954580058226, 0.021041398966943008],
  [0.012314001688319899, -0.020507696433477912, 1.3303659366080753],
]

const LINEAR_P3_TO_XYZ_D65: Mat3 = [
  [0.4865709486482162, 0.26566769316909306, 0.1982172852343625],
  [0.2289745640697488, 0.6917385218365064, 0.079286914093745],
  [0.0, 0.04511338185890264, 1.043944368900976],
]

const LINEAR_REC2020_TO_XYZ_D65: Mat3 = [
  [0.6369580483012914, 0.14461690358620832, 0.1688809751641721],
  [0.2627002120112671, 0.6779980715188708, 0.05930171646986196],
  [0.0, 0.028072693049087428, 1.060985057710791],
]

const LINEAR_A98_TO_XYZ_D65: Mat3 = [
  [0.5766690429101305, 0.1855582379065463, 0.1882286462349947],
  [0.29734497525053605, 0.6273635662554661, 0.07529145849399788],
  [0.02703136138641234, 0.07068885253582723, 0.9913375368376388],
]

const LINEAR_SRGB_TO_LMS: Mat3 = [
  [0.4122214708, 0.5363325363, 0.0514459929],
  [0.2119034982, 0.6806995451, 0.1073969566],
  [0.0883024619, 0.2817188376, 0.6299787005],
]

const LMS_TO_OKLAB: Mat3 = [
  [0.2104542553, 0.793617785, -0.0040720468],
  [1.9779984951, -2.428592205, 0.4505937099],
  [0.0259040371, 0.7827717662, -0.808675766],
]

function linearSrgbToOklab(v: Vec3): Vec3 {
  return apply(LMS_TO_OKLAB, apply(LINEAR_SRGB_TO_LMS, v).map(Math.cbrt) as Vec3)
}

function inSrgbGamut(v: Vec3): boolean {
  return v[0] >= -1e-6 && v[0] <= 1 + 1e-6 && v[1] >= -1e-6 && v[1] <= 1 + 1e-6 && v[2] >= -1e-6 && v[2] <= 1 + 1e-6
}

function clipToGamut(v: Vec3): Vec3 {
  return [Math.min(1, Math.max(0, v[0])), Math.min(1, Math.max(0, v[1])), Math.min(1, Math.max(0, v[2]))]
}

function deltaEOK(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/**
 * CSS Color 4 §13.2 gamut mapping: reduce OKLCh chroma until the colour fits
 * sRGB, keeping lightness and hue.
 *
 * Per-channel clipping — the obvious alternative, and what the first draft of
 * this file did — is what a browser does NOT do, and the gap is not academic
 * here: Tailwind v4's default palette is authored outside sRGB, so `red-600`
 * (`oklch(0.577 0.245 27.325)`) clipped to rgb(231, 0, 11) where every engine
 * paints #dc2626. A contrast ratio computed against the wrong red is a verdict
 * about a colour nobody can see, and near the 4.5 threshold it flips.
 */
function mapToSrgbGamut(linear: Vec3): Vec3 {
  if (inSrgbGamut(linear)) return linear
  const oklab = linearSrgbToOklab(linear)
  const l = oklab[0]
  if (l >= 1) return [1, 1, 1]
  if (l <= 0) return [0, 0, 0]
  const chroma = Math.hypot(oklab[1], oklab[2])
  const hue = Math.atan2(oklab[2], oklab[1])
  const JND = 0.02
  const EPSILON = 0.0001
  let min = 0
  let max = chroma
  let minInGamut = true
  let current = linear
  // Bounded by the bisection itself (chroma halves each pass), but written as a
  // counted loop so no arithmetic surprise can spin it.
  for (let i = 0; i < 32 && max - min > EPSILON; i++) {
    const c = (min + max) / 2
    current = oklabToLinearSrgb(l, c * Math.cos(hue), c * Math.sin(hue))
    if (minInGamut && inSrgbGamut(current)) {
      min = c
      continue
    }
    const clipped = clipToGamut(current)
    const error = deltaEOK(linearSrgbToOklab(clipped), linearSrgbToOklab(current))
    if (error < JND) {
      if (JND - error < EPSILON) return clipped
      minInGamut = false
      min = c
    } else {
      max = c
    }
  }
  return clipToGamut(current)
}

function rgbaFromLinearSrgb(v: Vec3, a: number): Rgba {
  const mapped = mapToSrgbGamut(v)
  return {
    r: clamp255(gammaEncode(mapped[0]) * 255),
    g: clamp255(gammaEncode(mapped[1]) * 255),
    b: clamp255(gammaEncode(mapped[2]) * 255),
    a,
  }
}

function rgbaFromXyzD65(v: Vec3, a: number): Rgba {
  return rgbaFromLinearSrgb(apply(XYZ_D65_TO_LINEAR_SRGB, v), a)
}

/** CIE D50 white point, as CSS Color 4 states it. */
const D50: Vec3 = [0.3457 / 0.3585, 1, (1 - 0.3457 - 0.3585) / 0.3585]

function labToXyzD50(l: number, a: number, b: number): Vec3 {
  const kappa = 24389 / 27
  const epsilon = 216 / 24389
  const fy = (l + 16) / 116
  const fx = a / 500 + fy
  const fz = fy - b / 200
  const x = Math.pow(fx, 3) > epsilon ? Math.pow(fx, 3) : (116 * fx - 16) / kappa
  const y = l > kappa * epsilon ? Math.pow((l + 16) / 116, 3) : l / kappa
  const z = Math.pow(fz, 3) > epsilon ? Math.pow(fz, 3) : (116 * fz - 16) / kappa
  return [x * D50[0], y * D50[1], z * D50[2]]
}

function oklabToLinearSrgb(L: number, a: number, b: number): Vec3 {
  const l = Math.pow(L + 0.3963377773761749 * a + 0.2158037573099136 * b, 3)
  const m = Math.pow(L - 0.1055613458156586 * a - 0.0638541728258133 * b, 3)
  const s = Math.pow(L - 0.0894841775298119 * a - 1.291485548019272 * b, 3)
  return [
    4.076741661347994 * l - 3.307711590408193 * m + 0.230969928729428 * s,
    -1.2684380040921763 * l + 2.6097574006633715 * m - 0.3413193963102197 * s,
    -0.004196086541837188 * l - 0.7034186144594493 * m + 1.7076147009309444 * s,
  ]
}

/** Polar → rectangular for `lch()` / `oklch()`. */
function fromPolar(c: number, h: number): { a: number; b: number } {
  const rad = (h * Math.PI) / 180
  return { a: c * Math.cos(rad), b: c * Math.sin(rad) }
}

/** The fully-saturated colour at this hue, 0..1 per channel — the shared core of
 *  `hsl()` and `hwb()`. (CSS Color 4's HSL helper with lightness 0.5 and
 *  saturation 1, which is exactly `(1 - t) / 2`.) */
function hueToRgb(h: number): Vec3 {
  const hue = ((h % 360) + 360) % 360
  const f = (n: number): number => {
    const k = (n + hue / 30) % 12
    return (1 - Math.max(-1, Math.min(k - 3, 9 - k, 1))) / 2
  }
  return [f(0), f(8), f(4)]
}

/** The colour spaces `color()` names. Anything else declines (returns null) so
 *  the caller reports "not assessed" rather than measuring against a guess. */
function colorFunction(parts: string[], a: number): Rgba | null {
  const space = parts[0].toLowerCase()
  const c1 = component(parts[1], 1)
  const c2 = component(parts[2], 1)
  const c3 = component(parts[3], 1)
  if (!Number.isFinite(c1) || !Number.isFinite(c2) || !Number.isFinite(c3)) return null
  const v: Vec3 = [c1, c2, c3]
  switch (space) {
    case 'srgb':
      return { r: clamp255(c1 * 255), g: clamp255(c2 * 255), b: clamp255(c3 * 255), a }
    case 'srgb-linear':
      return rgbaFromLinearSrgb(v, a)
    case 'display-p3':
      return rgbaFromXyzD65(apply(LINEAR_P3_TO_XYZ_D65, v.map(gammaDecode) as Vec3), a)
    case 'rec2020': {
      // Rec. 2020's own transfer function, not sRGB's.
      const alpha = 1.09929682680944
      const beta = 0.018053968510807
      const lin = v.map((x) => (Math.abs(x) < beta * 4.5 ? x / 4.5 : (x < 0 ? -1 : 1) * Math.pow((Math.abs(x) + alpha - 1) / alpha, 1 / 0.45))) as Vec3
      return rgbaFromXyzD65(apply(LINEAR_REC2020_TO_XYZ_D65, lin), a)
    }
    case 'a98-rgb': {
      const lin = v.map((x) => (x < 0 ? -1 : 1) * Math.pow(Math.abs(x), 563 / 256)) as Vec3
      return rgbaFromXyzD65(apply(LINEAR_A98_TO_XYZ_D65, lin), a)
    }
    case 'xyz':
    case 'xyz-d65':
      return rgbaFromXyzD65(v, a)
    case 'xyz-d50':
      return rgbaFromXyzD65(apply(XYZ_D50_TO_XYZ_D65, v), a)
    default:
      return null
  }
}

/**
 * Memo for parsed colours.
 *
 * A page uses a handful of distinct colour STRINGS and repeats them thousands of
 * times: the backdrop climb alone reads `color` and `background-color` on every
 * ancestor of every candidate. Parsing is pure in the string (the one exception
 * is skipped below), so this never goes stale within or across captures.
 *
 * Capped, and it stops INSERTING at the cap rather than evicting: the working
 * set is a design system's palette, so whatever filled it first is what the page
 * actually uses, and an eviction policy would only add churn on the hot path.
 */
const parseCache = new Map<string, Rgba | null>()
const PARSE_CACHE_MAX = 512

/**
 * Parse a CSS colour into RGBA. Returns null for anything not understood —
 * relative syntax (`rgb(from …)`), `color-mix()`, `color(prophoto-rgb …)`,
 * `currentcolor` with nothing to resolve against — so callers can DECLINE rather
 * than guess. A guess here is measured against page white and printed as a pass.
 */
export function parseColor(value: string | null | undefined, currentColor?: Rgba | null): Rgba | null {
  if (!value) return null
  const key = String(value).trim().toLowerCase()
  // Anything naming `currentcolor` resolves against an ARGUMENT, not the string,
  // so it is the one input the memo cannot answer.
  const memoable = key.length <= 256 && key.indexOf('currentcolor') < 0
  if (memoable) {
    const hit = parseCache.get(key)
    // A copy every time, in and out. Handing the same object to every caller
    // makes one caller's mutation everyone's colour, and the cache outlives the
    // capture.
    if (hit !== undefined) return hit ? { ...hit } : null
  }
  const parsed = parseColorUncached(key, currentColor)
  if (memoable && parseCache.size < PARSE_CACHE_MAX) parseCache.set(key, parsed ? { ...parsed } : null)
  return parsed
}

function parseColorUncached(lowered: string, currentColor?: Rgba | null): Rgba | null {
  let raw = lowered
  if (raw === 'currentcolor') return currentColor ? { ...currentColor } : null
  if (Object.prototype.hasOwnProperty.call(NAMED, raw)) raw = NAMED[raw]

  if (raw.startsWith('#')) {
    const hex = raw.slice(1)
    if (!/^[0-9a-f]+$/.test(hex)) return null
    const expand = (h: string): number => parseInt(h.length === 1 ? h + h : h, 16)
    if (hex.length === 3 || hex.length === 4) {
      return {
        r: expand(hex[0]),
        g: expand(hex[1]),
        b: expand(hex[2]),
        a: hex.length === 4 ? expand(hex[3]) / 255 : 1,
      }
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: expand(hex.slice(0, 2)),
        g: expand(hex.slice(2, 4)),
        b: expand(hex.slice(4, 6)),
        a: hex.length === 8 ? expand(hex.slice(6, 8)) / 255 : 1,
      }
    }
    return null
  }

  const fn = /^([a-z0-9-]+)\((.*)\)$/s.exec(raw)
  if (!fn) return null
  const name = fn[1]
  const inner = fn[2]
  // Relative colour syntax resolves against another colour we do not have.
  if (/^\s*from\b/.test(inner)) return null
  const split = splitArgs(inner)
  if (!split) return null
  const { parts } = split
  // Legacy comma syntax carries alpha as a fourth component; modern syntax uses
  // the slash. `color()` counts its space name as parts[0], so its alpha is
  // parts[4].
  const legacyAlphaAt = name === 'color' ? 4 : 3
  const a = split.alpha != null ? alphaOf(split.alpha) : alphaOf(parts[legacyAlphaAt])

  switch (name) {
    case 'rgb':
    case 'rgba': {
      if (parts.length < 3) return null
      const r = component(parts[0], 255)
      const g = component(parts[1], 255)
      const b = component(parts[2], 255)
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return null
      return { r: clamp255(r), g: clamp255(g), b: clamp255(b), a }
    }
    case 'hsl':
    case 'hsla': {
      if (parts.length < 3) return null
      const h = angle(parts[0])
      const s = component(parts[1], 100) / 100
      const l = component(parts[2], 100) / 100
      if (!Number.isFinite(h) || !Number.isFinite(s) || !Number.isFinite(l)) return null
      const sat = clamp01(s)
      const light = clamp01(l)
      const base = hueToRgb(h)
      const chroma = (1 - Math.abs(2 * light - 1)) * sat
      const rgb = base.map((v) => (v - 0.5) * chroma + light) as Vec3
      return { r: clamp255(rgb[0] * 255), g: clamp255(rgb[1] * 255), b: clamp255(rgb[2] * 255), a }
    }
    case 'hwb': {
      if (parts.length < 3) return null
      const h = angle(parts[0])
      const w = component(parts[1], 100) / 100
      const bl = component(parts[2], 100) / 100
      if (!Number.isFinite(h) || !Number.isFinite(w) || !Number.isFinite(bl)) return null
      const white = clamp01(w)
      const black = clamp01(bl)
      if (white + black >= 1) {
        const grey = white / (white + black)
        return { r: clamp255(grey * 255), g: clamp255(grey * 255), b: clamp255(grey * 255), a }
      }
      const rgb = hueToRgb(h).map((v) => v * (1 - white - black) + white) as Vec3
      return { r: clamp255(rgb[0] * 255), g: clamp255(rgb[1] * 255), b: clamp255(rgb[2] * 255), a }
    }
    case 'lab':
    case 'lch': {
      if (parts.length < 3) return null
      const l = component(parts[0], 100)
      if (!Number.isFinite(l)) return null
      let aa: number
      let bb: number
      if (name === 'lab') {
        aa = component(parts[1], 125)
        bb = component(parts[2], 125)
      } else {
        const c = component(parts[1], 150)
        const h = angle(parts[2])
        if (!Number.isFinite(c) || !Number.isFinite(h)) return null
        const polar = fromPolar(c, h)
        aa = polar.a
        bb = polar.b
      }
      if (!Number.isFinite(aa) || !Number.isFinite(bb)) return null
      return rgbaFromXyzD65(apply(XYZ_D50_TO_XYZ_D65, labToXyzD50(l, aa, bb)), a)
    }
    case 'oklab':
    case 'oklch': {
      if (parts.length < 3) return null
      const l = component(parts[0], 1)
      if (!Number.isFinite(l)) return null
      let aa: number
      let bb: number
      if (name === 'oklab') {
        aa = component(parts[1], 0.4)
        bb = component(parts[2], 0.4)
      } else {
        const c = component(parts[1], 0.4)
        const h = angle(parts[2])
        if (!Number.isFinite(c) || !Number.isFinite(h)) return null
        const polar = fromPolar(c, h)
        aa = polar.a
        bb = polar.b
      }
      if (!Number.isFinite(aa) || !Number.isFinite(bb)) return null
      return rgbaFromLinearSrgb(oklabToLinearSrgb(l, aa, bb), a)
    }
    case 'color': {
      if (parts.length < 4) return null
      return colorFunction(parts, a)
    }
    default:
      return null
  }
}

/** `over` composited onto `under` (source-over), as the compositor would. */
export function composite(over: Rgba, under: Rgba): Rgba {
  const a = over.a + under.a * (1 - over.a)
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }
  const mix = (o: number, u: number): number => Math.round((o * over.a + u * under.a * (1 - over.a)) / a)
  return { r: mix(over.r, under.r), g: mix(over.g, under.g), b: mix(over.b, under.b), a }
}

/** WCAG 2.x relative luminance. */
export function relativeLuminance(c: Rgba): number {
  const lin = (v: number): number => {
    const s = v / 255
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
}

/** WCAG contrast ratio, 1..21. Both colours must already be opaque. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const lighter = Math.max(la, lb)
  const darker = Math.min(la, lb)
  return (lighter + 0.05) / (darker + 0.05)
}

/** WCAG 1.4.3 AA threshold: large text (≥24px, or ≥18.67px when bold) needs 3:1. */
export function requiredContrast(fontSizePx: number, fontWeight: number): number {
  const large = fontSizePx >= 24 || (fontSizePx >= 18.67 && fontWeight >= 700)
  return large ? 3 : 4.5
}

/**
 * What a `background-image` value paints with.
 *
 * Three answers, and keeping them apart is the whole point of the type. The
 * shipped version returned a bare stop array, so "no gradient here" and "a
 * gradient I could not read" were the same empty list — and the caller took the
 * empty list as permission to composite against PAGE WHITE. Tailwind v4 writes
 * its entire palette in `oklch()`, which the old parser did not understand, so
 * near-black text on a near-black hero measured 21:1 against imaginary white and
 * was reported as passing. axe never covers a gradient (it returns `incomplete`
 * for any background-image), so nothing else was looking.
 *
 * - `stops` — every colour stop of every gradient layer, source order.
 * - `parsed` — false when a gradient layer is present and something
 *   colour-shaped in it did not resolve. The caller must DECLINE, not measure.
 * - `hasImage` — a non-gradient picture layer (url/image-set/cross-fade/…) is in
 *   the stack, so the composited colour is not what the text sits on.
 */
export interface BackgroundRead {
  stops: Rgba[]
  parsed: boolean
  hasImage: boolean
}

const NO_BACKGROUND_IMAGE: BackgroundRead = { stops: [], parsed: true, hasImage: false }

/** How much of a background-image value is scanned. A `url(data:…)` layer can be
 *  megabytes; a gradient never is. Over the cap the layer split still runs (it
 *  is linear and allocation-free) but a gradient layer beyond it reads as
 *  unparsed rather than silently contributing the stops it happened to reach. */
const LAYER_SCAN_MAX = 8192

/** Colour functions a stop may be written with. `color-mix()` is deliberately
 *  absent: it resolves to a colour we cannot compute, so it reads as unparsed. */
const COLOR_FUNCTIONS = new Set(['rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color'])

/** Functions that paint a picture rather than a gradient. */
const IMAGE_FUNCTIONS = /^(-\w+-)?(url|image|image-set|cross-fade|element|paint)$/

const GRADIENT_FUNCTION = /^(-\w+-)?(repeating-)?(linear|radial|conic)-gradient$/

/** Split a comma-separated CSS list at TOP level only — a gradient's own
 *  argument commas and any comma inside a quoted url must not split a layer. */
function splitLayers(value: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ',' && depth === 0) {
      out.push(value.slice(start, i))
      start = i + 1
    }
  }
  out.push(value.slice(start))
  return out
}

/** The function a layer is, lowercased and with any vendor prefix intact
 *  (`''` for a bare keyword such as `none`). */
function layerFunction(layer: string): string {
  const m = /^([a-z0-9-]+)\(/i.exec(layer.trim())
  return m ? m[1].toLowerCase() : ''
}

/**
 * Every colour-shaped token in one gradient layer, plus whether anything
 * colour-shaped defeated the parser.
 *
 * Hand-scanned rather than regexed because a stop can hold balanced parens
 * (`oklch(from … calc(l * 2) …)`) and because the scan has to DESCEND into the
 * gradient function itself — the shipped attempt consumed `linear-gradient(…)`
 * as one opaque call and found no stops in any gradient ever written.
 */
function scanStops(source: string, currentColor: Rgba | null | undefined): { stops: Rgba[]; parsed: boolean } {
  const stops: Rgba[] = []
  let parsed = true
  let i = 0
  const end = source.length
  while (i < end) {
    const ch = source[i]
    if (ch === '#') {
      let j = i + 1
      while (j < end && /[0-9a-f]/i.test(source[j])) j++
      const color = parseColor(source.slice(i, j), currentColor)
      if (color) stops.push(color)
      else parsed = false
      i = j
      continue
    }
    if (/[a-z-]/i.test(ch)) {
      let j = i
      while (j < end && /[a-z0-9-]/i.test(source[j])) j++
      const word = source.slice(i, j).toLowerCase()
      if (j < end && source[j] === '(') {
        if (COLOR_FUNCTIONS.has(word) || word === 'color-mix' || IMAGE_FUNCTIONS.test(word)) {
          // Take it whole: its insides are components, not stops.
          let depth = 0
          let k = j
          for (; k < end; k++) {
            if (source[k] === '(') depth++
            else if (source[k] === ')' && --depth === 0) {
              k++
              break
            }
          }
          if (depth !== 0) return { stops, parsed: false } // unterminated
          if (COLOR_FUNCTIONS.has(word)) {
            const color = parseColor(source.slice(i, k), currentColor)
            if (color) stops.push(color)
            else parsed = false
          } else if (word === 'color-mix') {
            parsed = false // a real stop whose value we cannot compute
          }
          i = k
          continue
        }
        // Gradient, calc(), anything else: descend, the stops are INSIDE.
        i = j + 1
        continue
      }
      if (word === 'currentcolor') {
        if (currentColor) stops.push({ ...currentColor })
        else parsed = false
      } else if (Object.prototype.hasOwnProperty.call(NAMED, word)) {
        const color = parseColor(word, currentColor)
        if (color) stops.push(color)
        else parsed = false
      }
      // Anything else is gradient vocabulary (`to`, `at`, `circle`, `in`,
      // `oklch` as an interpolation space, a unit suffix): not a colour, and
      // not a failure to read one.
      i = j
      continue
    }
    i++
  }
  return { stops, parsed }
}

/**
 * Read a computed `background-image` value.
 *
 * Layer by layer, because one value routinely holds both kinds:
 * `url(hero.jpg), linear-gradient(…)` used to test as "has a gradient, has no
 * image" — the whole string matched `/gradient\(/`, which is what the image test
 * excluded on — so a photographic backdrop was measured as if it were the
 * gradient's stops.
 */
export function readBackgroundImage(backgroundImage: string | null | undefined, currentColor?: Rgba | null): BackgroundRead {
  if (!backgroundImage) return NO_BACKGROUND_IMAGE
  const value = String(backgroundImage)
  if (value === 'none' || value.trim() === '') return NO_BACKGROUND_IMAGE

  const stops: Rgba[] = []
  let parsed = true
  let hasImage = false
  let sawGradient = false

  for (const layer of splitLayers(value)) {
    const trimmed = layer.trim()
    if (trimmed === '' || trimmed === 'none') continue
    const fn = layerFunction(trimmed)
    if (GRADIENT_FUNCTION.test(fn)) {
      sawGradient = true
      if (trimmed.length > LAYER_SCAN_MAX) {
        parsed = false
        continue
      }
      const read = scanStops(trimmed, currentColor)
      if (!read.parsed) parsed = false
      for (const stop of read.stops) stops.push(stop)
      continue
    }
    // Not a gradient. A picture layer (or a function we do not know, which we
    // must assume paints something) means the composited colour is not the
    // backdrop.
    hasImage = true
  }

  // A gradient painted with nothing does not exist: zero stops from a layer the
  // scanner was happy with means the scanner is wrong, not that the gradient is
  // empty. Fail closed.
  if (sawGradient && stops.length === 0) parsed = false
  return { stops, parsed, hasImage }
}

/** '2.47:1' — the shape the wire format's `measured` field carries. */
export function formatRatio(ratio: number): string {
  return `${Math.round(ratio * 100) / 100}:1`
}
