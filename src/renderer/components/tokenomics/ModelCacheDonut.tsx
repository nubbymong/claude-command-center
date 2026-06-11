import React, { useMemo } from 'react'
import type { TkSummary } from '../../../shared/types'
import { getModelColor, getModelShort } from './modelColors'

function formatCostShort(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 10) return `$${usd.toFixed(1)}`
  return `$${usd.toFixed(2)}`
}

const MAX_SLICES = 5

interface DonutSlice {
  label: string
  value: number
  color: string
  pct: number
}

/**
 * Returns an array of SVG arc path descriptions for a donut chart.
 * cx/cy = centre, r = outer radius, innerR = inner radius.
 */
function buildDonutPaths(
  slices: DonutSlice[],
  cx: number, cy: number, r: number, innerR: number
): Array<{ d: string; color: string; label: string; pct: number }> {
  const total = slices.reduce((s, x) => s + x.value, 0)
  if (total === 0) return []

  const paths: Array<{ d: string; color: string; label: string; pct: number }> = []
  let angle = -Math.PI / 2 // start from top

  for (const slice of slices) {
    const sweep = (slice.value / total) * 2 * Math.PI
    const endAngle = angle + sweep
    const x1 = cx + r * Math.cos(angle)
    const y1 = cy + r * Math.sin(angle)
    const x2 = cx + r * Math.cos(endAngle)
    const y2 = cy + r * Math.sin(endAngle)
    const ix1 = cx + innerR * Math.cos(endAngle)
    const iy1 = cy + innerR * Math.sin(endAngle)
    const ix2 = cx + innerR * Math.cos(angle)
    const iy2 = cy + innerR * Math.sin(angle)
    const largeArc = sweep > Math.PI ? 1 : 0

    const d = [
      `M ${x1.toFixed(2)} ${y1.toFixed(2)}`,
      `A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`,
      `L ${ix1.toFixed(2)} ${iy1.toFixed(2)}`,
      `A ${innerR} ${innerR} 0 ${largeArc} 0 ${ix2.toFixed(2)} ${iy2.toFixed(2)}`,
      'Z',
    ].join(' ')

    paths.push({ d, color: slice.color, label: slice.label, pct: slice.pct })
    angle = endAngle
  }

  return paths
}

interface Props {
  modelSplit: TkSummary['modelSplit']
  cacheSplit: TkSummary['cacheSplit']
}

export function ModelCacheDonut({ modelSplit, cacheSplit }: Props) {
  const { slices, paths, totalModelCost } = useMemo(() => {
    if (!modelSplit || modelSplit.length === 0) {
      return { slices: [] as DonutSlice[], paths: [], totalModelCost: 0 }
    }

    const sorted = [...modelSplit].sort((a, b) => b.costUsd - a.costUsd)
    const total = sorted.reduce((s, x) => s + x.costUsd, 0)

    // Collapse tail into "Other"
    const top = sorted.slice(0, MAX_SLICES)
    const restCost = sorted.slice(MAX_SLICES).reduce((s, x) => s + x.costUsd, 0)

    const raw: DonutSlice[] = top.map((m) => ({
      label: getModelShort(m.model),
      value: m.costUsd,
      color: getModelColor(m.model),
      pct: total > 0 ? (m.costUsd / total) * 100 : 0,
    }))

    if (restCost > 0) {
      raw.push({
        label: 'Other',
        value: restCost,
        color: 'var(--text-muted)',
        pct: total > 0 ? (restCost / total) * 100 : 0,
      })
    }

    const p = buildDonutPaths(raw, 52, 52, 42, 26)
    return { slices: raw, paths: p, totalModelCost: total }
  }, [modelSplit])

  // Cache breakdown row totals
  const cacheTotal = cacheSplit
    ? cacheSplit.inputUsd + cacheSplit.outputUsd + cacheSplit.cacheReadUsd + cacheSplit.cacheCreateUsd
    : 0

  const noData = slices.length === 0 && cacheTotal === 0

  if (noData) {
    return (
      <div
        className="rounded-xl p-4 flex items-center justify-center"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)', minHeight: 160 }}
      >
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No model data</div>
      </div>
    )
  }

  return (
    <div
      className="rounded-xl p-4"
      style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="text-[11px] text-overlay0 uppercase tracking-wider mb-3">
        Model / cache breakdown
      </div>

      <div className="flex gap-4">
        {/* Donut */}
        {slices.length > 0 && (
          <svg width={104} height={104} viewBox="0 0 104 104" className="shrink-0">
            {paths.map((p, i) => (
              <path key={i} d={p.d} fill={p.color} opacity={0.9}>
                <title>{`${p.label}: ${p.pct.toFixed(1)}%`}</title>
              </path>
            ))}
            {/* Centre label */}
            <text x="52" y="50" textAnchor="middle" fontSize="11" fill="var(--text-primary)" fontWeight="600">
              {formatCostShort(totalModelCost)}
            </text>
            <text x="52" y="61" textAnchor="middle" fontSize="7" fill="var(--text-muted)">
              total
            </text>
          </svg>
        )}

        {/* Legend */}
        <div className="flex flex-col justify-center gap-1 min-w-0 flex-1">
          {slices.map((s) => (
            <div key={s.label} className="flex items-center gap-1.5 min-w-0">
              <div
                className="rounded-sm shrink-0"
                style={{ width: 8, height: 8, backgroundColor: s.color }}
              />
              <span className="text-[11px] text-text truncate">{s.label}</span>
              <span className="text-[11px] text-overlay0 ml-auto shrink-0">{s.pct.toFixed(0)}%</span>
            </div>
          ))}
        </div>
      </div>

      {/* Cache split mini-table */}
      {cacheTotal > 0 && cacheSplit && (
        <div
          className="mt-3 pt-3 grid grid-cols-2 gap-x-3 gap-y-0.5"
          style={{ borderTop: '1px solid var(--border-subtle)' }}
        >
          <div className="text-[10px] text-overlay0 uppercase tracking-wider col-span-2 mb-0.5">Cache split</div>
          {([
            ['Input', cacheSplit.inputUsd],
            ['Output', cacheSplit.outputUsd],
            ['Cache read', cacheSplit.cacheReadUsd],
            ['Cache write', cacheSplit.cacheCreateUsd],
          ] as [string, number][]).map(([lbl, val]) => val > 0 && (
            <React.Fragment key={lbl}>
              <span className="text-[11px] text-overlay1">{lbl}</span>
              <span className="text-[11px] font-mono text-overlay1 text-right">{formatCostShort(val)}</span>
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  )
}
