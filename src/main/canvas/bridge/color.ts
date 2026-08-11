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

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

/** Enough of the CSS named colours to cover authored gradient stops. Computed
 *  styles come back as rgb()/rgba() in every real engine, so this is a fallback
 *  for hand-written values, not the main path. */
const NAMED: Record<string, string> = {
  transparent: 'rgba(0,0,0,0)',
  black: '#000000',
  white: '#ffffff',
  red: '#ff0000',
  green: '#008000',
  blue: '#0000ff',
  yellow: '#ffff00',
  cyan: '#00ffff',
  aqua: '#00ffff',
  magenta: '#ff00ff',
  fuchsia: '#ff00ff',
  gray: '#808080',
  grey: '#808080',
  silver: '#c0c0c0',
  navy: '#000080',
  teal: '#008080',
  olive: '#808000',
  purple: '#800080',
  maroon: '#800000',
  lime: '#00ff00',
  orange: '#ffa500',
}

function clamp255(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)))
}

function channel(token: string): number {
  const t = token.trim()
  if (t.endsWith('%')) return clamp255((parseFloat(t) / 100) * 255)
  return clamp255(parseFloat(t))
}

function alpha(token: string | undefined): number {
  if (token == null) return 1
  const t = token.trim()
  if (t === '') return 1
  const n = t.endsWith('%') ? parseFloat(t) / 100 : parseFloat(t)
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1
}

/** Parse a CSS colour into RGBA. Returns null for anything not understood
 *  (color(), lab(), currentColor, …) so callers can skip rather than guess. */
export function parseColor(value: string | null | undefined): Rgba | null {
  if (!value) return null
  let raw = String(value).trim().toLowerCase()
  if (Object.prototype.hasOwnProperty.call(NAMED, raw)) raw = NAMED[raw]

  if (raw.startsWith('#')) {
    const hex = raw.slice(1)
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

  const fn = /^rgba?\(([^)]*)\)$/.exec(raw)
  if (!fn) return null
  // Both the legacy comma form and the modern `r g b / a` form.
  const [rgbPart, alphaPart] = fn[1].split('/')
  const parts = rgbPart.split(/[,\s]+/).filter((p) => p.length > 0)
  if (parts.length < 3) return null
  return {
    r: channel(parts[0]),
    g: channel(parts[1]),
    b: channel(parts[2]),
    a: alphaPart != null ? alpha(alphaPart) : alpha(parts[3]),
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

/** Every colour stop in a gradient background-image, in source order. Any
 *  gradient flavour (linear/radial/conic, repeating) — the stops are what
 *  matters, not the geometry. */
export function extractGradientStops(backgroundImage: string | null | undefined): Rgba[] {
  if (!backgroundImage || backgroundImage === 'none') return []
  if (!/gradient\(/i.test(backgroundImage)) return []
  const out: Rgba[] = []
  const tokens = backgroundImage.match(/rgba?\([^)]*\)|#[0-9a-f]{3,8}\b|\b[a-z]{3,20}\b/gi) ?? []
  for (const token of tokens) {
    // Skip the gradient/keyword vocabulary so 'to', 'right', 'linear' etc. never
    // parse as a colour.
    const lower = token.toLowerCase()
    if (!lower.startsWith('#') && !lower.startsWith('rgb') && !Object.prototype.hasOwnProperty.call(NAMED, lower)) continue
    const parsed = parseColor(token)
    if (parsed) out.push(parsed)
  }
  return out
}

/** '2.47:1' — the shape the wire format's `measured` field carries. */
export function formatRatio(ratio: number): string {
  return `${Math.round(ratio * 100) / 100}:1`
}
