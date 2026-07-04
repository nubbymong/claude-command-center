import type { AppSettings, TypographySettings, TypographyRegionKey } from './settingsStore'
import { clampRegionScale } from '../utils/typography'

const REGION_KEYS: TypographyRegionKey[] = ['status', 'sidebar', 'header', 'panels']

// Produce a fully-formed TypographySettings on hydrate. If the saved config
// already carries a `typography` blob, deep-merge it over defaults (fresh region
// objects, never sharing the DEFAULT_TYPOGRAPHY references). Otherwise seed
// defaults and fold the legacy statusLine.font/fontSize into the Status-bars
// region so an existing statusline size/font is preserved on first upgrade.
export function migrateTypography(settings: Partial<AppSettings>): TypographySettings {
  const regions = { status: {}, sidebar: {}, header: {}, panels: {} } as Record<TypographyRegionKey, { scale?: number; fontFamily?: TypographySettings['regions']['status']['fontFamily'] }>

  const existing = settings.typography
  if (existing && typeof existing.globalScale === 'number') {
    for (const k of REGION_KEYS) regions[k] = { ...(existing.regions?.[k] || {}) }
    return {
      globalScale: existing.globalScale,
      globalFontFamily: existing.globalFontFamily ?? 'inter',
      regions,
    }
  }

  // Legacy migration: base statusline size was 12; map any non-default size into
  // the Status-bars region factor, and a legacy mono statusline font into its family.
  const sl = settings.statusLine as { fontSize?: number; font?: string } | undefined
  if (sl) {
    if (typeof sl.fontSize === 'number' && sl.fontSize !== 12) {
      regions.status.scale = clampRegionScale(sl.fontSize / 12)
    }
    if (sl.font === 'mono') regions.status.fontFamily = 'mono'
  }
  return { globalScale: 1, globalFontFamily: 'inter', regions }
}
