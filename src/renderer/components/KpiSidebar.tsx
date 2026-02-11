import React, { useState } from 'react'
import type { InsightsData, KpiMetric } from '../types/electron'
import { computeTrends, formatValue, MetricWithTrend } from '../utils/kpiTrends'

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
        className="w-full flex items-center gap-1.5 px-2 py-1 text-xs font-semibold text-subtext0 uppercase tracking-wider hover:text-text transition-colors"
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
        <div className="space-y-0.5 mt-0.5">
          {entries.map(([key, metric]) => (
            <div key={key} className="flex items-center justify-between px-2 py-1 rounded hover:bg-surface0/50">
              <span className="text-xs text-overlay1 truncate mr-2">{metric.label}</span>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-xs text-text font-medium tabular-nums">
                  {formatValue(metric.value, metric.format)}
                </span>
                {metric.previousValue != null && <TrendArrow metric={metric} />}
              </div>
            </div>
          ))}
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

export default function KpiSidebar({ current, previous }: Props) {
  const hasKpis = current.kpis && Object.keys(current.kpis).length > 0
  const hasSummary = current.summary && (
    (current.summary.improvements?.length || 0) +
    (current.summary.regressions?.length || 0) +
    (current.summary.suggestions?.length || 0) > 0
  )
  const hasLists = current.lists && Object.keys(current.lists).length > 0

  if (!hasKpis && !hasSummary && !hasLists) {
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
