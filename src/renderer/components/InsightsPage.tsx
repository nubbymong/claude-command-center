import React, { useEffect, useState, useRef } from 'react'
import { useInsightsStore } from '../stores/insightsStore'
import KpiSidebar from './KpiSidebar'
import type { InsightsData } from '../types/electron'
import PageFrame from './PageFrame'

// Comprehensive dark theme CSS for platform v9 aesthetic
const DARK_THEME_CSS = `
  <style>
    /* Base */
    html, body {
      background-color: #0f1218 !important;
      color: #b8c5d6 !important;
    }
    h1, h2 { color: #f0f4fc !important; }
    a { color: #89b4fa !important; }
    .subtitle { color: #8892a4 !important; }
    .section-intro { color: #8892a4 !important; }

    /* Navigation TOC */
    .nav-toc {
      background: #0b0e14 !important;
      border-color: #161c26 !important;
    }
    .nav-toc a {
      background: #161c26 !important;
      color: #8892a4 !important;
    }
    .nav-toc a:hover {
      background: #1e2530 !important;
      color: #f0f4fc !important;
    }

    /* Stats row */
    .stats-row {
      border-color: #161c26 !important;
    }
    .stat-value { color: #f0f4fc !important; }
    .stat-label { color: #64748b !important; }

    /* At a glance - warm amber tones */
    .at-a-glance {
      background: linear-gradient(135deg, #2a2008 0%, #221a06 100%) !important;
      border-color: #f9e2af !important;
    }
    .glance-title { color: #f9e2af !important; }
    .glance-section { color: #f0f4fc !important; }
    .glance-section strong { color: #f9e2af !important; }
    .see-more { color: #f9e2af !important; }

    /* Cards / white bg elements */
    .narrative, .project-area, .chart-card, .feedback-card {
      background: #0b0e14 !important;
      border-color: #161c26 !important;
    }
    .narrative p { color: #94a3b8 !important; }
    .area-name { color: #f0f4fc !important; }
    .area-count {
      color: #8892a4 !important;
      background: #161c26 !important;
    }
    .area-desc { color: #94a3b8 !important; }

    /* Key insight - green */
    .key-insight {
      background: rgba(166, 227, 161, 0.08) !important;
      border-color: rgba(166, 227, 161, 0.25) !important;
      color: #a6e3a1 !important;
    }

    /* Big wins - green tones */
    .big-win {
      background: rgba(166, 227, 161, 0.06) !important;
      border-color: rgba(166, 227, 161, 0.2) !important;
    }
    .big-win-title { color: #a6e3a1 !important; }
    .big-win-desc { color: #94e2d5 !important; }

    /* Friction - red tones */
    .friction-category {
      background: rgba(243, 139, 168, 0.06) !important;
      border-color: rgba(243, 139, 168, 0.2) !important;
    }
    .friction-title { color: #f38ba8 !important; }
    .friction-desc { color: #f2a8bd !important; }
    .friction-examples { color: #b8c5d6 !important; }
    .friction-examples li { color: #94a3b8 !important; }

    /* CLAUDE.md section - blue tones */
    .claude-md-section {
      background: rgba(137, 180, 250, 0.06) !important;
      border-color: rgba(137, 180, 250, 0.2) !important;
    }
    .claude-md-section h3 { color: #89b4fa !important; }
    .claude-md-actions { border-color: rgba(137, 180, 250, 0.15) !important; }
    .copy-all-btn {
      background: #89b4fa !important;
      color: #080a10 !important;
    }
    .copy-all-btn:hover { background: #74c7ec !important; }
    .copy-all-btn.copied { background: #a6e3a1 !important; }
    .claude-md-item { border-color: rgba(137, 180, 250, 0.12) !important; }
    .cmd-code {
      background: #161c26 !important;
      color: #89b4fa !important;
      border-color: #1e2530 !important;
    }
    .cmd-why { color: #8892a4 !important; }

    /* Feature cards - green tones */
    .feature-card {
      background: rgba(166, 227, 161, 0.06) !important;
      border-color: rgba(166, 227, 161, 0.2) !important;
    }
    .feature-title, .pattern-title { color: #f0f4fc !important; }
    .feature-oneliner, .pattern-summary { color: #94a3b8 !important; }
    .feature-why, .pattern-detail { color: #b8c5d6 !important; }
    .feature-example { border-color: rgba(166, 227, 161, 0.12) !important; }
    .example-desc { color: #b8c5d6 !important; }

    /* Pattern cards - blue tones */
    .pattern-card {
      background: rgba(137, 180, 250, 0.06) !important;
      border-color: rgba(137, 180, 250, 0.2) !important;
    }

    /* Code blocks */
    .example-code, .feature-code {
      background: #161c26 !important;
      border-color: #1e2530 !important;
      color: #f0f4fc !important;
    }
    .feature-code code { color: #f0f4fc !important; }
    pre, code {
      background: #161c26 !important;
      color: #f0f4fc !important;
    }
    .copyable-prompt {
      background: #161c26 !important;
      border-color: #1e2530 !important;
      color: #f0f4fc !important;
    }
    .pattern-prompt {
      background: #161c26 !important;
      border-color: #1e2530 !important;
    }
    .pattern-prompt code { color: #f0f4fc !important; }
    .prompt-label { color: #8892a4 !important; }

    /* Copy buttons */
    .copy-btn {
      background: #1e2530 !important;
      color: #b8c5d6 !important;
    }
    .copy-btn:hover { background: #2a3342 !important; }

    /* Charts */
    .chart-title { color: #8892a4 !important; }
    .bar-label { color: #94a3b8 !important; }
    .bar-track { background: #161c26 !important; }
    .bar-value { color: #8892a4 !important; }

    /* Horizon / suggestions - purple tones */
    .horizon-card {
      background: linear-gradient(135deg, rgba(203, 166, 247, 0.08) 0%, rgba(203, 166, 247, 0.04) 100%) !important;
      border-color: rgba(203, 166, 247, 0.25) !important;
    }
    .horizon-title { color: #cba6f7 !important; }
    .horizon-possible { color: #b8c5d6 !important; }
    .horizon-tip {
      color: #cba6f7 !important;
      background: rgba(203, 166, 247, 0.08) !important;
    }

    /* Feedback */
    .feedback-header { color: #8892a4 !important; }
    .feedback-intro { color: #64748b !important; }
    .feedback-section h3 { color: #94a3b8 !important; }

    /* Empty state */
    .empty { color: #64748b !important; }

    /* Generic borders */
    .charts-row * { border-color: #161c26 !important; }
  </style>
`

