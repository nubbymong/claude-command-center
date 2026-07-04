import type { UiFontFamily } from '../stores/settingsStore'

// CSS font stacks for the curated UI-font list. 'inter' is the app default
// (matches body). 'mono' reuses the bundled JetBrains Mono; 'serif' uses the
// same Georgia stack as --serif; 'system' defers to the OS UI font.
const STACKS: Record<UiFontFamily, string> = {
  system: "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  inter: "'Inter', system-ui, sans-serif",
  serif: "'Georgia', serif",
  mono: "'JetBrains Mono', monospace",
}

export function familyCss(key: UiFontFamily): string {
  return STACKS[key] ?? STACKS.inter
}

/** Root <html> font-size in px for a given global scale (base 16px). Rounded to
 *  2dp so rem-based Tailwind utilities land on clean values. */
export function rootFontPx(globalScale: number): number {
  return Math.round(16 * globalScale * 100) / 100
}

/** Global master scale is bounded 0.8..1.3 (invalid input -> 1.0). */
export function clampGlobalScale(n: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.min(1.3, Math.max(0.8, n))
}

/** Per-region factor is bounded 0.7..1.2 relative to global (invalid -> 1.0). */
export function clampRegionScale(n: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.min(1.2, Math.max(0.7, n))
}
