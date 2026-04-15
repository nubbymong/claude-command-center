import React, { useEffect } from 'react'
import { useInsightsStore, setupInsightsListener } from '../stores/insightsStore'

interface Props {
  onViewInsights: () => void
}

export default function InsightsButton({ onViewInsights }: Props) {
  const status = useInsightsStore((s) => s.status)
  const statusMessage = useInsightsStore((s) => s.statusMessage)
  const error = useInsightsStore((s) => s.error)

  useEffect(() => {
    return setupInsightsListener()
  }, [])

  const isRunning = status === 'running' || status === 'extracting_kpis'
  const isFailed = status === 'failed'

  return (
    <button
      onClick={onViewInsights}
      className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors ${
        isRunning
          ? 'bg-surface0 border-surface1 text-overlay0'
          : isFailed
          ? 'bg-red/10 border-red/30 text-red hover:bg-red/20'
          : 'bg-surface0 border-surface1 text-subtext0 hover:bg-surface1 hover:text-text'
      }`}
    >
      {isRunning ? (
        <svg className="w-4 h-4 animate-spin shrink-0" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" strokeDasharray="32" strokeLinecap="round" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="shrink-0">
          <circle cx="8" cy="3" r="2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M4 8h8M6 6v4M10 6v4M3 12h10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      )}
      <div className="flex-1 text-left min-w-0">
        <span className="text-xs font-medium">Insights</span>
        {isRunning && statusMessage && (
          <div className="text-[10px] text-overlay0 truncate">{statusMessage}</div>
        )}
        {isFailed && error && (
          <div className="text-[10px] text-red/70 truncate" title={error}>{error}</div>
        )}
      </div>
    </button>
  )
}
