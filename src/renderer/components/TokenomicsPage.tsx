import React, { useEffect, useState, useMemo, useCallback } from 'react'
import { useTokenomicsStore } from '../stores/tokenomicsStore'
import type { TokenomicsSessionRecord, TokenomicsDailyAggregate } from '../../shared/types'
import PageFrame from './PageFrame'

const MODEL_COLORS: Record<string, string> = {
  // Claude models -- full versioned strings as emitted by the API
  'claude-sonnet-4-6': '#89B4FA',
  'claude-opus-4-6': '#CBA6F7',
  'claude-haiku-4-5': '#A6E3A1',
  // Codex / GPT models (P3.2) -- real model strings emitted by Codex rollouts
  'gpt-5.5':          '#A6E3A1',  // green
  'gpt-5.4':          '#89DCEB',  // sky
  'gpt-5.4-mini':     '#74C7EC',  // sapphire
  'gpt-5.3-codex':    '#FAB387',  // peach
}

function getModelColor(model: string): string {
  if (MODEL_COLORS[model]) return MODEL_COLORS[model]
  for (const key of Object.keys(MODEL_COLORS)) {
    if (model.startsWith(key.replace(/-\d+-\d+$/, ''))) return MODEL_COLORS[key]
  }
  // GPT/Codex models not explicitly listed -- use sky
  if (model.startsWith('gpt-') || model.startsWith('o')) return '#89dceb'
  // Unknown model fallback -- catppuccin subtext0
  return '#a6adc8'
}

/**
 * Short label for a model, used in compact UI surfaces (chart legend, table cells).
 * Exported for unit testing.
 *
 * Claude variants collapse to their family name (sonnet / opus / haiku) so the
 * model-breakdown chart can group all Claude versions visually. Codex / GPT
 * models drop the "gpt-" prefix to show just the version (e.g. "5.5"). Anything
 * else is returned verbatim.
 *
 * Bug fix on 2026-05-07 (Copilot review on PR #30): the prior implementation
 * stripped non-alpha characters then sliced the first 6 chars, which collapsed
 * every Claude variant to "claude" and lost Sonnet/Opus/Haiku categorization.
 */
