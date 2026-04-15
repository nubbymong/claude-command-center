import type { KpiMetric } from '../types/electron'

export function formatValue(value: number, format?: string): string {
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

// Compare two KPI sets and compute delta/direction for each metric
export interface MetricWithTrend extends KpiMetric {
  previousValue?: number
  delta?: number
  deltaPercent?: number
  direction: 'up' | 'down' | 'same'
}

const THRESHOLD = 0.05 // 5% change threshold

export function computeTrends(
  current: Record<string, Record<string, KpiMetric>>,
  previous?: Record<string, Record<string, KpiMetric>> | null
): Record<string, Record<string, MetricWithTrend>> {
  const result: Record<string, Record<string, MetricWithTrend>> = {}

  for (const [category, metrics] of Object.entries(current)) {
    result[category] = {}
    for (const [key, metric] of Object.entries(metrics)) {
      const prevMetric = previous?.[category]?.[key]
      const prevValue = prevMetric?.value

      if (prevValue != null && prevValue !== 0) {
        const delta = metric.value - prevValue
        const deltaPercent = delta / Math.abs(prevValue)
        const direction = Math.abs(deltaPercent) < THRESHOLD ? 'same' : delta > 0 ? 'up' : 'down'
        result[category][key] = {
          ...metric,
          previousValue: prevValue,
          delta,
          deltaPercent,
          direction,
        }
      } else {
        result[category][key] = { ...metric, direction: 'same' }
      }
    }
  }

  return result
}
