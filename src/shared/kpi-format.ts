// kpi-format.ts — the ONE renderer for a KPI value.
//
// Shared deliberately. The cross-account synthesis prompt quotes metric values to
// the model, and the model's prose is displayed directly beside the same values in
// the UI. If main and renderer formatted independently, the model would cite
// "8.4m" next to a table reading "504.0s" and the report would look wrong when it
// was right. One implementation, both processes.

export type KpiFormat = 'number' | 'percent' | 'duration'

/**
 * Render a metric value for display. `duration` is MILLISECONDS (what the
 * extraction prompt asks for); `percent` is a 0-1 proportion.
 */
export function formatMetricValue(value: number, format?: string): string {
  if (format === 'percent') {
    return (value * 100).toFixed(1) + '%'
  }
  if (format === 'duration') {
    if (value >= 60000) return (value / 60000).toFixed(1) + 'm'
    if (value >= 1000) return (value / 1000).toFixed(1) + 's'
    return Math.round(value) + 'ms'
  }
  if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M'
  if (value >= 1000) return (value / 1000).toFixed(1) + 'K'
  if (Number.isInteger(value)) return value.toString()
  return value.toFixed(1)
}

/**
 * Calendar days from `start` to `end` inclusive, or undefined when either date is
 * missing or unparseable.
 *
 * Exists because `period.days` cannot be trusted for this: the extraction model
 * emits ACTIVE days there. Measured on real archives — a 2026-07-09..2026-07-31
 * period (23 calendar days) carries `days: 10`, and a 2026-06-27..2026-07-31 one
 * (35 days) carries `days: 27`. Anything reasoning about window length has to
 * derive it from the dates.
 */
export function spanDaysFromPeriod(period?: { start?: string; end?: string }): number | undefined {
  if (!period?.start || !period?.end) return undefined
  const start = Date.parse(period.start)
  const end = Date.parse(period.end)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined
  return Math.round((end - start) / 86400000) + 1
}

/**
 * Are these reporting windows close enough in length that summing raw counts
 * across them means something? Unknown spans answer NO — a total is only
 * defensible when every window is known and comparable.
 */
export function windowsAreComparable(spans: Array<number | undefined>, tolerance = 1.25): boolean {
  if (spans.length === 0) return false
  if (spans.some((s) => s == null || !(s > 0))) return false
  const known = spans as number[]
  return Math.max(...known) / Math.min(...known) <= tolerance
}
