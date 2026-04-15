import React, { useEffect, useState } from 'react'
import { useUsageStore } from '../stores/usageStore'

export default function UsageDashboard() {
  const { summary, loading, refresh } = useUsageStore()
  const [hours, setHours] = useState(5)

  useEffect(() => {
    refresh()
    const interval = setInterval(refresh, 30000)
    return () => clearInterval(interval)
  }, [hours])

  if (loading && !summary) {
    return (
      <div className="flex-1 flex items-center justify-center text-overlay0">
        Loading usage data...
      </div>
    )
  }

  if (!summary) {
    return (
      <div className="flex-1 flex items-center justify-center text-overlay0">
        No usage data available
      </div>
    )
  }

  const maxHourCost = Math.max(...summary.byHour.map(h => h.cost), 0.001)

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-4xl mx-auto space-y-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-text">Usage Dashboard</h2>
          <div className="flex items-center gap-2">
            <span className="text-xs text-overlay0">Window:</span>
            {[1, 5, 12, 24].map(h => (
              <button
                key={h}
                onClick={() => setHours(h)}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  hours === h ? 'bg-blue text-crust' : 'bg-surface0 text-overlay1 hover:text-text'
                }`}
              >
                {h}h
              </button>
            ))}
          </div>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-surface0 rounded-lg p-4">
            <div className="text-xs text-overlay0 mb-1">Total Cost</div>
            <div className="text-2xl font-semibold text-text">${summary.totalCost.toFixed(4)}</div>
          </div>
          <div className="bg-surface0 rounded-lg p-4">
            <div className="text-xs text-overlay0 mb-1">Input Tokens</div>
            <div className="text-2xl font-semibold text-text">{summary.totalInputTokens.toLocaleString()}</div>
          </div>
          <div className="bg-surface0 rounded-lg p-4">
            <div className="text-xs text-overlay0 mb-1">Output Tokens</div>
            <div className="text-2xl font-semibold text-text">{summary.totalOutputTokens.toLocaleString()}</div>
          </div>
        </div>

        {/* Cost by hour chart */}
        <div className="bg-surface0 rounded-lg p-4">
          <h3 className="text-sm font-medium text-subtext1 mb-3">Cost by Hour</h3>
          {summary.byHour.length === 0 ? (
            <div className="text-xs text-overlay0 text-center py-8">No data in this time window</div>
          ) : (
            <div className="flex items-end gap-1 h-32">
              {summary.byHour.map((h, i) => (
                <div key={i} className="flex-1 flex flex-col items-center">
                  <div
                    className="w-full bg-blue/60 rounded-t transition-all hover:bg-blue"
                    style={{ height: `${(h.cost / maxHourCost) * 100}%`, minHeight: h.cost > 0 ? '2px' : '0' }}
                    title={`${h.hour}: $${h.cost.toFixed(4)}`}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Cost by model */}
        <div className="bg-surface0 rounded-lg p-4">
          <h3 className="text-sm font-medium text-subtext1 mb-3">By Model</h3>
          <div className="space-y-2">
            {Object.entries(summary.byModel).map(([model, data]) => (
              <div key={model} className="flex items-center justify-between text-sm">
                <span className="text-text font-mono text-xs">{model}</span>
                <div className="flex gap-4 text-xs text-overlay1">
                  <span>${data.cost.toFixed(4)}</span>
                  <span>{data.inputTokens.toLocaleString()} in</span>
                  <span>{data.outputTokens.toLocaleString()} out</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