export function getModelShort(model: string): string {
  const family = model.match(/sonnet|opus|haiku/i)
  if (family) return family[0].toLowerCase()
  if (model.startsWith('gpt-')) return model.slice(4)
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

function formatDateFull(ts: string): string {
  if (!ts) return '-'
  try {
    const d = new Date(ts)
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
  } catch { return ts }
}

/** Get the 5-hour rate limit window start for a given date */
function getRateLimitPeriod(): { fiveHourStart: string; sevenDayStart: string } {
  const now = new Date()
  const fiveHourStart = new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString()
  const sevenDayStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString()
  return { fiveHourStart, sevenDayStart }
}

// ── Filter types ──

type DateFilter = 'all' | 'today' | 'week' | '5h' | '7d' | string // string = specific date YYYY-MM-DD
type SpendFilter = 'all' | 'plan' | 'extra'
type ProviderFilter = 'all' | 'claude' | 'codex'

// ── Summary Cards ──

function formatDurationShort(ms: number): string {
  if (!ms || ms <= 0) return '-'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function SummaryCards({ today, week, fiveHour, allTime, extraSpend, rateLimitCurrent, rateLimitWeekly, burnRate }: {
  today: number; week: number; fiveHour: number; allTime: number
  extraSpend?: { enabled: boolean; usedUsd: number; limitUsd: number; lastUpdated: number }
  rateLimitCurrent?: number
  rateLimitWeekly?: number
  burnRate?: { costPerHour: number; tokensPerMinute: number }
}) {
  return (
    <div className="grid grid-cols-6 gap-3 mb-6">
      <div className="bg-surface0 rounded-xl p-4">
        <div className="text-xs text-overlay0 uppercase tracking-wider mb-1">5-Hour Window</div>
        <div className="text-2xl font-mono font-bold text-teal">{formatCost(fiveHour)}</div>
        {rateLimitCurrent != null && (
          <div className="mt-2">
            <div className="flex justify-between text-[10px] text-overlay0 mb-0.5">
              <span>Rate limit</span>
              <span className={rateLimitCurrent > 80 ? 'text-red' : 'text-overlay1'}>{rateLimitCurrent}%</span>
            </div>
            <div className="h-1.5 bg-surface1 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${rateLimitCurrent > 80 ? 'bg-red' : rateLimitCurrent > 50 ? 'bg-yellow' : 'bg-teal'}`}
                style={{ width: `${Math.min(rateLimitCurrent, 100)}%` }}
              />
            </div>
          </div>
        )}
      </div>
      <div className="bg-surface0 rounded-xl p-4">
        <div className="text-xs text-overlay0 uppercase tracking-wider mb-1">Today</div>
        <div className="text-2xl font-mono font-bold text-green">{formatCost(today)}</div>
        <div className="text-[10px] text-overlay0 mt-1">Plan usage</div>
      </div>
      <div className="bg-surface0 rounded-xl p-4">
        <div className="text-xs text-overlay0 uppercase tracking-wider mb-1">7-Day Window</div>
        <div className="text-2xl font-mono font-bold text-blue">{formatCost(week)}</div>
        {rateLimitWeekly != null && (
          <div className="mt-2">
            <div className="flex justify-between text-[10px] text-overlay0 mb-0.5">
              <span>Rate limit</span>
              <span className={rateLimitWeekly > 80 ? 'text-red' : 'text-overlay1'}>{rateLimitWeekly}%</span>
            </div>
            <div className="h-1.5 bg-surface1 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full ${rateLimitWeekly > 80 ? 'bg-red' : rateLimitWeekly > 50 ? 'bg-yellow' : 'bg-blue'}`}
                style={{ width: `${Math.min(rateLimitWeekly, 100)}%` }}
              />
            </div>
          </div>
        )}
      </div>
      <div className="bg-surface0 rounded-xl p-4">
        <div className="text-xs text-overlay0 uppercase tracking-wider mb-1">All Time</div>
        <div className="text-2xl font-mono font-bold text-peach">{formatCost(allTime)}</div>
        <div className="text-[10px] text-overlay0 mt-1">Estimated from tokens</div>
      </div>
      {extraSpend?.enabled ? (
        <div className={`rounded-xl p-4 ${extraSpend.usedUsd > 0 ? 'bg-red/10 border border-red/30' : 'bg-surface0'}`}>
          <div className="text-xs text-overlay0 uppercase tracking-wider mb-1">Extra Spend</div>
          <div className={`text-2xl font-mono font-bold ${extraSpend.usedUsd > 0 ? 'text-red' : 'text-green'}`}>
            ${extraSpend.usedUsd.toFixed(2)}
          </div>
          <div className="text-[10px] text-overlay0 mt-1">
            of ${extraSpend.limitUsd.toFixed(0)} limit
          </div>
          <div className="h-1.5 bg-surface1 rounded-full mt-2 overflow-hidden">
            <div
              className={`h-full rounded-full ${extraSpend.usedUsd > 0 ? 'bg-red' : 'bg-green'}`}
              style={{ width: `${Math.min((extraSpend.usedUsd / Math.max(extraSpend.limitUsd, 1)) * 100, 100)}%` }}
            />
          </div>
        </div>
      ) : (
        <div className="bg-surface0 rounded-xl p-4">
          <div className="text-xs text-overlay0 uppercase tracking-wider mb-1">Extra Spend</div>
          <div className="text-sm text-overlay0 mt-2">Not enabled</div>
        </div>
      )}
      <div className="bg-surface0 rounded-xl p-4">
        <div className="text-xs text-overlay0 uppercase tracking-wider mb-1">Burn Rate</div>
        {burnRate && burnRate.costPerHour > 0 ? (
          <>
            <div className={`text-2xl font-mono font-bold ${
              burnRate.costPerHour > 20 ? 'text-red' : burnRate.costPerHour > 5 ? 'text-yellow' : 'text-green'
            }`}>
              {formatCost(burnRate.costPerHour)}/hr
            </div>
            <div className="text-[10px] text-overlay0 mt-1">
              {formatTokens(Math.round(burnRate.tokensPerMinute))} tok/min
            </div>
          </>
        ) : (
          <div className="text-sm text-overlay0 mt-2">No active data</div>
        )}
      </div>
    </div>
  )
}

// ── Daily Cost Chart (clickable) ──

function DailyChart({ selectedDate, onSelectDate }: {
  selectedDate: string | null
  onSelectDate: (date: string | null) => void
}) {
  const data = useTokenomicsStore(s => s.data)
  const aggregates = useMemo(() => {
    if (!data) return []
    const result: Array<{ date: string; totalCostUsd: number; sessionCount: number; messageCount: number }> = []
    const now = new Date()
    for (let i = 29; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(d.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      const agg = data.dailyAggregates[key]
      result.push({
        date: key,
        totalCostUsd: agg?.totalCostUsd || 0,
        sessionCount: agg?.sessionCount || 0,
        messageCount: agg?.messageCount || 0,
      })
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
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-overlay0 uppercase tracking-wider">
          Daily Cost (30 days)
          {selectedDate && (
            <span className="ml-2 text-blue normal-case">
              {formatDateFull(selectedDate)}
              <button onClick={() => onSelectDate(null)} className="ml-1 text-overlay0 hover:text-text">{'\u2715'}</button>
            </span>
          )}
        </div>
      </div>
      <div className="overflow-x-auto">
        <svg width={chartWidth} height={chartHeight + 20} className="block">
          {aggregates.map((agg, i) => {
            const barHeight = (agg.totalCostUsd / maxCost) * chartHeight
            const x = i * (barWidth + gap)
            const y = chartHeight - barHeight
            const showLabel = i % 5 === 0 || i === aggregates.length - 1
            const isSelected = selectedDate === agg.date
            return (
              <g key={agg.date} className="cursor-pointer" onClick={() => onSelectDate(isSelected ? null : agg.date)}>
                <rect
                  x={x}
                  y={y}
                  width={barWidth}
                  height={Math.max(barHeight, 1)}
                  rx={3}
                  fill={isSelected ? '#89B4FA' : '#FAB387'}
                  opacity={agg.totalCostUsd > 0 ? (isSelected ? 1 : 0.85) : 0.15}
                  stroke={isSelected ? '#89B4FA' : 'none'}
                  strokeWidth={isSelected ? 2 : 0}
                />
                <title>{`${agg.date}: ${formatCost(agg.totalCostUsd)} (${agg.sessionCount} sessions, ${agg.messageCount} msgs)`}</title>
                {showLabel && (
                  <text
                    x={x + barWidth / 2}
                    y={chartHeight + 14}
                    textAnchor="middle"
                    fill={isSelected ? '#89B4FA' : '#6C7086'}
                    fontSize="8"
                    fontWeight={isSelected ? 'bold' : 'normal'}
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

function ModelBreakdown({ sessions }: { sessions: TokenomicsSessionRecord[] }) {
  const breakdown = useMemo(() => {
    const models: Record<string, { costUsd: number; inputTokens: number; outputTokens: number; count: number }> = {}
    for (const s of sessions) {
      const key = s.model || 'unknown'
      if (!models[key]) models[key] = { costUsd: 0, inputTokens: 0, outputTokens: 0, count: 0 }
      models[key].costUsd += s.totalCostUsd
      models[key].inputTokens += s.totalInputTokens + s.totalCacheReadTokens + s.totalCacheWriteTokens
      models[key].outputTokens += s.totalOutputTokens
      models[key].count++
    }
    return Object.entries(models)
      .map(([model, stats]) => ({ model, ...stats }))
      .sort((a, b) => b.costUsd - a.costUsd)
  }, [sessions])
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
                <span className="text-text font-medium">{getModelShort(m.model)} <span className="text-overlay0 font-normal">({m.count})</span></span>
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

// ── Filter Bar ──

function FilterBar({
  dateFilter, spendFilter, providerFilter,
  onDateFilter, onSpendFilter, onProviderFilter,
  selectedDate, projects, projectFilter, onProjectFilter,
}: {
  dateFilter: DateFilter
  spendFilter: SpendFilter
  providerFilter: ProviderFilter
  onDateFilter: (f: DateFilter) => void
  onSpendFilter: (f: SpendFilter) => void
  onProviderFilter: (f: ProviderFilter) => void
  selectedDate: string | null
  projects: string[]
  projectFilter: string
  onProjectFilter: (p: string) => void
}) {
  const dateButtons: Array<{ label: string; value: DateFilter }> = [
    { label: 'All', value: 'all' },
    { label: '5h', value: '5h' },
    { label: 'Today', value: 'today' },
    { label: '7d', value: '7d' },
    { label: 'Week', value: 'week' },
  ]

  return (
    <div className="flex items-center gap-4 mb-4 flex-wrap">
      <div className="flex items-center gap-1">
        <span className="text-xs text-overlay0 mr-1">Time:</span>
        {dateButtons.map(b => (
          <button
            key={b.value}
            onClick={() => onDateFilter(b.value)}
            className={`px-2 py-0.5 text-xs rounded ${
              dateFilter === b.value && !selectedDate
                ? 'bg-blue/20 text-blue'
                : 'bg-surface1 text-overlay1 hover:text-text'
            }`}
          >
            {b.label}
          </button>
        ))}
        {selectedDate && (
          <span className="px-2 py-0.5 text-xs rounded bg-blue/20 text-blue">
            {formatDateFull(selectedDate)}
            <button onClick={() => onDateFilter('all')} className="ml-1 hover:text-text">{'\u2715'}</button>
          </span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <span className="text-xs text-overlay0 mr-1">Spend:</span>
        {(['all', 'plan', 'extra'] as SpendFilter[]).map(f => (
          <button
            key={f}
            onClick={() => onSpendFilter(f)}
            className={`px-2 py-0.5 text-xs rounded capitalize ${
              spendFilter === f
                ? f === 'extra' ? 'bg-red/20 text-red' : 'bg-blue/20 text-blue'
                : 'bg-surface1 text-overlay1 hover:text-text'
            }`}
          >
            {f}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1">
        <span className="text-xs text-overlay0 mr-1">Provider:</span>
        {(['all', 'claude', 'codex'] as ProviderFilter[]).map(f => (
          <button
            key={f}
            onClick={() => onProviderFilter(f)}
            className={`px-2 py-0.5 text-xs rounded capitalize ${
              providerFilter === f
                ? f === 'codex' ? 'bg-green/20 text-green' : f === 'claude' ? 'bg-mauve/20 text-mauve' : 'bg-blue/20 text-blue'
                : 'bg-surface1 text-overlay1 hover:text-text'
            }`}
          >
            {f}
          </button>
        ))}
      </div>
      {projects.length > 1 && (
        <div className="flex items-center gap-1">
          <span className="text-xs text-overlay0 mr-1">Project:</span>
          <select
            value={projectFilter}
            onChange={(e) => onProjectFilter(e.target.value)}
            className="text-xs bg-surface1 text-overlay1 rounded px-2 py-0.5 border-none outline-none max-w-[200px]"
          >
            <option value="all">All</option>
            {projects.map(p => (
              <option key={p} value={p}>{p.split(/[/\\]/).slice(-2).join('/')}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  )
}

// ── Sessions Table ──

type SortKey = 'project' | 'model' | 'cost' | 'inputTokens' | 'outputTokens' | 'date' | 'messages' | 'cacheTokens' | 'duration' | 'costPerHour'

function SessionsTable({ sessions, title }: { sessions: TokenomicsSessionRecord[]; title?: string }) {
  const [sortBy, setSortBy] = useState<SortKey>('cost')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [page, setPage] = useState(0)
  const PAGE_SIZE = 50

  const sorted = useMemo(() => {
    const dir = sortDir === 'asc' ? 1 : -1
    return [...sessions].sort((a, b) => {
      switch (sortBy) {
        case 'cost': return (a.totalCostUsd - b.totalCostUsd) * dir
        case 'inputTokens': return (a.totalInputTokens - b.totalInputTokens) * dir
        case 'outputTokens': return (a.totalOutputTokens - b.totalOutputTokens) * dir
        case 'cacheTokens': return ((a.totalCacheReadTokens + a.totalCacheWriteTokens) - (b.totalCacheReadTokens + b.totalCacheWriteTokens)) * dir
        case 'messages': return (a.messageCount - b.messageCount) * dir
        case 'date': return (a.firstTimestamp.localeCompare(b.firstTimestamp)) * dir
        case 'model': return (a.model.localeCompare(b.model)) * dir
        case 'project': return (a.projectDir.localeCompare(b.projectDir)) * dir
        case 'duration': return ((a.durationMs || 0) - (b.durationMs || 0)) * dir
        case 'costPerHour': return ((a.costPerHour || 0) - (b.costPerHour || 0)) * dir
        default: return (a.totalCostUsd - b.totalCostUsd) * dir
      }
    })
  }, [sessions, sortBy, sortDir])

  const totalPages = Math.ceil(sorted.length / PAGE_SIZE)
  const paginated = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)

  // Compute totals for filtered sessions
  const totals = useMemo(() => {
    let cost = 0, input = 0, output = 0, cache = 0, msgs = 0
    for (const s of sessions) {
      cost += s.totalCostUsd
      input += s.totalInputTokens
      output += s.totalOutputTokens
      cache += s.totalCacheReadTokens + s.totalCacheWriteTokens
      msgs += s.messageCount
    }
    return { cost, input, output, cache, msgs }
  }, [sessions])

  const handleSort = (key: SortKey) => {
    if (sortBy === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortBy(key)
      setSortDir('desc')
    }
    setPage(0)
  }

  // Reset page when sessions change
  useEffect(() => { setPage(0) }, [sessions])

  const SortHeader = ({ label, sortKey, className }: { label: string; sortKey: SortKey; className?: string }) => (
    <th
      className={`text-left text-xs text-overlay0 font-medium px-3 py-2 cursor-pointer hover:text-text select-none ${className || ''}`}
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
          {title || 'Sessions'} ({sessions.length})
          <span className="ml-3 text-peach normal-case">Total: {formatCost(totals.cost)}</span>
          <span className="ml-2 text-overlay1 normal-case">{formatTokens(totals.input)} in / {formatTokens(totals.output)} out</span>
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
              <SortHeader label="Cache" sortKey="cacheTokens" />
              <SortHeader label="Msgs" sortKey="messages" />
              <SortHeader label="Duration" sortKey="duration" />
              <SortHeader label="$/hr" sortKey="costPerHour" />
              <SortHeader label="Date" sortKey="date" />
            </tr>
          </thead>
          <tbody>
            {paginated.map(s => (
              <tr key={s.sessionId} className="border-b border-surface1/50 hover:bg-surface1/30">
                <td className="px-3 py-1.5 text-text truncate max-w-[180px]" title={s.projectDir}>
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
                <td className="px-3 py-1.5 font-mono text-overlay0">{formatTokens(s.totalCacheReadTokens + s.totalCacheWriteTokens)}</td>
                <td className="px-3 py-1.5 font-mono text-overlay0">{s.messageCount}</td>
                <td className="px-3 py-1.5 font-mono text-overlay0">{formatDurationShort(s.durationMs || 0)}</td>
                <td className={`px-3 py-1.5 font-mono ${
                  (s.costPerHour || 0) > 20 ? 'text-red' : (s.costPerHour || 0) > 5 ? 'text-yellow' : 'text-overlay0'
                }`}>{s.costPerHour ? formatCost(s.costPerHour) : '-'}</td>
                <td className="px-3 py-1.5 text-overlay0">{formatDate(s.firstTimestamp)}</td>
              </tr>
            ))}
            {paginated.length === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-6 text-center text-overlay0">
                  No sessions match the current filter
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

// ── Usage Anomaly Alert ──

function UsageAlert({ sessions, data }: { sessions: TokenomicsSessionRecord[]; data: any }) {
  const alert = useMemo(() => {
    if (!data?.extraSpend?.enabled) return null

    // Check if rate limit is high but our tracked usage is low
    const { fiveHourStart, sevenDayStart } = getRateLimitPeriod()

    const weekSessions = sessions.filter(s => s.firstTimestamp >= sevenDayStart)
    const weekCost = weekSessions.reduce((sum, s) => sum + s.totalCostUsd, 0)
    const weekMessages = weekSessions.reduce((sum, s) => sum + s.messageCount, 0)

    // If extra spend is non-zero but we tracked very few messages, flag it
    if (data.extraSpend.usedUsd > 0 && weekMessages < 50) {
      return {
        type: 'warning' as const,
        message: `Extra spend of $${data.extraSpend.usedUsd.toFixed(2)} detected but only ${weekMessages} messages tracked this week. Usage may be coming from outside the Conductor (web, API, other CLI instances).`,
      }
    }

    return null
  }, [sessions, data])

  if (!alert) return null

  return (
    <div className="bg-yellow/10 border border-yellow/30 rounded-xl p-4 mb-6">
      <div className="flex items-start gap-2">
        <span className="text-yellow text-lg shrink-0">!</span>
        <div>
          <div className="text-sm font-medium text-yellow mb-1">Usage Anomaly</div>
          <div className="text-xs text-overlay1">{alert.message}</div>
        </div>
      </div>
    </div>
  )
}

// ── Main Page ──

export default function TokenomicsPage() {
  const { data, loading, seeding, syncing, loadData, startSeed, startSync } = useTokenomicsStore()
  const [dateFilter, setDateFilter] = useState<DateFilter>('all')
  const [spendFilter, setSpendFilter] = useState<SpendFilter>('all')
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>('all')
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [projectFilter, setProjectFilter] = useState<string>('all')

  // When chart bar is clicked, set date filter to that specific date
  const handleDateSelect = useCallback((date: string | null) => {
    setSelectedDate(date)
    if (date) setDateFilter(date)
    else setDateFilter('all')
  }, [])

  // All sessions flat
  const allSessions = useMemo(() => {
    if (!data) return []
    return Object.values(data.sessions)
  }, [data])

  // Rate limit periods
  const periods = useMemo(() => getRateLimitPeriod(), [])

  // Unique project directories
  const projects = useMemo(() => {
    const dirs = new Set<string>()
    for (const s of allSessions) {
      if (s.projectDir) dirs.add(s.projectDir)
    }
    return [...dirs].sort()
  }, [allSessions])

  // Burn rate from recent activity (last 5h window)
  const burnRate = useMemo(() => {
    const recent = allSessions.filter(s => s.firstTimestamp >= periods.fiveHourStart && s.costPerHour)
    if (recent.length === 0) return undefined
    // Weight by duration
    let totalCost = 0, totalMs = 0, totalTokens = 0
    for (const s of recent) {
      if (s.durationMs && s.durationMs > 60000) {
        totalCost += s.totalCostUsd
        totalMs += s.durationMs
        totalTokens += s.totalInputTokens + s.totalOutputTokens + s.totalCacheReadTokens + s.totalCacheWriteTokens
      }
    }
    if (totalMs <= 0) return undefined
    return {
      costPerHour: (totalCost / totalMs) * 3_600_000,
      tokensPerMinute: (totalTokens / totalMs) * 60_000,
    }
  }, [allSessions, periods])

  // Filtered sessions based on date + spend + provider + project filters
  const filteredSessions = useMemo(() => {
    let list = allSessions

    // Provider filter (P3.2) -- applies to both session list and model breakdown
    // back-filled provider='claude' on legacy records, so this is always safe
    if (providerFilter === 'claude') {
      list = list.filter(s => (s.provider ?? 'claude') === 'claude')
    } else if (providerFilter === 'codex') {
      list = list.filter(s => s.provider === 'codex')
    }

    // Project filter
    if (projectFilter !== 'all') {
      list = list.filter(s => s.projectDir === projectFilter)
    }

    // Date filter
    if (selectedDate) {
      list = list.filter(s => s.firstTimestamp.slice(0, 10) === selectedDate)
    } else {
      const today = new Date().toISOString().slice(0, 10)
      switch (dateFilter) {
        case 'today':
          list = list.filter(s => s.firstTimestamp.slice(0, 10) === today)
          break
        case '5h':
          list = list.filter(s => s.firstTimestamp >= periods.fiveHourStart)
          break
        case '7d':
        case 'week':
          list = list.filter(s => s.firstTimestamp >= periods.sevenDayStart)
          break
      }
    }

    // Spend filter - extra spend sessions are those with costUsd from statusline (no message-level tracking)
    // Plan sessions have full message-level token data from JSONL parsing
    if (spendFilter === 'plan') {
      list = list.filter(s => s.messageCount > 0)
    } else if (spendFilter === 'extra') {
      list = list.filter(s => s.messageCount === 0)
    }

    return list
  }, [allSessions, dateFilter, spendFilter, providerFilter, selectedDate, periods])

  // Summary costs
  const { todayCost, weekCost, fiveHourCost, allTimeCost } = useMemo(() => {
    if (!data) return { todayCost: 0, weekCost: 0, fiveHourCost: 0, allTimeCost: 0 }
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

    const fiveHourCost = allSessions
      .filter(s => s.firstTimestamp >= periods.fiveHourStart)
      .reduce((sum, s) => sum + s.totalCostUsd, 0)

    return { todayCost, weekCost, fiveHourCost, allTimeCost: data.totalCostUsd || 0 }
  }, [data, allSessions, periods])

  const rateLimits = useMemo(() => ({
    current: data?.rateLimits?.fiveHour,
    weekly: data?.rateLimits?.sevenDay,
  }), [data])

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

  const dollarIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="1" x2="12" y2="23" />
      <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
    </svg>
  )

  const tokenomicsActions = (
    <>
      <button
        onClick={() => startSeed()}
        disabled={seeding}
        className="px-2.5 py-0.5 text-xs rounded border border-surface1 bg-surface0 text-overlay1 hover:bg-surface1 hover:text-text disabled:opacity-50 transition-colors"
      >
        {seeding ? 'Seeding…' : 'Reseed'}
      </button>
      <button
        onClick={() => startSync()}
        disabled={syncing || seeding}
        className="px-2.5 py-0.5 text-xs rounded border border-surface1 bg-surface0 text-overlay1 hover:bg-surface1 hover:text-text disabled:opacity-50 transition-colors"
      >
        {syncing ? 'Syncing…' : 'Sync now'}
      </button>
    </>
  )

  const tokenomicsContext = (
    <>All-time {formatCost(allTimeCost)} · 5h {formatCost(fiveHourCost)}</>
  )

  return (
    <PageFrame
      icon={dollarIcon}
      iconAccent="teal"
      title="Tokenomics"
      context={tokenomicsContext}
      actions={tokenomicsActions}
    >
      <div className="p-6">
        <SeedProgressBar />

        <UsageAlert sessions={allSessions} data={data} />

        <SummaryCards
          today={todayCost}
          week={weekCost}
          fiveHour={fiveHourCost}
          allTime={allTimeCost}
          extraSpend={data?.extraSpend}
          rateLimitCurrent={rateLimits.current}
          rateLimitWeekly={rateLimits.weekly}
          burnRate={burnRate}
        />

        {/* Charts row */}
        <div className="grid grid-cols-3 gap-4 mb-6">
          <div className="col-span-2">
            <DailyChart selectedDate={selectedDate} onSelectDate={handleDateSelect} />
          </div>
          <ModelBreakdown sessions={filteredSessions} />
        </div>

        {/* Filter bar */}
        <FilterBar
          dateFilter={dateFilter}
          spendFilter={spendFilter}
          providerFilter={providerFilter}
          onDateFilter={(f) => { setDateFilter(f); setSelectedDate(null) }}
          onSpendFilter={setSpendFilter}
          onProviderFilter={setProviderFilter}
          selectedDate={selectedDate}
          projects={projects}
          projectFilter={projectFilter}
          onProjectFilter={setProjectFilter}
        />

        {/* Sessions table */}
        <SessionsTable
          sessions={filteredSessions}
          title={selectedDate ? `Sessions on ${formatDateFull(selectedDate)}` : undefined}
        />
      </div>
    </PageFrame>
  )
}
