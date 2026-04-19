/**
 * Compact "X ago" formatter for timestamps. Used by GitHub sidebar sections
 * (Reviews, Actions, Local Git commits, Last synced) and any other UI that
 * wants a short, consistent relative-time label.
 *
 * Not locale-aware — returns English-only short forms. If we ever add i18n
 * to the renderer, swap this for `Intl.RelativeTimeFormat` at that point.
 */
export function relativeTime(epochMs: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - epochMs)
  const s = Math.floor(diff / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  const mo = Math.floor(d / 30)
  if (mo < 12) return `${mo}mo ago`
  // Derive years from the month count, not days. 30-day months and 365-day
  // years don't agree at the boundary — 364d gives mo=12 but d/365=0, which
  // would render as "0y ago". Flooring on months keeps y>=1 once we're here.
  const y = Math.floor(mo / 12)
  return `${y}y ago`
}
