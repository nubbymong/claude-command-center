import type { KpiMetric } from '../types/electron'
import { formatMetricValue } from '../../shared/kpi-format'

/**
 * Re-exported from shared/kpi-format so the main process can render the SAME
 * values into the cross-account synthesis prompt. The model's prose is shown
 * beside these numbers; two formatters would let it cite a value the table
 * disagrees with.
 */
export const formatValue = formatMetricValue

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
