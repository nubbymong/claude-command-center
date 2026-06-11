import React from 'react'
import type { TkSummary } from '../../../shared/types'

function formatCostKpi(usd: number): string {
  if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}k`
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 10) return `$${usd.toFixed(1)}`
  return `$${usd.toFixed(2)}`
}

interface Props {
  kpis: TkSummary['kpis']
}

export function KpiRow({ kpis }: Props) {
  const { lifeToDateCostUsd, last7dCostUsd, prev7dCostUsd, cacheEfficiencyPct, cacheSavingsUsd } = kpis

  // Week-over-week delta
  let wowDelta: number | null = null
  if (prev7dCostUsd > 0) {
    wowDelta = ((last7dCostUsd - prev7dCostUsd) / prev7dCostUsd) * 100
  }

  return (
    <div className="grid grid-cols-3 gap-3 mb-5">
      {/* Life-to-date */}
      <div
        className="rounded-xl p-4"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
      >
        <div className="text-[11px] text-overlay0 uppercase tracking-wider mb-1.5">
          Life-to-date
        </div>
        <div
          className="text-2xl font-mono font-bold"
          style={{ color: 'var(--accent)' }}
        >
          {formatCostKpi(lifeToDateCostUsd)}
        </div>
        <div className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
          API-equivalent estimate
        </div>
      </div>

      {/* Last 7 days */}
      <div
        className="rounded-xl p-4"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
      >
        <div className="text-[11px] text-overlay0 uppercase tracking-wider mb-1.5">
          Last 7 days
        </div>
        <div className="flex items-baseline gap-2">
          <div className="text-2xl font-mono font-bold text-blue">
            {formatCostKpi(last7dCostUsd)}
          </div>
          {wowDelta !== null ? (
            <span
              className="text-xs font-medium px-1.5 py-0.5 rounded"
              style={{
                background: wowDelta > 0
                  ? 'color-mix(in srgb, var(--status-warning) 15%, transparent)'
                  : 'color-mix(in srgb, var(--status-success) 15%, transparent)',
                color: wowDelta > 0 ? 'var(--status-warning)' : 'var(--status-success)',
              }}
            >
              {wowDelta > 0 ? '▲' : '▼'} {Math.abs(wowDelta).toFixed(0)}%
            </span>
          ) : (
            <span className="text-xs text-overlay0">—</span>
          )}
        </div>
        <div className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
          vs prior 7 days
        </div>
      </div>

      {/* Cache efficiency */}
      <div
        className="rounded-xl p-4"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
      >
        <div className="text-[11px] text-overlay0 uppercase tracking-wider mb-1.5">
          Cache efficiency
        </div>
        <div className="text-2xl font-mono font-bold text-green">
          {cacheEfficiencyPct.toFixed(0)}%
        </div>
        <div className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>
          {formatCostKpi(cacheSavingsUsd)} saved
        </div>
      </div>
    </div>
  )
}
