import React, { useEffect } from 'react'
import { useTokenomicsStore } from '../stores/tokenomicsStore'
import { useGitHubStore } from '../stores/githubStore'
import { useSettingsStore } from '../stores/settingsStore'
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
import { GitHubCopilotCard } from './tokenomics/GitHubCopilotCard'

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

  // GitHub Copilot billing card (ACTUAL billing credits, distinct from the
  // estimates above). Shown only when the meter is on and there is something to
  // render: a fetched report, or a scope-missing state worth guiding out of.
  const githubAiUsageEnabled = useSettingsStore((s) => s.settings.githubAiUsageEnabled)
  const aiUsage = useGitHubStore((s) => s.aiUsage)
  const aiUsageStatus = useGitHubStore((s) => s.aiUsageStatus)
  const showCopilotCard =
    githubAiUsageEnabled === true && (aiUsage != null || aiUsageStatus === 'scope-missing')

  useEffect(() => {
    const s = useTokenomicsStore.getState()
    s.init()
    return () => s.dispose()
  }, [])

  // Pull the latest Copilot usage when the meter is enabled so the card
  // populates on page open without waiting for the 60-minute poll.
  useEffect(() => {
    if (githubAiUsageEnabled === true) {
      void useGitHubStore.getState().loadAiUsage().catch(() => {})
    }
  }, [githubAiUsageEnabled])

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
        {/* Indexing / first-load gate. A fatal worker error (failed DB open)
            must surface here too — otherwise the gate spins on 'indexing'
            forever with zero diagnostics. */}
        {(indexStatus === null || !indexStatus.firstIndexComplete) ? (
          indexStatus?.error ? (
            <div
              className="rounded-xl p-4 text-sm flex items-center justify-between gap-3"
              style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
              role="alert"
            >
              <span>Tokenomics indexing failed: {indexStatus.error}</span>
              <button
                type="button"
                className="px-2 py-1 rounded-md text-xs"
                style={{ background: 'var(--surface-panel)', border: '1px solid var(--border-subtle)', color: 'var(--text)' }}
                onClick={() => useTokenomicsStore.getState().refreshIndexStatus()}
              >
                Retry
              </button>
            </div>
          ) : (
            <IndexingState status={indexStatus} />
          )
        ) : (
          <>
            {/* Page heading */}
            <div className="flex items-baseline gap-2 mb-4">
              <h2 className="text-sm font-semibold text-text">Usage dashboard</h2>
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                API-equivalent estimate
              </span>
            </div>

            {/* Files the index could not read. These deliberately do not hold
                the dashboard back — gating on one unreadable transcript left the
                index unfinished for the life of the install, showing a spinner
                and nothing else — so the figures are shown and what is missing
                is said plainly. */}
            {(indexStatus.filesFailed ?? 0) > 0 && (
              <div
                className="rounded-xl px-3 py-2 mb-4 text-[11px]"
                style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
                role="status"
              >
                {indexStatus.filesFailed === 1
                  ? 'One transcript could not be read, so its usage is missing from these figures.'
                  : `${indexStatus.filesFailed} transcripts could not be read, so their usage is missing from these figures.`}
              </div>
            )}

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

            {/* GitHub Copilot billing — ACTUAL credits, after the estimate
                dashboard and visually set apart from it. */}
            {showCopilotCard && (
              <div className="mt-6">
                <GitHubCopilotCard />
              </div>
            )}

            <SessionDetailDrawer />
          </>
        )}
      </div>
    </PageFrame>
  )
}
