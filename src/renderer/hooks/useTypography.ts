import { useEffect, type CSSProperties } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import type { TypographyRegionKey } from '../stores/settingsStore'
import { familyCss, rootFontPx, clampGlobalScale, clampRegionScale } from '../utils/typography'

// Global UI typography controller. Mirrors useThemeController: sets the <html>
// root font-size (base 16px x global scale) so every rem-based Tailwind utility
// scales in lockstep, and exposes the global family via --ui-font-family (body
// consumes it in styles.css). The canvas terminal is unaffected. Mount once.
export function useTypographyController(): void {
  const globalScale = useSettingsStore((s) => s.settings.typography?.globalScale ?? 1)
  const globalFamily = useSettingsStore((s) => s.settings.typography?.globalFontFamily ?? 'inter')
  useEffect(() => {
    const root = document.documentElement
    root.style.fontSize = rootFontPx(clampGlobalScale(globalScale)) + 'px'
    root.style.setProperty('--ui-font-family', familyCss(globalFamily))
  }, [globalScale, globalFamily])
}

// Inline style for a region's OUTER wrapper. zoom compounds on the global root
// scale so the factor stays relative; fontFamily overrides the global family for
// that group only. Returns an empty object when the region follows global (no
// zoom, no family) so spreading it into an existing style prop is a no-op.
export function useRegionTypography(region: TypographyRegionKey): CSSProperties {
  const r = useSettingsStore((s) => s.settings.typography?.regions?.[region])
  const style: CSSProperties = {}
  // `zoom` isn't in every csstype version's CSSProperties, so set it off-type.
  // Chromium applies it fine and React passes unknown style keys straight through.
  if (r?.scale != null && r.scale !== 1) (style as Record<string, unknown>).zoom = clampRegionScale(r.scale)
  if (r?.fontFamily) style.fontFamily = familyCss(r.fontFamily)
  return style
}
