import React, { useEffect, useState, useMemo } from 'react'
import { useTokenomicsStore } from '../stores/tokenomicsStore'
import type { TokenomicsSessionRecord } from '../../shared/types'

const MODEL_COLORS: Record<string, string> = {
  'claude-sonnet-4-6': '#89B4FA',
  'claude-opus-4-6': '#CBA6F7',
  'claude-haiku-4-5': '#A6E3A1',
}

function getModelColor(model: string): string {
  if (MODEL_COLORS[model]) return MODEL_COLORS[model]
  for (const key of Object.keys(MODEL_COLORS)) {
    if (model.startsWith(key.replace(/-\d+-\d+$/, ''))) return MODEL_COLORS[key]
  }
  return '#F9E2AF'
}

function getModelShort(model: string): string {
  if (model.includes('opus')) return 'Opus'
  if (model.includes('sonnet')) return 'Sonnet'
  if (model.includes('haiku')) return 'Haiku'
  return model
}

function formatCost(usd: number): string {
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 10) return `$${usd.toFixed(1)}`
  return `$${usd.toFixed(2)}`
}

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function formatDate(ts: string): string {
  if (!ts) return '-'
  try {
    const d = new Date(ts)
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch { return ts.slice(0, 10) }
}

// ── Summary Cards ──

function SummaryCards({ today, week, allTime }: { today: number; week: number; allTime: number }) {
  return (
    <div className="grid grid-cols-3 gap-4 mb-6">
      <div className="bg-surface0 rounded-xl p-4">
        <div className="text-xs text-overlay0 uppercase tracking-wider mb-1">Today</div>
        <div className="text-2xl font-mono font-bold text-green">{formatCost(today)}</div>
      </div>
      <div className="bg-surface0 rounded-xl p-4">
        <div className="text-xs text-overlay0 uppercase tracking-wider mb-1">This Week</div>
        <div className="text-2xl font-mono font-bold text-blue">{formatCost(week)}</div>
      </div>
      <div className="bg-surface0 rounded-xl p-4">
        <div className="text-xs text-overlay0 uppercase tracking-wider mb-1">All Time</div>
        <div className="text-2xl font-mono font-bold text-peach">{formatCost(allTime)}</div>
      </div>
    </div>
  )
}

// ── Daily Cost Chart (inline SVG) ──

function DailyChart() {
  const data = useTokenomicsStore(s => s.data)
  const aggregates = useMemo(() => {
    if (!data) return []
    const result: Array<{ date: string; totalCostUsd: number }> = []
    const now = new Date()
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(d.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      result.push({ date: key, totalCostUsd: data.dailyAggregates[key]?.totalCostUsd || 0 })
    }
    return result
  }, [data])
  const maxCost = Math.max(...aggregates.map(a => a.totalCostUsd), 0.01)

  const barWidth = 16
  const gap = 4
  const chartWidth = aggregates.length * (barWidth + gap)
  const chartHeight = 120

  return (
    <div className="bg-surface0 rounded-xl p-4">
      <div className="text-xs text-overlay0 uppercase tracking-wider mb-3">Daily Cost (30 days)</div>
      <div className="overflow-x-auto">
        <svg width={chartWidth} height={chartHeight + 20} className="block">
          {aggregates.map((agg, i) => {
            const barHeight = (agg.totalCostUsd / maxCost) * chartHeight
            const x = i * (barWidth + gap)
            const y = chartHeight - barHeight
            const showLabel = i % 5 === 0 || i === aggregates.length - 1
            return (
              <g key={agg.date}>
                <rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={Math.max(barHeight, 1)}
                  rx={3}
                  fill="#FAB387"
                  opacity={agg.totalCostUsd > 0 ? 0.85 : 0.15}
                />
                {agg.totalCostUsd > 0 && (
                  <title>{`${agg.date}: ${formatCost(agg.totalCostUsd)}`}</title>
                )}
                {showLabel && (
                  <text
                    x={x + barWidth / 2}
                    y={chartHeight + 14}
                    textAnchor="middle"
                    fill="#6C7086"
                    fontSize="8"
                  >
                    {agg.date.slice(5)}
                  </text>
                )}
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

// ── Model Breakdown ──

function ModelBreakdown() {
  const data = useTokenomicsStore(s => s.data)
  const breakdown = useMemo(() => {
    if (!data) return []
    const models: Record<string, { costUsd: number; inputTokens: number; outputTokens: number }> = {}
    for (const agg of Object.values(data.dailyAggregates)) {
      for (const [model, stats] of Object.entries(agg.byModel)) {
        if (!models[model]) models[model] = { costUsd: 0, inputTokens: 0, outputTokens: 0 }
        models[model].costUsd += stats.costUsd
        models[model].inputTokens += stats.inputTokens
        models[model].outputTokens += stats.outputTokens
      }
    }
    return Object.entries(models)
      .map(([model, stats]) => ({ model, ...stats }))
      .sort((a, b) => b.costUsd - a.costUsd)
  }, [data])
  const maxCost = breakdown.length > 0 ? breakdown[0].costUsd : 1

  if (breakdown.length === 0) {
    return (
      <div className="bg-surface0 rounded-xl p-4">
        <div className="text-xs text-overlay0 uppercase tracking-wider mb-3">Model Breakdown</div>
        <div className="text-sm text-overlay0">No data yet</div>
      </div>
    )
  }

  return (
    <div className="bg-surface0 rounded-xl p-4">
      <div className="text-xs text-overlay0 uppercase tracking-wider mb-3">Model Breakdown</div>
      <div className="space-y-3">
        {breakdown.map(m => {
          const pct = maxCost > 0 ? (m.costUsd / maxCost) * 100 : 0
          const color = getModelColor(m.model)
          return (
            <div key={m.model}>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-text font-medium">{getModelShort(m.model)}</span>
                <span className="text-overlay1">{formatCost(m.costUsd)}</span>
              </div>
              <div className="h-3 bg-surface1 rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full transition-all"
                  style={{ width: `${Math.max(pct, 2)}%`, backgroundColor: color }}
                />
              </div>
              <div className="flex justify-between text-[10px] text-overlay0 mt-0.5">
                <span>{formatTokens(m.inputTokens)} in</span>
                <span>{formatTokens(m.outputTokens)} out</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Sessions Table ──

type SortKey = 'project' | 'model' | 'cost' | 'inputTokens' | 'outputTokens' | 'date'

function SessionsTable() {
  const [sortBy, setSortBy] = useState<SortKey>('cost')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 50

  const data = useTokenomicsStore(s => s.data)
  const sessions = useMemo(() => {
    if (!data) return []
    const list = Object.values(data.sessions)
    const dir = sortDir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      switch (sortBy) {
        case 'cost': return (a.totalCostUsd - b.totalCostUsd) * dir
        case 'inputTokens': return (a.totalInputTokens - b.totalInputTokens) * dir
        case 'outputTokens': return (a.totalOutputTokens - b.totalOutputTokens) * dir
        case 'date': return (a.firstTimestamp.localeCompare(b.firstTimestamp)) * dir
        case 'model': return (a.model.localeCompare(b.model)) * dir
        case 'project': return (a.projectDir.localeCompare(b.projectDir)) * dir
        default: return (a.totalCostUsd - b.totalCostUsd) * dir
      }
    })
  }, [data, sortBy, sortDir])
  const totalPages = Math.ceil(sessions.length / PAGE_SIZE)
  const paginated = sessions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  const handleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(key)
      setSortDir('desc')
    }
    setPage(0)
  }

  const SortHeader = ({ label, sortKey }: { label: string; sortKey: SortKey }) => (
    <th
      className="text-left text-xs text-overlay0 font-medium px-3 py-2 cursor-pointer hover:text-text select-none"
      onClick={() => handleSort(sortKey)}
    >
      {label}
      {sortBy === sortKey && (
        <span className="ml-1 text-blue">{sortDir === 'asc' ? '\u25B2' : '\u25BC'}</span>
      )}
    </th>
  )

  return (
    <div className="bg-surface0 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-overlay0 uppercase tracking-wider">
          Sessions ({sessions.length})
        </div>
        {totalPages > 1 && (
          <div className="flex items-center gap-2 text-xs">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-2 py-1 rounded bg-surface1 text-overlay1 hover:text-text disabled:opacity-30"
            >
              Prev
            </button>
            <span className="text-overlay0">{page + 1}/{totalPages}</span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="px-2 py-1 rounded bg-surface1 text-overlay1 hover:text-text disabled:opacity-30"
            >
              Next
            </button>
          </div>
        )}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface1">
              <SortHeader label="Project" sortKey="project" />
              <SortHeader label="Model" sortKey="model" />
              <SortHeader label="Cost" sortKey="cost" />
              <SortHeader label="Input" sortKey="inputTokens" />
              <SortHeader label="Output" sortKey="outputTokens" />
              <SortHeader label="Date" sortKey="date" />
            </tr>
          </thead>
          <tbody>
            {paginated.map(s => (
              <tr key={s.sessionId} className="border-b border-surface1/50 hover:bg-surface1/30">
                <td className="px-3 py-1.5 text-text truncate max-w-[200px]" title={s.projectDir}>
                  {s.projectDir || '-'}
                </td>
                <td className="px-3 py-1.5">
                  <span
                    className="text-xs px-1.5 py-0.5 rounded"
                    style={{ backgroundColor: getModelColor(s.model) + '20', color: getModelColor(s.model) }}
                  >
                    {getModelShort(s.model)}
                  </span>
                </td>
                <td className="px-3 py-1.5 font-mono text-peach">{formatCost(s.totalCostUsd)}</td>
                <td className="px-3 py-1.5 font-mono text-overlay1">{formatTokens(s.totalInputTokens)}</td>
                <td className="px-3 py-1.5 font-mono text-overlay1">{formatTokens(s.totalOutputTokens)}</td>
                <td className="px-3 py-1.5 text-overlay0">{formatDate(s.firstTimestamp)}</td>
              </tr>
            ))}
            {paginated.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-overlay0">
                  No session data yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Seed Progress Bar ──

function SeedProgressBar() {
  const progress = useTokenomicsStore(s => s.progress)
  const seeding = useTokenomicsStore(s => s.seeding)

  if (!seeding || !progress) return null

  const pct = progress.totalFiles > 0
    ? Math.round((progress.processedFiles / progress.totalFiles) * 100)
    : 0

  return (
    <div className="bg-surface0 rounded-xl p-4 mb-6">
      <div className="flex items-center justify-between mb-2">
        <div className="text-sm text-text">
          {progress.phase === 'scanning' ? 'Scanning transcript files...' :
           progress.phase === 'complete' ? 'Seeding complete!' :
           `Processing transcripts... (${progress.processedFiles}/${progress.totalFiles})`}
        </div>
        <div className="text-xs text-overlay0 font-mono">{pct}%</div>
      </div>
      <div className="h-2 bg-surface1 rounded-full overflow-hidden">
        <div
          className="h-full bg-peach rounded-full transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}

// ── Main Page ──

export default function TokenomicsPage() {
  const { data, loading, seeding, syncing, loadData, startSeed, startSync } = useTokenomicsStore()

  const { todayCost, weekCost, allTimeCost } = useMemo(() => {
    if (!data) return { todayCost: 0, weekCost: 0, allTimeCost: 0 }
    const today = new Date().toISOString().slice(0, 10)
    const todayCost = data.dailyAggregates[today]?.totalCostUsd || 0
    let weekCost = 0
    const now = new Date()
    for (let i = 0; i < 7; i++) {
      const d = new Date(now)
      d.setDate(d.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      weekCost += data.dailyAggregates[key]?.totalCostUsd || 0
    }
    return { todayCost, weekCost, allTimeCost: data.totalCostUsd || 0 }
  }, [data])

  useEffect(() => {
    loadData()
  }, [])

  if (loading && !data) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-overlay1 animate-pulse">Loading tokenomics data...</div>
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col overflow-y-auto p-6">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text">Tokenomics</h1>
        <div className="flex gap-2">
          <button
            onClick={() => startSeed()}
            disabled={seeding}
            className="px-3 py-1.5 text-xs rounded-lg bg-surface0 text-overlay1 hover:text-text hover:bg-surface1 disabled:opacity-50 transition-colors"
          >
            {seeding ? 'Seeding...' : 'Reseed'}
          </button>
          <button
            onClick={() => startSync()}
            disabled={syncing || seeding}
            className="px-3 py-1.5 text-xs rounded-lg bg-surface0 text-overlay1 hover:text-text hover:bg-surface1 disabled:opacity-50 transition-colors"
          >
            {syncing ? 'Syncing...' : 'Sync Now'}
          </button>
        </div>
      </div>

      <SeedProgressBar />

      <SummaryCards today={todayCost} week={weekCost} allTime={allTimeCost} />

      {/* Charts row */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="col-span-2">
          <DailyChart />
        </div>
        <ModelBreakdown />
      </div>

      {/* Sessions table */}
      <SessionsTable />
    </div>
  )
}
