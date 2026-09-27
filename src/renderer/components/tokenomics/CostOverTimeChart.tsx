import React, { useMemo } from 'react'
import type { TkProvider } from '../../../shared/types'
import { TK_PROVIDER_LABEL, TK_PROVIDER_COLOR } from './tk-labels'

interface DataPoint {
  day: string
  costUsd: number
  /** Usage track MP11/MP12: the day's cost per provider. */
  byProvider?: Partial<Record<TkProvider, number>>
}

interface Props {
  data: DataPoint[]
  /** MP12 (Q1.4): the providers drawn as their own series, when both have
   *  usage in these figures. */
  series?: TkProvider[]
}

function formatCostShort(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 10) return `$${usd.toFixed(1)}`
  return `$${usd.toFixed(2)}`
}

function formatDayLabel(day: string): string {
  // day = 'YYYY-MM-DD'
  return day.slice(5) // 'MM-DD'
}

/**
 * Area + line chart of daily cost over time, built with inline SVG (matching
 * the existing DailyChart approach — no external charting library).
 */
export function CostOverTimeChart({ data, series }: Props) {
  const split = series && series.length > 1 ? series : null
  const CHART_W = 460
  const CHART_H = 110
  const LABEL_H = 16
  const SVG_H = CHART_H + LABEL_H

  const { points, maxCost } = useMemo(() => {
    if (!data || data.length === 0) return { points: [], maxCost: 0 }
    const max = Math.max(...data.map((d) => d.costUsd), 0.001)
    const pts = data.map((d, i) => ({
      ...d,
      x: data.length === 1 ? CHART_W / 2 : (i / (data.length - 1)) * CHART_W,
      y: CHART_H - (d.costUsd / max) * CHART_H * 0.88 - 4,
    }))
    return { points: pts, maxCost: max }
  }, [data])

  // MP12: one line per provider, on the same scale as the total.
  const seriesPaths = useMemo(() => {
    if (!split || points.length === 0) return []
    return split.map((p) => ({
      provider: p,
      d: points
        .map((pt, i) => {
          const v = pt.byProvider?.[p] ?? 0
          const y = CHART_H - (v / maxCost) * CHART_H * 0.88 - 4
          return `${i === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${y.toFixed(1)}`
        })
        .join(' '),
    }))
  }, [split, points, maxCost])

  if (!data || data.length === 0) {
    return (
      <div
        className="rounded-xl p-4 flex items-center justify-center"
        style={{
          background: 'var(--surface-raised)',
          border: '1px solid var(--border-subtle)',
          minHeight: 160,
        }}
      >
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No data in range</div>
      </div>
    )
  }

  // Build SVG path for the line
  const linePath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(' ')

  // Build SVG path for the filled area (close to bottom)
  const firstX = points[0].x.toFixed(1)
  const lastX = points[points.length - 1].x.toFixed(1)
  const areaPath = `${linePath} L ${lastX} ${CHART_H} L ${firstX} ${CHART_H} Z`

  // Label every ~7th point (or every 5th if <= 14 points)
  const labelEvery = data.length <= 14 ? 3 : 6

  return (
    <div
      className="rounded-xl p-4"
      style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="flex items-center gap-3 mb-3">
        <div className="text-[11px] text-overlay0 uppercase tracking-wider">
          Cost over time
        </div>
        {split && (
          <div className="flex items-center gap-2 ml-auto" data-testid="tk-cost-series-legend">
            {split.map((p) => (
              <span key={p} className="flex items-center gap-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                <span className="rounded-sm" style={{ width: 8, height: 2, background: TK_PROVIDER_COLOR[p] }} />
                {TK_PROVIDER_LABEL[p]}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="overflow-x-auto">
        <svg
          width="100%"
          viewBox={`0 0 ${CHART_W} ${SVG_H}`}
          preserveAspectRatio="none"
          style={{ minHeight: SVG_H, display: 'block' }}
        >
          <defs>
            <linearGradient id="tk-area-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {/* Area fill */}
          <path d={areaPath} fill="url(#tk-area-grad)" />
          {/* Line (the total), or one line per provider (MP12) */}
          {split ? seriesPaths.map((s) => (
            <path
              key={s.provider}
              d={s.d}
              fill="none"
              stroke={TK_PROVIDER_COLOR[s.provider]}
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              data-testid={`tk-cost-series-${s.provider}`}
            />
          )) : (
            <path
              d={linePath}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}
          {/* Data point dots + tooltips */}
          {points.map((p, i) => {
            const showLabel = i % labelEvery === 0 || i === points.length - 1
            return (
              <g key={p.day}>
                {p.costUsd > 0 && (
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={2.5}
                    fill="var(--accent)"
                    opacity={0.85}
                  />
                )}
                <title>{split
                  ? `${p.day}: ${split.map((s) => `${TK_PROVIDER_LABEL[s]} ${formatCostShort(p.byProvider?.[s] ?? 0)}`).join(', ')}`
                  : `${p.day}: ${formatCostShort(p.costUsd)}`}</title>
                {showLabel && (
                  <text
                    x={p.x}
                    y={CHART_H + 12}
                    textAnchor="middle"
                    fontSize="8"
                    fill="var(--text-muted)"
                  >
                    {formatDayLabel(p.day)}
                  </text>
                )}
              </g>
            )
          })}
          {/* Max label */}
          {maxCost > 0 && (
            <text x="2" y="10" fontSize="7" fill="var(--text-muted)">
              {formatCostShort(maxCost)}
            </text>
          )}
        </svg>
      </div>
    </div>
  )
}
