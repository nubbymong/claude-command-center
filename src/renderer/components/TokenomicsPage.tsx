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
import { tkKpiSplit, tkRereadNotice, tkSeriesInRange, tkUnpricedNotice } from './tokenomics/tk-labels'

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

/** The first index's progress. It subscribes to the index status itself,
 *  so progress ticks re-render this, not the page (MP12 round 1). */
function IndexingProgress() {
  const status = useTokenomicsStore((s) => s.indexStatus)
  return <IndexingState status={status} />
}

/** The notices above the filters: files the index could not read, models
 *  with no price, and the one-off sorting by account (MP12). Subscribed on
 *  their own, for the same reason. */
function IndexNotices({ unpricedNotice }: { unpricedNotice: string | null }) {
  const filesFailed = useTokenomicsStore((s) => s.indexStatus?.filesFailed ?? 0)
  const rereadNotice = useTokenomicsStore((s) => tkRereadNotice(s.indexStatus?.accountReread))
  return (
    <>
      {/* Files the index could not read. These deliberately do not hold
          the dashboard back (gating on one unreadable transcript left the
          index unfinished for the life of the install, showing a spinner
          and nothing else), so the figures are shown and what is missing
          is said plainly. */}
      {filesFailed > 0 && (
        <div
          className="rounded-xl px-3 py-2 mb-4 text-[11px]"
          style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
          role="status"
        >
          {filesFailed === 1
            ? 'One transcript could not be read, so its usage is missing from these figures.'
            : `${filesFailed} transcripts could not be read, so their usage is missing from these figures.`}
        </div>
      )}
      {[unpricedNotice, rereadNotice].filter((n): n is string => !!n).map((notice) => (
        <div
          key={notice}
          className="rounded-xl px-3 py-2 mb-4 text-[11px]"
          style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
          role="status"
          data-testid="tk-notice"
        >
          {notice}
        </div>
      ))}
    </>
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
  // MP12 round 1: only the index status fields the page itself reads, so
  // its progress ticks do not re-render the whole dashboard.
  const firstIndexComplete = useTokenomicsStore((s) => s.indexStatus?.firstIndexComplete === true)
  const indexError = useTokenomicsStore((s) => s.indexStatus?.error ?? null)
  const rereading = useTokenomicsStore((s) => !!s.indexStatus?.accountReread)
  const summary = useTokenomicsStore((s) => s.summary)
  const loadingSummary = useTokenomicsStore((s) => s.loadingSummary)
  const error = useTokenomicsStore((s) => s.error)
  const accounts = useTokenomicsStore((s) => s.accounts)
  const filter = useTokenomicsStore((s) => s.filter)
  // Usage track MP12 (Q1.4): the split between providers, the notices in the
  // filesFailed slot, and what fills in while usage is sorted by account.
  const split = summary ? tkKpiSplit(summary, accounts, filter.provider ?? filter.account?.provider) : undefined
  const unpricedNotice = tkUnpricedNotice(summary?.unpriced)
  const splitFilling = rereading && !!(filter.provider || filter.account)

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
        {!firstIndexComplete ? (
          indexError ? (
            <div
              className="rounded-xl p-4 text-sm flex items-center justify-between gap-3"
              style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
              role="alert"
            >
              <span>Tokenomics indexing failed: {indexError}</span>
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
            <IndexingProgress />
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

            {/* Unreadable files, models with no price, sorting by account. */}
            <IndexNotices unpricedNotice={unpricedNotice} />

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
                <KpiRow kpis={summary.kpis} split={split} />

                {/* Charts row */}
                <div className="grid grid-cols-2 gap-3 mb-5">
                  <CostOverTimeChart data={summary.dailySeries} series={tkSeriesInRange(split?.providers, summary.dailySeries)} />
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
                <ActivityHeatmap data={summary.heatmap} filling={splitFilling} />
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
