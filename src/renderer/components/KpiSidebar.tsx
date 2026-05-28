import React, { useState } from 'react'
import type { InsightsData, KpiMetric } from '../types/electron'
import { computeTrends, formatValue, MetricWithTrend } from '../utils/kpiTrends'
import { MetricChip } from './ui/MetricChip'
import type { MetricTone } from './ui/MetricChip'

interface Props {
  current: InsightsData
  previous?: InsightsData | null
}

function TrendArrow({ metric }: { metric: MetricWithTrend }) {
  if (metric.direction === 'same') {
    return <span className="text-overlay0 text-[10px]">=</span>
  }

  const good = metric.goodDirection || 'neutral'
  const isGood =
    good === 'neutral'
      ? null
      : (good === 'up' && metric.direction === 'up') ||
        (good === 'down' && metric.direction === 'down')

  const color = isGood === null ? 'text-overlay0' : isGood ? 'text-green' : 'text-red'
  const arrow = metric.direction === 'up' ? String.fromCodePoint(0x25B2) : String.fromCodePoint(0x25BC)
  const pct = metric.deltaPercent != null ? Math.abs(metric.deltaPercent * 100).toFixed(0) + '%' : ''

  return (
    <span className={`text-xs ${color} flex items-center gap-0.5`}>
      <span className="text-[10px]">{arrow}</span>
      {pct && <span className="text-[10px]">{pct}</span>}
    </span>
  )
}

