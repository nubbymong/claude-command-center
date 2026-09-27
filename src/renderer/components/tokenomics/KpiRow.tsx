import React from 'react'
import type { TkSummary, TkKpis, TkProvider } from '../../../shared/types'
import { TK_PROVIDER_LABEL, TK_PROVIDER_COLOR, TK_CODEX_COST_NOTE } from './tk-labels'

function formatCostKpi(usd: number): string {
  if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}k`
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 10) return `$${usd.toFixed(1)}`
  return `$${usd.toFixed(2)}`
}

/** Usage track MP12 (Q1.4): each KPI split between the providers, shown
 *  when both have usage in these figures. `noPrice`: providers whose usage
 *  here has no price at all (their segment reads "no price", never $0). */
export interface TkKpiSplit {
  byProvider: TkSummary['kpisByProvider']
  providers: TkProvider[]
  noPrice: TkProvider[]
}

/** A KPI's two-segment bar (each provider's share of `weight`) and its
 *  legend (`show` for each provider's figure). The Codex item carries the
 *  cost wording per sign-in (Q1.5) when `costNote` is set. */
function Split({ split, weight, show, costNote }: {
  split: TkKpiSplit
  weight: (k: TkKpis) => number
  show: (p: TkProvider) => React.ReactNode
  costNote?: boolean
}) {
  const parts = split.providers.map((p) => ({ p, value: weight(split.byProvider[p]) || 0 }))
  const total = parts.reduce((s, x) => s + x.value, 0)
  return (
    <div className="mt-2" data-testid="tk-kpi-split">
      <div className="flex h-1 rounded overflow-hidden" style={{ background: 'var(--surface-stage)' }} data-testid="tk-kpi-split-bar">
        {total > 0 && parts.map((x) => x.value > 0 && (
          <div key={x.p} style={{ width: `${(x.value / total) * 100}%`, background: TK_PROVIDER_COLOR[x.p] }} />
        ))}
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
        {parts.map((x) => (
          <span
            key={x.p}
            className="inline-flex items-center gap-1"
            title={costNote && x.p === 'codex' ? TK_CODEX_COST_NOTE : undefined}
            data-testid={`tk-kpi-legend-${x.p}`}
          >
            <span className="rounded-sm shrink-0" style={{ width: 8, height: 8, background: TK_PROVIDER_COLOR[x.p] }} />
            {TK_PROVIDER_LABEL[x.p]} {show(x.p)}
          </span>
        ))}
      </div>
    </div>
  )
}

/** A cost figure in the legend: "no price", muted and italic, for a
 *  provider whose usage here has no price at all. */
function CostFigure({ split, p, value }: { split: TkKpiSplit; p: TkProvider; value: number }) {
  return split.noPrice.includes(p)
    ? <span className="italic" style={{ color: 'var(--text-muted)' }}>no price</span>
    : <span className="font-mono">{formatCostKpi(value)}</span>
}

interface Props {
  kpis: TkSummary['kpis']
  /** MP12: the split between providers, when both have usage here. */
  split?: TkKpiSplit
}

export function KpiRow({ kpis, split }: Props) {
  const showSplit = !!split && split.providers.length > 1
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
        {showSplit && <Split split={split!} weight={(k) => k.lifeToDateCostUsd} costNote show={(p) => <CostFigure split={split!} p={p} value={split!.byProvider[p].lifeToDateCostUsd} />} />}
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
        {showSplit && <Split split={split!} weight={(k) => k.last7dCostUsd} costNote show={(p) => <CostFigure split={split!} p={p} value={split!.byProvider[p].last7dCostUsd} />} />}
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
        {showSplit && (
          // Each provider's share of the cache savings, and its own rate.
          <Split split={split!} weight={(k) => k.cacheSavingsUsd} show={(p) => <span className="font-mono">{split!.byProvider[p].cacheEfficiencyPct.toFixed(0)}%</span>} />
        )}
      </div>
    </div>
  )
}
