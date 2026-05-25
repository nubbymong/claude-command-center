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