function SummarySection({ summary }: { summary: NonNullable<InsightsData['summary']> }) {
  const sections: Array<{
    key: string
    items: string[]
    color: string
    bgColor: string
    borderColor: string
    icon: string
    label: string
  }> = []

  if (summary.improvements?.length) {
    sections.push({
      key: 'improvements',
      items: summary.improvements,
      color: 'text-green',
      bgColor: 'bg-green/5',
      borderColor: 'border-green/20',
      icon: String.fromCodePoint(0x25B2),
      label: 'Improvements',
    })
  }
  if (summary.regressions?.length) {
    sections.push({
      key: 'regressions',
      items: summary.regressions,
      color: 'text-red',
      bgColor: 'bg-red/5',
      borderColor: 'border-red/20',
      icon: String.fromCodePoint(0x25BC),
      label: 'Regressions',
    })
  }
  if (summary.suggestions?.length) {
    sections.push({
      key: 'suggestions',
      items: summary.suggestions,
      color: 'text-mauve',
      bgColor: 'bg-mauve/5',
      borderColor: 'border-mauve/20',
      icon: String.fromCodePoint(0x2192),
      label: 'Suggestions',
    })
  }

  if (sections.length === 0) return null

  return (
    <div className="border-b border-surface0">
      {sections.map(({ key, items, color, bgColor, borderColor, icon, label }) => (
        <div key={key} className={`px-3 py-2 ${bgColor} border-b ${borderColor} last:border-b-0`}>
          <div className={`text-[10px] font-semibold uppercase tracking-wider ${color} mb-1.5`}>
            {label}
          </div>
          <ul className="space-y-1">
            {items.map((item, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs">
                <span className={`${color} shrink-0 mt-0.5 text-[10px]`}>{icon}</span>
                <span className="text-subtext0 leading-relaxed">{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

function metricToneFromTrend(metric: MetricWithTrend): MetricTone {
  if (metric.direction === 'same' || metric.previousValue == null) return 'neutral'
  const good = metric.goodDirection || 'neutral'
  if (good === 'neutral') return 'neutral'
  const isGood =
    (good === 'up' && metric.direction === 'up') ||
    (good === 'down' && metric.direction === 'down')
  return isGood ? 'success' : 'danger'
}

function KpiCategory({
  category,
  metrics,
}: {
  category: string
  metrics: Record<string, MetricWithTrend>
}) {
  const [collapsed, setCollapsed] = useState(false)
  const entries = Object.entries(metrics)
  if (entries.length === 0) return null

  return (
    <div className="mb-2">
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="w-full flex items-center gap-1.5 px-2 py-1 text-xs font-semibold uppercase tracking-wider hover:text-text transition-colors"
        style={{ color: 'var(--text-muted)' }}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          className={`transition-transform ${collapsed ? '' : 'rotate-90'}`}
          fill="currentColor"
        >
          <polygon points="3,1 8,5 3,9" />
        </svg>
        {category}
      </button>

      {!collapsed && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '2px 4px 4px' }}>
          {entries.map(([key, metric]) => {
            const tone = metricToneFromTrend(metric)
            const valueStr = formatValue(metric.value, metric.format)
            const displayValue =
              metric.previousValue != null && metric.direction !== 'same' ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  {valueStr}
                  <TrendArrow metric={metric} />
                </span>
              ) : (
                valueStr
              )
            return (
              <MetricChip
                key={key}
                label={metric.label}
                value={displayValue}
                tone={tone}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function ListSection({ name, items }: { name: string; items: Array<{ name: string; count: number }> }) {
  if (!items?.length) return null

  return (
    <div className="px-2 pb-2">
      <div className="px-2 py-1 text-xs font-semibold text-subtext0 uppercase tracking-wider">{name}</div>
      {items.slice(0, 8).map((item, i) => (
        <div key={i} className="flex items-center justify-between px-2 py-0.5">
          <span className="text-xs text-overlay1 truncate mr-2">{item.name}</span>
          <span className="text-xs text-text font-medium tabular-nums">{item.count}</span>
        </div>
      ))}
    </div>
  )
}

/** Synthesise MetricChip rows from well-known flat fields (sessionsCount, totalCostUsd, daysCovered). */
function FlatKpiChips({ current, previous }: { current: InsightsData; previous?: InsightsData | null }) {
  type FlatField = { key: string; label: string; lowerIsBetter: boolean }
  const FIELDS: FlatField[] = [
    { key: 'sessionsCount', label: 'Sessions', lowerIsBetter: false },
    { key: 'totalCostUsd', label: 'Cost', lowerIsBetter: true },
    { key: 'daysCovered', label: 'Days', lowerIsBetter: false },
  ]

  const chips = FIELDS.filter((f) => current[f.key] != null)
  if (chips.length === 0) return null

  return (
    <div style={{ padding: '12px 12px 8px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        className="text-[10px] font-semibold uppercase tracking-wider"
        style={{ color: 'var(--text-muted)', marginBottom: 2 }}
      >
        Key Metrics
      </div>
      {chips.map(({ key, label, lowerIsBetter }) => {
        const val: number = current[key]
        const prev: number | undefined = previous?.[key]
        let tone: MetricTone = 'neutral'
        if (prev != null && prev !== 0) {
          const delta = val - prev
          const improved = lowerIsBetter ? delta < 0 : delta > 0
          tone = improved ? 'success' : delta === 0 ? 'neutral' : 'danger'
        }
        let displayVal: string
        if (key === 'totalCostUsd') {
          displayVal = val >= 10 ? `$${val.toFixed(1)}` : `$${val.toFixed(2)}`
        } else {
          displayVal = String(Math.round(val))
        }
        return <MetricChip key={key} label={label} value={displayVal} tone={tone} />
      })}
    </div>
  )
}

export default function KpiSidebar({ current, previous }: Props) {
  const hasKpis = current.kpis && Object.keys(current.kpis).length > 0
  const hasSummary = current.summary && (
    (current.summary.improvements?.length || 0) +
    (current.summary.regressions?.length || 0) +
    (current.summary.suggestions?.length || 0) > 0
  )
  const hasLists = current.lists && Object.keys(current.lists).length > 0

  const FLAT_FIELDS = ['sessionsCount', 'totalCostUsd', 'daysCovered']
  const hasFlatKpis = FLAT_FIELDS.some((k) => current[k] != null)

  if (!hasKpis && !hasSummary && !hasLists && !hasFlatKpis) {
    return (
      <div className="w-72 bg-mantle border-l border-surface0 p-4 flex items-center justify-center">
        <span className="text-xs text-overlay0">No KPI data available</span>
      </div>
    )
  }

  // Compute trends if we have both current and previous KPI blocks
  const trends = hasKpis
    ? computeTrends(current.kpis!, previous?.kpis)
    : {}

  return (
    <div className="w-72 bg-mantle border-l border-surface0 overflow-y-auto shrink-0">
      {/* Summary bullets — most important, at the top */}
      {hasSummary && <SummarySection summary={current.summary!} />}

      {/* Period info */}
      {current.period && (
        <div className="px-3 py-2 border-b border-surface0">
          <span className="text-[10px] text-overlay0">
            {current.period.start} {String.fromCodePoint(0x2192)} {current.period.end}
            {current.period.days != null && ` (${current.period.days}d)`}
          </span>
        </div>
      )}

      {/* KPI header */}
      {hasKpis && (
        <div className="p-3 border-b border-surface0">
          <h3 className="text-xs font-semibold text-subtext0 uppercase tracking-wider">Key Metrics</h3>
          {previous?.kpis && (
            <span className="text-[10px] text-overlay0">vs previous run</span>
          )}
        </div>
      )}

      {/* Dynamic KPI categories */}
      {hasKpis && (
        <div className="p-2">
          {Object.entries(trends).map(([category, metrics]) => (
            <KpiCategory key={category} category={category} metrics={metrics} />
          ))}
        </div>
      )}

      {/* Flat KPI chips (sessionsCount / totalCostUsd / daysCovered) */}
      {hasFlatKpis && !hasKpis && (
        <FlatKpiChips current={current} previous={previous} />
      )}

      {/* Dynamic lists */}
      {hasLists && (
        <div className="border-t border-surface0 pt-2">
          {Object.entries(current.lists!).map(([name, items]) => (
            <ListSection key={name} name={name} items={items} />
          ))}
        </div>
      )}
    </div>
  )
}
