import React, { useEffect, useState, useRef } from 'react'
import { useInsightsStore } from '../stores/insightsStore'
import KpiSidebar from './KpiSidebar'
import type { InsightsData } from '../types/electron'

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

  // Load catalogue on mount
  useEffect(() => {
    loadCatalogue()
  }, [])

  // Load report and KPIs when selected run changes
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
        // Inject dark theme CSS
        const injected = html.replace('</head>', DARK_THEME_CSS + '</head>')
        setReportHtml(injected)
      } else {
        setReportHtml(null)
      }
      setCurrentKpis(kpis)
      setLoading(false)
    })

    // Load previous run's KPIs for trend comparison
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

  // Empty state
  if (!catalogue || completedRuns.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center text-overlay1">
          <svg width="48" height="48" viewBox="0 0 16 16" fill="none" className="mx-auto mb-4 text-overlay0">
            <circle cx="8" cy="3" r="2" stroke="currentColor" strokeWidth="1.2" />
            <path d="M4 8h8M6 6v4M10 6v4M3 12h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
          <h2 className="text-lg font-semibold mb-2">No Insights Yet</h2>
          {status === 'running' || status === 'extracting_kpis' ? (
            <div className="flex flex-col items-center gap-3 text-blue">
              <svg className="w-6 h-6 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="32" strokeLinecap="round" />
              </svg>
              <span className="text-sm font-medium">
                {statusMessage || (status === 'extracting_kpis' ? 'Extracting KPIs...' : 'Generating insights...')}
              </span>
              <span className="text-xs text-overlay0">This may take a few minutes</span>
            </div>
          ) : (
            <>
              <p className="text-sm mb-4">Click the Insights button in the sidebar to generate your first report</p>
              <button
                onClick={startInsights}
                className="px-4 py-2 bg-blue/10 border border-blue/30 text-blue rounded-lg hover:bg-blue/20 transition-colors text-sm"
              >
                Run Insights Now
              </button>
            </>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Header with history dropdown */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-surface0 bg-mantle shrink-0">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-blue shrink-0">
          <circle cx="8" cy="3" r="2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M4 8h8M6 6v4M10 6v4M3 12h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        <span className="text-sm font-medium text-text">Insights Report</span>

        <select
          value={selectedRunId || ''}
          onChange={(e) => selectRun(e.target.value)}
          className="ml-auto bg-surface0 text-text text-xs rounded px-2 py-1 border border-surface1 focus:outline-none focus:border-blue"
        >
          {completedRuns.slice().reverse().map((run) => {
            const date = new Date(run.timestamp)
            const label = date.toLocaleDateString('en-US', {
              month: 'short', day: 'numeric', year: 'numeric',
              hour: '2-digit', minute: '2-digit'
            })
            return (
              <option key={run.id} value={run.id}>{label}</option>
            )
          })}
        </select>

        <button
          onClick={startInsights}
          disabled={status === 'running' || status === 'extracting_kpis'}
          className={`text-xs px-3 py-1 rounded border transition-colors ${
            status === 'running' || status === 'extracting_kpis'
              ? 'bg-surface0 border-surface1 text-blue cursor-wait flex items-center gap-1.5'
              : 'bg-blue/10 border-blue/30 text-blue hover:bg-blue/20'
          }`}
        >
          {status === 'running' || status === 'extracting_kpis' ? (
            <>
              <svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="32" strokeLinecap="round" />
              </svg>
              {statusMessage || 'Running...'}
            </>
          ) : 'New Run'}
        </button>
      </div>

      {/* Main content area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Report iframe */}
        <div className="flex-1 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <svg className="w-6 h-6 animate-spin text-blue" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="32" strokeLinecap="round" />
              </svg>
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
            <div className="flex items-center justify-center h-full text-overlay0 text-sm">
              No report available for this run
            </div>
          )}
        </div>

        {/* KPI Sidebar */}
        {currentKpis && (
          <KpiSidebar current={currentKpis} previous={previousKpis} />
        )}
      </div>
    </div>
  )
}
