import React, { useEffect } from 'react'
import { useTokenomicsStore } from '../stores/tokenomicsStore'
import PageFrame from './PageFrame'
import CompatBadge from './sentinel/CompatBadge'
import { IndexingState } from './tokenomics/IndexingState'
import { FilterBar as NewFilterBar } from './tokenomics/FilterBar'
import { KpiRow } from './tokenomics/KpiRow'
import { CostOverTimeChart } from './tokenomics/CostOverTimeChart'
import { ModelCacheDonut } from './tokenomics/ModelCacheDonut'
import { CostByConfig } from './tokenomics/CostByConfig'
import { SessionsTable as NewSessionsTable } from './tokenomics/SessionsTable'
import { SessionDetailDrawer } from './tokenomics/SessionDetailDrawer'
import { ActivityHeatmap } from './tokenomics/ActivityHeatmap'

// ── Shimmer / loading state ──

function SummaryShimmer() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3 mb-5">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="rounded-xl p-4 animate-pulse"
            style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)', minHeight: 80 }}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div
          className="rounded-xl animate-pulse"
          style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)', minHeight: 160 }}
        />
        <div
          className="rounded-xl animate-pulse"
          style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)', minHeight: 160 }}
        />
      </div>
    </div>
  )
}

// ── Main Page (new design — Task 17+18) ──

const dollarIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <line x1="12" y1="1" x2="12" y2="23" />
    <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
  </svg>
)

export default function TokenomicsPage() {
  const indexStatus = useTokenomicsStore((s) => s.indexStatus)
  const summary = useTokenomicsStore((s) => s.summary)
  const loadingSummary = useTokenomicsStore((s) => s.loadingSummary)
  const error = useTokenomicsStore((s) => s.error)

  useEffect(() => {
    const s = useTokenomicsStore.getState()
    s.init()
    return () => s.dispose()
  }, [])

  const contextText = summary
    ? `$${summary.kpis.lifeToDateCostUsd.toFixed(2)} life-to-date`
    : undefined

  return (
    <PageFrame
      icon={dollarIcon}
      iconAccent="teal"
      title="Tokenomics"
      context={contextText}
      actions={<CompatBadge feature="tokenomics" />}
    >
      <div className="p-5">
        {/* Indexing / first-load gate */}
        {(indexStatus === null || !indexStatus.firstIndexComplete) ? (
          <IndexingState status={indexStatus} />
        ) : (
          <>
            {/* Page heading */}
            <div className="flex items-baseline gap-2 mb-4">
              <h2 className="text-sm font-semibold text-text">Usage dashboard</h2>
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                API-equivalent estimate
              </span>
            </div>

            {/* Filter bar */}
            <NewFilterBar />

            {/* KPI row + charts — shimmer while loading, error banner on fault */}
            {error && !summary ? (
              <div
                className="rounded-xl p-4 text-sm flex items-center justify-between gap-3"
                style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
                role="alert"
              >
                <span>Couldn’t load tokenomics data: {error}</span>
                <button
                  type="button"
                  className="px-2 py-1 rounded-md text-xs"
                  style={{ background: 'var(--surface-panel)', border: '1px solid var(--border-subtle)', color: 'var(--text)' }}
                  onClick={() => useTokenomicsStore.getState().refresh()}
                >
                  Retry
                </button>
              </div>
            ) : loadingSummary && !summary ? (
              <SummaryShimmer />
            ) : summary ? (
              <>
                {/* KPI row */}
                <KpiRow kpis={summary.kpis} />

                {/* Charts row */}
                <div className="grid grid-cols-2 gap-3 mb-5">
                  <CostOverTimeChart data={summary.dailySeries} />
                  <ModelCacheDonut
                    modelSplit={summary.modelSplit}
                    cacheSplit={summary.cacheSplit}
                  />
                </div>
              </>
            ) : null}

            {/* Cost-by-config + sessions table + activity heatmap */}
            {summary && (
              <>
                <CostByConfig data={summary.costByConfig} />
                <NewSessionsTable />
                <ActivityHeatmap data={summary.heatmap} />
              </>
            )}
            <SessionDetailDrawer />
          </>
        )}
      </div>
    </PageFrame>
  )
}
