import React, { useEffect, useState } from 'react'
import { useInsightsStore } from '../stores/insightsStore'
import { useTokenomicsStore } from '../stores/tokenomicsStore'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { useSettingsStore } from '../stores/settingsStore'
import { resolveAccountNameByEmail, resolveAccountName } from '../../shared/account-chip-color'
import KpiSidebar from './KpiSidebar'
import type { InsightsData } from '../types/electron'
import type { TokenomicsSessionRecord } from '../../shared/types'
import PageFrame from './PageFrame'
import { parseInsightsReport, type ParsedInsights } from './insights/parseInsightsReport'
import { InsightsSections } from './insights/InsightsSections'

export default function InsightsPage() {
  // All hooks called unconditionally -- early returns appear after all hook calls.
  // Select the stable store slice, then default in render. Returning `?? {}`
  // directly from the selector yields a NEW object every call, which Zustand v5
  // (useSyncExternalStore + Object.is) treats as a perpetual change -> infinite
  // re-render loop ("Maximum update depth") when sessions is empty/unloaded.
  const tokenomicsData = useTokenomicsStore((s) => s.data)
  const tokenomicsSessions = tokenomicsData?.sessions ?? {}
  const catalogue = useInsightsStore((s) => s.catalogue)
  const selectedRunId = useInsightsStore((s) => s.selectedRunId)
  const selectRun = useInsightsStore((s) => s.selectRun)
  const status = useInsightsStore((s) => s.status)
  const statusMessage = useInsightsStore((s) => s.statusMessage)
  const startInsights = useInsightsStore((s) => s.startInsights)
  const loadCatalogue = useInsightsStore((s) => s.loadCatalogue)

  const [parsed, setParsed] = useState<ParsedInsights | null>(null)
  const [currentKpis, setCurrentKpis] = useState<InsightsData | null>(null)
  const [previousKpis, setPreviousKpis] = useState<InsightsData | null>(null)
  const [loading, setLoading] = useState(false)

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
      const runs = catalogue.runs.filter((r) => r.status === 'complete')
      const idx = runs.findIndex((r) => r.id === selectedRunId)
      if (idx > 0) {
        window.electronAPI.insights.getKpis(runs[idx - 1].id).then(setPreviousKpis)
      } else {
        setPreviousKpis(null)
      }
    }
  }, [selectedRunId, catalogue])

  const completedRuns = catalogue?.runs.filter((r) => r.status === 'complete') || []
  const isRunning = status === 'running' || status === 'extracting_kpis'

  // Codex-only empty state: user has Codex sessions but no Claude sessions.
  // Insights are Claude-only -- show an explanatory message rather than the
  // generic first-run UI, which would be confusing for Codex-only users.
  const sessionValues = Object.values(tokenomicsSessions) as TokenomicsSessionRecord[]
  const hasAnyClaude = sessionValues.some(
    (rec) => (rec?.provider ?? 'claude') === 'claude',
  )
  const hasAnyCodex = sessionValues.some(
    (rec) => rec?.provider === 'codex',
  )
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
            <h3 className="text-sm font-medium text-subtext1 mb-2">No Insights Yet</h3>
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
                <button
                  onClick={() => startInsights(effectiveRunProfileId || undefined)}
                  className="px-4 py-2 bg-teal/10 border border-teal/25 text-teal rounded-lg hover:bg-teal/20 transition-colors text-xs font-medium"
                >
                  Run Insights Now
                </button>
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
        {completedRuns.slice().reverse().map((run) => {
          const date = new Date(run.timestamp)
          const label = date.toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
          })
          const acct = multiAccount ? nameForAccount(run.accountEmail) : null
          return <option key={run.id} value={run.id}>{acct ? `${label} · ${acct}` : label}</option>
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
          ) : (
            <div className="flex items-center justify-center h-full">
              <p className="text-overlay0 text-xs">No report available for this run</p>
            </div>
          )}
        </div>

        {/* KPI Sidebar */}
        {currentKpis && (
          <KpiSidebar current={currentKpis} previous={previousKpis} />
        )}
      </div>
    </PageFrame>
  )
}