export default function InsightsPage() {
  const catalogue = useInsightsStore((s) => s.catalogue)
  const selectedRunId = useInsightsStore((s) => s.selectedRunId)
  const selectRun = useInsightsStore((s) => s.selectRun)
  const status = useInsightsStore((s) => s.status)
  const statusMessage = useInsightsStore((s) => s.statusMessage)
  const startInsights = useInsightsStore((s) => s.startInsights)
  const loadCatalogue = useInsightsStore((s) => s.loadCatalogue)

  const [reportHtml, setReportHtml] = useState<string | null>(null)
  const [currentKpis, setCurrentKpis] = useState<InsightsData | null>(null)
  const [previousKpis, setPreviousKpis] = useState<InsightsData | null>(null)
  const [loading, setLoading] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    loadCatalogue()
  }, [])

  useEffect(() => {
    if (!selectedRunId) {
      setReportHtml(null)
      setCurrentKpis(null)
      setPreviousKpis(null)
      return
    }

    setLoading(true)

    Promise.all([
      window.electronAPI.insights.getReport(selectedRunId),
      window.electronAPI.insights.getKpis(selectedRunId),
    ]).then(([html, kpis]) => {
      if (html) {
        const injected = html.replace('</head>', DARK_THEME_CSS + '</head>')
        setReportHtml(injected)
      } else {
        setReportHtml(null)
      }
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

  // Intercept link clicks inside the iframe and open in system browser
  useEffect(() => {
    const iframe = iframeRef.current
    if (!iframe || !reportHtml) return

    const onLoad = () => {
      const doc = iframe.contentDocument
      if (!doc) return
      doc.addEventListener('click', (e: MouseEvent) => {
        const anchor = (e.target as HTMLElement).closest('a')
        if (anchor && anchor.href && !anchor.href.startsWith('about:')) {
          e.preventDefault()
          window.electronAPI.shell.openExternal(anchor.href)
        }
      })
    }

    iframe.addEventListener('load', onLoad)
    return () => iframe.removeEventListener('load', onLoad)
  }, [reportHtml])

  const completedRuns = catalogue?.runs.filter((r) => r.status === 'complete') || []
  const isRunning = status === 'running' || status === 'extracting_kpis'

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
                <button
                  onClick={startInsights}
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
          return <option key={run.id} value={run.id}>{label}</option>
        })}
      </select>
      <button
        onClick={startInsights}
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
        {/* Report iframe */}
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
          ) : reportHtml ? (
            <iframe
              ref={iframeRef}
              srcDoc={reportHtml}
              className="w-full h-full border-0"
              sandbox="allow-same-origin"
              title="Insights Report"
            />
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
