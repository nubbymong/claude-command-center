import React, { useEffect, useState } from 'react'
import { useInsightsStore } from '../stores/insightsStore'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { useSettingsStore } from '../stores/settingsStore'
import { resolveAccountNameByEmail, resolveAccountName } from '../../shared/account-chip-color'
import KpiSidebar from './KpiSidebar'
import type { CrossAccountInsights, InsightsData } from '../types/electron'
import PageFrame from './PageFrame'
import { parseInsightsReport, type ParsedInsights } from './insights/parseInsightsReport'
import { InsightsSections } from './insights/InsightsSections'
import CrossAccountReport from './insights/CrossAccountReport'

export default function InsightsPage() {
  // All hooks called unconditionally -- early returns appear after all hook calls.
  const catalogue = useInsightsStore((s) => s.catalogue)
  const selectedRunId = useInsightsStore((s) => s.selectedRunId)
  const selectRun = useInsightsStore((s) => s.selectRun)
  const status = useInsightsStore((s) => s.status)
  const statusMessage = useInsightsStore((s) => s.statusMessage)
  const startInsights = useInsightsStore((s) => s.startInsights)
  const startCrossAccount = useInsightsStore((s) => s.startCrossAccount)
  const batchActive = useInsightsStore((s) => s.batchActive)
  const loadCatalogue = useInsightsStore((s) => s.loadCatalogue)

  const [parsed, setParsed] = useState<ParsedInsights | null>(null)
  const [currentKpis, setCurrentKpis] = useState<InsightsData | null>(null)
  const [previousKpis, setPreviousKpis] = useState<InsightsData | null>(null)
  const [loading, setLoading] = useState(false)

  // Provider presence: fetched once on mount from the new worker-backed tokenomics
  // summary. Used to detect Codex-only users and show a tailored empty state.
  const [providerPresence, setProviderPresence] = useState<{ claude: boolean; codex: boolean }>({ claude: false, codex: false })
  useEffect(() => {
    let alive = true
    window.electronAPI.tokenomics.summary({}).then((s) => {
      if (!alive || !s) return
      const claude = s.modelSplit.some((m) => m.model.startsWith('claude'))
      const codex = s.modelSplit.some((m) => m.model.startsWith('gpt'))
      setProviderPresence({ claude, codex })
    }).catch(() => {})
    return () => { alive = false }
  }, [])

  // Account selection: which account a new run executes under. Defaults to the
  // captured primary; only surfaced when more than one account profile exists.
  const profiles = useAccountProfilesStore((s) => s.profiles)
  const accountAliases = useSettingsStore((s) => s.settings.accountAliases)
  const multiAccount = profiles.length >= 2
  const defaultProfileId = (profiles.find((p) => p.isPrimary) ?? profiles[0])?.id ?? ''
  const [runProfileId, setRunProfileId] = useState<string>('')
  const effectiveRunProfileId = runProfileId || defaultProfileId
  const nameForAccount = (email?: string) => (email ? resolveAccountNameByEmail(email, profiles, accountAliases) : null)
  const labelForProfile = (p: { accountEmail: string; name?: string; isPrimary?: boolean }) =>
    (resolveAccountName(p.accountEmail, p.name, accountAliases) || 'Account') + (p.isPrimary ? ' (primary)' : '')

  useEffect(() => {
    loadCatalogue()
  }, [])

  useEffect(() => {
    if (!selectedRunId) {
      setParsed(null)
      setCurrentKpis(null)
      setPreviousKpis(null)
      return
    }

    setLoading(true)

    Promise.all([
      window.electronAPI.insights.getReport(selectedRunId),
      window.electronAPI.insights.getKpis(selectedRunId),
    ]).then(([html, kpis]) => {
      setParsed(html ? parseInsightsReport(html) : null)
      setCurrentKpis(kpis)
      setLoading(false)
    })

    if (catalogue) {
      // Compare against the previous complete run of the SAME account (W5) —
      // otherwise multi-account diffs one account's run against another's.
      // Aggregates are excluded on both sides: they carry no profileId, so they
      // would otherwise pair up with every default-account run, and a
      // cross-account roll-up is rendered without the trend sidebar anyway.
      const sel = catalogue.runs.find((r) => r.id === selectedRunId)
      if (sel?.kind === 'aggregate') {
        setPreviousKpis(null)
        return
      }
      const runs = catalogue.runs.filter(
        (r) =>
          r.status === 'complete' &&
          r.kind !== 'aggregate' &&
          (r.profileId ?? null) === (sel?.profileId ?? null)
      )
      const idx = runs.findIndex((r) => r.id === selectedRunId)
      if (idx > 0) {
        window.electronAPI.insights.getKpis(runs[idx - 1].id).then(setPreviousKpis)
      } else {
        setPreviousKpis(null)
      }
    }
  }, [selectedRunId, catalogue])

  const completedRuns = catalogue?.runs.filter((r) => r.status === 'complete') || []
  const failedRuns = catalogue?.runs.filter((r) => r.status === 'failed') || []
  const latestRun = catalogue?.runs[catalogue.runs.length - 1] || null
  const selectedRun = catalogue?.runs.find((r) => r.id === selectedRunId) || null
  // Picker lists viewable (complete) + failed runs, newest first, so failures
  // are discoverable instead of being silently filtered out.
  const pickerRuns = [...completedRuns, ...failedRuns].sort((a, b) => b.timestamp - a.timestamp)
  const isRunning = status === 'running' || status === 'extracting_kpis'

  // A cross-account roll-up renders from its own JSON (it has no report.html).
  // The shape is validated before use so a truncated or hand-edited kpis.json
  // shows the "no report" state instead of throwing inside the view.
  const selectedIsAggregate = selectedRun?.kind === 'aggregate'
  const crossAccount: CrossAccountInsights | null =
    selectedIsAggregate &&
    currentKpis &&
    Array.isArray((currentKpis as CrossAccountInsights).accounts) &&
    Array.isArray((currentKpis as CrossAccountInsights).comparison)
      ? (currentKpis as CrossAccountInsights)
      : null
  const runAllLabel = `Run all (${profiles.length})`

  // Codex-only empty state: user has Codex sessions but no Claude sessions.
  // Insights are Claude-only -- show an explanatory message rather than the
  // generic first-run UI, which would be confusing for Codex-only users.
  // Sourced from the new worker-backed tokenomics summary (modelSplit).
  const hasAnyClaude = providerPresence.claude
  const hasAnyCodex = providerPresence.codex
  if (!hasAnyClaude && hasAnyCodex) {
    return (
      <PageFrame title="Insights">
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <p className="text-base text-text mb-2">
            Insights aggregate from your Claude sessions.
          </p>
          <p className="text-sm text-overlay1">
            Start a Claude session to see your patterns.
          </p>
        </div>
      </PageFrame>
    )
  }

  // Empty state
  if (!catalogue || completedRuns.length === 0) {
    return (
      <div className="flex-1 flex flex-col bg-base overflow-hidden">
        {/* Header even in empty state */}
        <div className="px-5 pt-4 pb-3 border-b border-surface0/80 bg-mantle/30 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-teal/10 flex items-center justify-center shrink-0">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-teal">
                <circle cx="8" cy="3" r="2" stroke="currentColor" strokeWidth="1.2" />
                <path d="M4 8h8M6 6v4M10 6v4M3 12h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </div>
            <div>
              <h1 className="text-base font-semibold text-text">Insights</h1>
              <p className="text-[11px] text-overlay0 mt-0.5">AI-generated analysis of your workflow</p>
            </div>
          </div>
        </div>

        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-surface0/30 flex items-center justify-center">
              <svg width="24" height="24" viewBox="0 0 16 16" fill="none" className="text-overlay0">
                <circle cx="8" cy="3" r="2" stroke="currentColor" strokeWidth="1.2" />
                <path d="M4 8h8M6 6v4M10 6v4M3 12h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </div>
            <h3 className="text-sm font-medium text-subtext1 mb-2">{latestRun?.status === 'failed' ? 'Last run failed' : 'No Insights Yet'}</h3>
            {isRunning ? (
              <div className="flex flex-col items-center gap-3">
                <svg className="w-5 h-5 animate-spin text-teal" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="32" strokeLinecap="round" />
                </svg>
                <span className="text-xs text-teal font-medium">
                  {statusMessage || (status === 'extracting_kpis' ? 'Extracting KPIs...' : 'Generating insights...')}
                </span>
                <span className="text-[11px] text-overlay0">This may take a few minutes</span>
              </div>
            ) : (
              <>
                {latestRun?.status === 'failed' && (
                  <p className="text-xs text-red mb-3 max-w-[260px]" title={latestRun.error || undefined}>
                    {latestRun.error || 'unknown error'}
                  </p>
                )}
                <p className="text-xs text-overlay0 mb-4 max-w-[240px]">Generate an AI-powered analysis of your session history and workflow patterns</p>
                {multiAccount && (
                  <select
                    value={effectiveRunProfileId}
                    onChange={(e) => setRunProfileId(e.target.value)}
                    className="block mx-auto mb-3 bg-surface0 text-text text-xs rounded border border-surface1 px-2 py-1 focus:outline-none focus:border-teal/40"
                    title="Account to analyze"
                  >
                    {profiles.map((p) => (
                      <option key={p.id} value={p.id}>{labelForProfile(p)}</option>
                    ))}
                  </select>
                )}
                <div className="flex items-center justify-center gap-2">
                  <button
                    onClick={() => startInsights(effectiveRunProfileId || undefined)}
                    className="px-4 py-2 bg-teal/10 border border-teal/25 text-teal rounded-lg hover:bg-teal/20 transition-colors text-xs font-medium"
                  >
                    Run Insights Now
                  </button>
                  {multiAccount && (
                    <button
                      onClick={() => startCrossAccount()}
                      className="px-4 py-2 bg-surface0 border border-surface1 text-subtext1 rounded-lg hover:border-teal/40 hover:text-teal transition-colors text-xs font-medium"
                      title="Generate a report for every account, then one combined cross-account report"
                    >
                      {runAllLabel}
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    )
  }

  const insightsIcon = (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round">
      <circle cx="8" cy="3" r="2" stroke="currentColor" />
      <path d="M4 8h8M6 6v4M10 6v4M3 12h10" />
    </svg>
  )

  const insightsActions = (
    <>
      <select
        value={selectedRunId || ''}
        onChange={(e) => selectRun(e.target.value)}
        className="bg-surface0 text-text text-xs rounded border border-surface1 px-2 py-0.5 focus:outline-none focus:border-blue/40 transition-colors"
      >
        {pickerRuns.map((run) => {
          const date = new Date(run.timestamp)
          const label = date.toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
          })
          // An aggregate belongs to every account, so it is labelled by how many
          // it actually compared rather than by one account name.
          const acct =
            run.kind === 'aggregate'
              ? `All accounts (${run.memberRunIds?.length ?? run.members?.length ?? 0})`
              : multiAccount
                ? nameForAccount(run.accountEmail)
                : null
          const base = acct ? `${label} · ${acct}` : label
          const suffix = run.status === 'failed' ? ' · failed' : run.kpisUnavailable ? ' · no KPIs' : ''
          return <option key={run.id} value={run.id}>{base}{suffix}</option>
        })}
      </select>
      {multiAccount && (
        <select
          value={effectiveRunProfileId}
          onChange={(e) => setRunProfileId(e.target.value)}
          className="bg-surface0 text-text text-xs rounded border border-surface1 px-2 py-0.5 focus:outline-none focus:border-teal/40 transition-colors"
          title="Account for the next run"
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{labelForProfile(p)}</option>
          ))}
        </select>
      )}
      <button
        onClick={() => startInsights(effectiveRunProfileId || undefined)}
        disabled={isRunning}
        className={`text-xs px-2.5 py-0.5 rounded border font-medium transition-all flex items-center gap-1.5 ${
          isRunning
            ? 'bg-surface0 border-surface1 text-teal cursor-wait'
            : 'bg-teal/10 border-teal/30 text-teal hover:bg-teal/20'
        }`}
      >
        {isRunning ? (
          <>
            <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="32" strokeLinecap="round" />
            </svg>
            {statusMessage || 'Running…'}
          </>
        ) : 'New run'}
      </button>
      {multiAccount && (
        <button
          onClick={() => startCrossAccount()}
          disabled={isRunning || batchActive}
          className={`text-xs px-2.5 py-0.5 rounded border font-medium transition-all ${
            isRunning || batchActive
              ? 'bg-surface0 border-surface1 text-overlay0 cursor-not-allowed'
              : 'bg-surface0 border-surface1 text-subtext1 hover:border-teal/40 hover:text-teal'
          }`}
          title="Generate a report for every account, then one combined cross-account report"
        >
          {runAllLabel}
        </button>
      )}
    </>
  )

  const insightsContext = (
    <>{completedRuns.length} report{completedRuns.length !== 1 ? 's' : ''} generated</>
  )

  return (
    <PageFrame
      icon={insightsIcon}
      iconAccent="teal"
      title="Insights"
      context={insightsContext}
      actions={insightsActions}
      scrollable={false}
    >
      {latestRun?.status === 'failed' && (
        <div
          className="px-4 py-1.5 text-[11px] text-red bg-red/10 border-b border-red/20 shrink-0 truncate"
          title={latestRun.error || undefined}
        >
          Last Insights run failed: {latestRun.error || 'unknown error'}
        </div>
      )}
      <div className="flex-1 flex overflow-hidden">
        {/* Report native sections */}
        <div className="flex-1 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <div className="flex items-center gap-2.5 text-overlay1">
                <svg className="w-4 h-4 animate-spin text-teal" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="32" strokeLinecap="round" />
                </svg>
                <span className="text-xs">Loading report...</span>
              </div>
            </div>
          ) : crossAccount && selectedRun ? (
            <CrossAccountReport data={crossAccount} run={selectedRun} nameForAccount={nameForAccount} />
          ) : parsed ? (
            <div className="w-full h-full overflow-auto">
              {parsed.title && (
                <div style={{ padding: '16px 16px 0' }}>
                  <h2 style={{ fontSize: 18, fontWeight: 600, color: 'var(--text-primary)' }}>{parsed.title}</h2>
                  {parsed.subtitle && <p style={{ color: 'var(--text-muted)' }}>{parsed.subtitle}</p>}
                </div>
              )}
              <InsightsSections sections={parsed.sections} />
            </div>
          ) : selectedRun?.status === 'failed' ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center max-w-[340px] px-4">
                <p className="text-sm text-red mb-1">This run failed</p>
                <p className="text-xs text-overlay0 break-words">{selectedRun.error || 'Unknown error'}</p>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-overlay0 text-xs">No report available for this run</p>
            </div>
          )}
        </div>

        {/* KPI Sidebar — or a note when KPIs failed for this completed run.
            An aggregate is full-width: its comparison table already holds every
            metric, and the trend sidebar has no same-account previous run to
            diff against. */}
        {selectedIsAggregate ? null : currentKpis ? (
          <KpiSidebar current={currentKpis} previous={previousKpis} />
        ) : selectedRun?.kpisUnavailable ? (
          <div className="w-72 shrink-0 border-l border-surface0/80 p-4 text-xs text-overlay0">
            <p>Report ready — KPI extraction failed for this run.</p>
            {/* The reason, when the runner captured one. An expired OAuth session
                is a one-click fix the user can only act on if told about it. */}
            {selectedRun?.error && (
              <p className="mt-2 text-red break-words" title={selectedRun.error}>
                {selectedRun.error}
              </p>
            )}
          </div>
        ) : null}
      </div>
    </PageFrame>
  )
}
