// Curated identity-colour palette (V2 Shell UX spec section 5). Identity is
// stored by stable KEY and resolved to a theme hex at render time, so re-tuning
// a hue edits one table entry -- never stored data. Deliberately excludes every
// reserved semantic hue (status success/warning/danger/info, accent teal, brand
// copper, link/info blue) so identity can never be mistaken for state.

export type IdentityColorKey =
  | 'mauve' | 'violet' | 'lavender' | 'slate-blue' | 'orchid'
  | 'indigo' | 'periwinkle' | 'plum' | 'pink' | 'rose'

// Ordered so consecutively-assigned colours (email hash % 10, or any sequential
// pick) land far apart in hue -- two sessions created back to back read as
// instantly distinct rather than two neighbouring violets.
export const IDENTITY_COLOR_KEYS: readonly IdentityColorKey[] = [
  'slate-blue', 'pink', 'indigo', 'violet', 'plum',
  'lavender', 'rose', 'orchid', 'mauve', 'periwinkle',
]

// The KEY names are now STABLE IDENTIFIERS, not literal hues -- they are stored
// in config (identityColorKey) and renaming would need a migration, so the
// names are frozen while the hexes were re-tuned to span the full hue wheel for
// differentiation in the left rail / tab row / inactive dot. The hues now
// spread across the wheel (jewel tones, not neon) and MAY sit near status hues
// (green/amber/red/teal); that overlap is accepted in exchange for sessions
// being instantly distinguishable. `mauve` is unchanged (a test pins it).
export const IDENTITY_PALETTE: Record<IdentityColorKey, { dark: string; light: string }> = {
  'mauve':      { dark: '#9a8cf0', light: '#6d5cc0' }, // violet  ~268 (unchanged)
  'violet':     { dark: '#c071e0', light: '#933fb0' }, // purple-magenta ~300
  'lavender':   { dark: '#5d8bf0', light: '#2f5cc4' }, // blue ~225
  'slate-blue': { dark: '#3ba8d4', light: '#176b94' }, // cyan-blue ~195
  'orchid':     { dark: '#34b39a', light: '#117a68' }, // teal-green ~168
  'indigo':     { dark: '#46b56e', light: '#1f8a48' }, // green ~140
  'periwinkle': { dark: '#9bbf4e', light: '#5f8420' }, // lime-olive ~95
  'plum':       { dark: '#d9a83f', light: '#9c6e18' }, // amber-gold ~50
  'pink':       { dark: '#e8794a', light: '#b85020' }, // orange-coral ~25
  'rose':       { dark: '#ef5f7e', light: '#c23a54' }, // rose-red ~352
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
  // Non-colliding legacy hues kept as their identity equivalent; FF6EC7 / FF6B9D /
  // 7B68EE are themselves palette dark hexes, so they round-trip exactly.
  '#FF00FF': 'orchid', '#FF6EC7': 'pink', '#FF6B9D': 'rose',
  '#7B68EE': 'slate-blue', '#BA55D3': 'orchid', '#FF1493': 'pink',
}

// Colour names from older configs + the prior account palette. Includes names
// beyond the spec's explicit list (maroon / sapphire / gold / cyan) because they
// appear in real saved configs and must bucket deterministically too.
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

/** How bucketLegacyColorToKeySource arrived at its key, for migration counting. */
export type LegacyColorSource = 'key' | 'name' | 'hex' | 'nearest' | 'fallback'

/**
 * Map a legacy stored colour (raw hex, colour name, or already-a-key) to a
 * curated IdentityColorKey, also reporting how the match was made. Priority:
 * existing key -> known name -> exact legacy hex -> nearest-colour fallback
 * (which routes reserved-ish hues to their bucket key, otherwise the nearest
 * identity key) -> neutral fallback for unparseable input. Deterministic.
 */
export function bucketLegacyColorToKeySource(value: string): { key: IdentityColorKey; source: LegacyColorSource } {
  const raw = value.trim()
  const lower = raw.toLowerCase()
  if ((IDENTITY_COLOR_KEYS as readonly string[]).includes(lower)) return { key: lower as IdentityColorKey, source: 'key' }
  if (LEGACY_NAME_TO_KEY[lower]) return { key: LEGACY_NAME_TO_KEY[lower], source: 'name' }

  const norm = (raw.startsWith('#') ? raw : '#' + raw).toUpperCase()
  if (LEGACY_HEX_TO_KEY[norm]) return { key: LEGACY_HEX_TO_KEY[norm], source: 'hex' }

  const rgb = hexToRgb(norm)
  if (!rgb) return { key: 'mauve', source: 'fallback' }

  let best: { key: IdentityColorKey; d: number } | null = null
  for (const a of RESERVED_ANCHORS) {
    const d = dist2(rgb, hexToRgb(a.hex)!)
    if (!best || d < best.d) best = { key: a.key, d }
  }
  for (const k of IDENTITY_COLOR_KEYS) {
    const d = dist2(rgb, hexToRgb(IDENTITY_PALETTE[k].dark)!)
    if (!best || d < best.d) best = { key: k, d }
  }
  return { key: best!.key, source: 'nearest' }
}

/**
 * Map a legacy stored colour to a curated IdentityColorKey. Thin wrapper over
 * bucketLegacyColorToKeySource that drops the match-source detail.
 */
export function bucketLegacyColorToKey(value: string): IdentityColorKey {
  return bucketLegacyColorToKeySource(value).key
}
