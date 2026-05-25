// Curated identity-colour palette (V2 Shell UX spec section 5). Identity is
// stored by stable KEY and resolved to a theme hex at render time, so re-tuning
// a hue edits one table entry -- never stored data. Deliberately excludes every
// reserved semantic hue (status success/warning/danger/info, accent teal, brand
// copper, link/info blue) so identity can never be mistaken for state.

export type IdentityColorKey =
  | 'mauve' | 'violet' | 'lavender' | 'slate-blue' | 'orchid'
  | 'indigo' | 'periwinkle' | 'plum' | 'pink' | 'rose'

export const IDENTITY_COLOR_KEYS: readonly IdentityColorKey[] = [
  'mauve', 'violet', 'lavender', 'slate-blue', 'orchid',
  'indigo', 'periwinkle', 'plum', 'pink', 'rose',
]

export const IDENTITY_PALETTE: Record<IdentityColorKey, { dark: string; light: string }> = {
  'mauve':      { dark: '#9a8cf0', light: '#6d5cc0' },
  'violet':     { dark: '#b57edc', light: '#8a4fb0' },
  'lavender':   { dark: '#a6b4ff', light: '#5566cc' },
  'slate-blue': { dark: '#7b68ee', light: '#5346b8' },
  'orchid':     { dark: '#ba55d3', light: '#9333a8' },
  'indigo':     { dark: '#7b8cff', light: '#4858c8' },
  'periwinkle': { dark: '#8aa0ff', light: '#4a63c2' },
  'plum':       { dark: '#c98cff', light: '#8a44c0' },
  'pink':       { dark: '#ff6ec7', light: '#c43d92' },
  'rose':       { dark: '#ff6b9d', light: '#c23a68' },
}

export function resolveIdentityColor(key: IdentityColorKey, theme: 'dark' | 'light'): string {
  const entry = IDENTITY_PALETTE[key] ?? IDENTITY_PALETTE.mauve
  return theme === 'light' ? entry.light : entry.dark
}

// Exact legacy hexes from the previous 24-swatch picker (spec section 12 table).
const LEGACY_HEX_TO_KEY: Record<string, IdentityColorKey> = {
  '#FF3366': 'rose', '#FF7F50': 'rose', '#FFA07A': 'rose', '#FF4500': 'rose',
  '#FFFF00': 'violet', '#FF9933': 'violet', '#FFB347': 'violet', '#FFD700': 'violet',
  '#00FF7F': 'indigo', '#32CD32': 'indigo', '#7FFF00': 'indigo', '#00FA9A': 'indigo',
  '#00FFFF': 'slate-blue', '#33FFCC': 'slate-blue', '#20B2AA': 'slate-blue', '#00CED1': 'slate-blue',
  '#00BFFF': 'periwinkle', '#4169E1': 'periwinkle',
  '#FF00FF': 'orchid', '#FF6EC7': 'pink', '#FF6B9D': 'rose',
  '#7B68EE': 'slate-blue', '#BA55D3': 'orchid', '#FF1493': 'pink',
}

const LEGACY_NAME_TO_KEY: Record<string, IdentityColorKey> = {
  red: 'rose', maroon: 'rose', peach: 'violet', yellow: 'violet', gold: 'violet',
  green: 'indigo', teal: 'slate-blue', cyan: 'slate-blue', sky: 'periwinkle', blue: 'periwinkle', sapphire: 'periwinkle',
  lavender: 'lavender', mauve: 'mauve', pink: 'pink', flamingo: 'rose', rosewater: 'pink',
}

const RESERVED_ANCHORS: Array<{ hex: string; key: IdentityColorKey }> = [
  { hex: '#FF0000', key: 'rose' },
  { hex: '#FFBF00', key: 'violet' },
  { hex: '#00C000', key: 'indigo' },
  { hex: '#00B0B0', key: 'slate-blue' },
  { hex: '#2E7BFF', key: 'periwinkle' },
]

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}
function dist2(a: [number, number, number], b: [number, number, number]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
}

/**
 * Map a legacy stored colour (raw hex, colour name, or already-a-key) to a
 * curated IdentityColorKey. Priority: existing key -> known name -> exact legacy
 * hex -> nearest-colour fallback (which routes reserved-ish hues to their bucket
 * key, otherwise the nearest identity key). Deterministic.
 */
export function bucketLegacyColorToKey(value: string): IdentityColorKey {
  const raw = value.trim()
  const lower = raw.toLowerCase()
  if ((IDENTITY_COLOR_KEYS as readonly string[]).includes(lower)) return lower as IdentityColorKey
  if (LEGACY_NAME_TO_KEY[lower]) return LEGACY_NAME_TO_KEY[lower]

  const norm = (raw.startsWith('#') ? raw : '#' + raw).toUpperCase()
  if (LEGACY_HEX_TO_KEY[norm]) return LEGACY_HEX_TO_KEY[norm]

  const rgb = hexToRgb(norm)
  if (!rgb) return 'mauve'

  let best: { key: IdentityColorKey; d: number } | null = null
  for (const a of RESERVED_ANCHORS) {
    const d = dist2(rgb, hexToRgb(a.hex)!)
    if (!best || d < best.d) best = { key: a.key, d }
  }
  for (const k of IDENTITY_COLOR_KEYS) {
    const d = dist2(rgb, hexToRgb(IDENTITY_PALETTE[k].dark)!)
    if (!best || d < best.d) best = { key: k, d }
  }
  return best!.key
}
