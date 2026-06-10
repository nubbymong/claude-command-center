import React, { useEffect, useState, useMemo, useCallback } from 'react'
import { useTokenomicsStore } from '../stores/tokenomicsStore'
import { useSettingsStore } from '../stores/settingsStore'
import { useAccountProfilesStore } from '../stores/accountProfilesStore'
import { resolveAccountNameByEmail } from '../../shared/account-chip-color'
import type { TokenomicsSessionRecord, TokenomicsDailyAggregate } from '../../shared/types'
import PageFrame from './PageFrame'
import { AccountFilter, type AccountFilterValue } from './tokenomics/AccountFilter'
import { WizardTrigger } from './tokenomics/WizardTrigger'
import { EditAttributionMenu } from './tokenomics/EditAttributionMenu'
import { useAppMetaStore } from '../stores/appMetaStore'
import { IndexingState } from './tokenomics/IndexingState'
import { FilterBar as NewFilterBar } from './tokenomics/FilterBar'
import { KpiRow } from './tokenomics/KpiRow'
import { CostOverTimeChart } from './tokenomics/CostOverTimeChart'
import { ModelCacheDonut } from './tokenomics/ModelCacheDonut'
import { CostByConfig } from './tokenomics/CostByConfig'
import { SessionsTable as NewSessionsTable } from './tokenomics/SessionsTable'
import { SessionDetailDrawer } from './tokenomics/SessionDetailDrawer'
import { ActivityHeatmap } from './tokenomics/ActivityHeatmap'

// Chart series bound to semantic tokens (theme-aware). Spec section 5: copper = Opus
// ONLY, desaturated via --chart-opus so it does not dominate; never a status.
export function getModelColor(model: string): string {
  const m = model.toLowerCase()
  if (m.includes('fable')) return 'var(--chart-fable)'
  if (m.includes('opus')) return 'var(--chart-opus)'
  if (m.includes('sonnet')) return 'var(--chart-sonnet)'
  if (m.startsWith('gpt-') || m.includes('codex') || m.startsWith('o')) return 'var(--chart-codex)'
  return 'var(--chart-other)'   // haiku + unknown
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
  const family = model.match(/sonnet|opus|haiku|fable/i)
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

// ── Account-scoped rollups (pure, exported for unit testing) ──

/** Roll a session list up into a per-day map (date key 'YYYY-MM-DD' from the
 *  session's firstTimestamp). Drives the per-account DailyChart. */
export function rollupSessionsByDay(
  sessions: TokenomicsSessionRecord[],
): Record<string, { totalCostUsd: number; sessionCount: number; messageCount: number }> {
  const m: Record<string, { totalCostUsd: number; sessionCount: number; messageCount: number }> = {}
  for (const s of sessions) {
    const key = s.firstTimestamp.slice(0, 10)
    const e = (m[key] ||= { totalCostUsd: 0, sessionCount: 0, messageCount: 0 })
    e.totalCostUsd += s.totalCostUsd
    e.sessionCount++
    e.messageCount += s.messageCount
  }
  return m
}

/** Per-account summary-card windows derived from a session list. `now` is
 *  injected so this is deterministically testable. Matches the global card
 *  semantics: today + 7-day by calendar (UTC) date key, 5h rolling, all-time =
 *  sum of every scoped session. */
export function computeAccountSummaryCosts(
  sessions: TokenomicsSessionRecord[],
  now: Date,
  fiveHourStartIso: string,
): { todayCost: number; weekCost: number; fiveHourCost: number; allTimeCost: number } {
  const todayKey = now.toISOString().slice(0, 10)
  const weekStart = new Date(now)
  weekStart.setDate(weekStart.getDate() - 6) // 7 calendar days incl. today
  const weekStartKey = weekStart.toISOString().slice(0, 10)
  let todayCost = 0, weekCost = 0, fiveHourCost = 0, allTimeCost = 0
  for (const s of sessions) {
    const day = s.firstTimestamp.slice(0, 10)
    allTimeCost += s.totalCostUsd
    if (day === todayKey) todayCost += s.totalCostUsd
    if (day >= weekStartKey) weekCost += s.totalCostUsd
    if (s.firstTimestamp >= fiveHourStartIso) fiveHourCost += s.totalCostUsd
  }
  return { todayCost, weekCost, fiveHourCost, allTimeCost }
}

// ── Filter types ──

type DateFilter = 'all' | 'today' | 'week' | '5h' | '7d' | string // string = specific date YYYY-MM-DD
type SpendFilter = 'all' | 'plan' | 'extra'
type ProviderFilter = 'all' | 'claude' | 'codex'

// V2 Phase 1: three lenses only. Channel/Member/Worktree are Phase 2.
export type GroupByLens = 'project' | 'account' | 'model'

// ── Summary Cards ──

function formatDurationShort(ms: number): string {
  if (!ms || ms <= 0) return '-'
  const h = Math.floor(ms / 3_600_000)
  const m = Math.floor((ms % 3_600_000) / 60_000)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function SummaryCards({ today, week, fiveHour, allTime, extraSpend, rateLimitCurrent, rateLimitWeekly, burnRate }: {
  today: number; week: number; fiveHour: number; allTime: number
  extraSpend?: { enabled: boolean; usedUsd: number; limitUsd: number; lastUpdated: number }
  rateLimitCurrent?: number
  rateLimitWeekly?: number
  burnRate?: { costPerHour: number; tokensPerMinute: number }
}) {
  return (
    <div className="grid grid-cols-6 gap-3 mb-6">
      <div
        className="rounded-xl p-4"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
      >
        <div className="text-xs text-overlay0 uppercase tracking-wider mb-1">5-Hour Window</div>
        <div className="text-2xl font-mono font-bold text-teal">{formatCost(fiveHour)}</div>
        {rateLimitCurrent != null && (
          <div className="mt-2">
            <div className="flex justify-between text-[10px] text-overlay0 mb-0.5">
              <span>Rate limit</span>
              <span style={rateLimitCurrent > 80 ? { color: 'var(--status-danger)' } : undefined} className={rateLimitCurrent > 80 ? '' : 'text-overlay1'}>{rateLimitCurrent}%</span>
            </div>
            <div className="h-1.5 bg-surface1 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(rateLimitCurrent, 100)}%`,
                  background: rateLimitCurrent > 80
                    ? 'var(--status-danger)'
                    : rateLimitCurrent > 50
                    ? 'var(--status-warning)'
                    : 'var(--accent)',
                }}
              />
            </div>
          </div>
        )}
      </div>
      <div
        className="rounded-xl p-4"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
      >
        <div className="text-xs text-overlay0 uppercase tracking-wider mb-1">Today</div>
        <div className="text-2xl font-mono font-bold text-green">{formatCost(today)}</div>
        <div className="text-[10px] text-overlay0 mt-1">Plan usage</div>
      </div>
      <div
        className="rounded-xl p-4"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
      >
        <div className="text-xs text-overlay0 uppercase tracking-wider mb-1">7-Day Window</div>
        <div className="text-2xl font-mono font-bold text-blue">{formatCost(week)}</div>
        {rateLimitWeekly != null && (
          <div className="mt-2">
            <div className="flex justify-between text-[10px] text-overlay0 mb-0.5">
              <span>Rate limit</span>
              <span style={rateLimitWeekly > 80 ? { color: 'var(--status-danger)' } : undefined} className={rateLimitWeekly > 80 ? '' : 'text-overlay1'}>{rateLimitWeekly}%</span>
            </div>
            <div className="h-1.5 bg-surface1 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.min(rateLimitWeekly, 100)}%`,
                  background: rateLimitWeekly > 80
                    ? 'var(--status-danger)'
                    : rateLimitWeekly > 50
                    ? 'var(--status-warning)'
                    : 'var(--accent)',
                }}
              />
            </div>
          </div>
        )}
      </div>
      <div
        className="rounded-xl p-4"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
      >
        <div className="text-xs text-overlay0 uppercase tracking-wider mb-1">All Time</div>
        <div className="text-2xl font-mono font-bold text-peach">{formatCost(allTime)}</div>
        <div className="text-[10px] text-overlay0 mt-1">Estimated from tokens</div>
      </div>
      {extraSpend?.enabled ? (
        <div
          className="rounded-xl p-4"
          style={{
            background: extraSpend.usedUsd > 0 ? 'color-mix(in srgb, var(--status-danger) 10%, transparent)' : 'var(--surface-raised)',
            border: extraSpend.usedUsd > 0 ? '1px solid color-mix(in srgb, var(--status-danger) 30%, transparent)' : '1px solid var(--border-subtle)',
          }}
        >
          <div className="text-xs text-overlay0 uppercase tracking-wider mb-1">Extra Spend</div>
          <div
            className="text-2xl font-mono font-bold"
            style={{ color: extraSpend.usedUsd > 0 ? 'var(--status-danger)' : 'var(--status-success)' }}
          >
            ${extraSpend.usedUsd.toFixed(2)}
          </div>
          <div className="text-[10px] text-overlay0 mt-1">
            of ${extraSpend.limitUsd.toFixed(0)} limit
          </div>
          <div className="h-1.5 bg-surface1 rounded-full mt-2 overflow-hidden">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.min((extraSpend.usedUsd / Math.max(extraSpend.limitUsd, 1)) * 100, 100)}%`,
                background: extraSpend.usedUsd > 0 ? 'var(--status-danger)' : 'var(--status-success)',
              }}
            />
          </div>
        </div>
      ) : (
        <div
          className="rounded-xl p-4"
          style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
        >
          <div className="text-xs text-overlay0 uppercase tracking-wider mb-1">Extra Spend</div>
          <div className="text-sm text-overlay0 mt-2">Not enabled</div>
        </div>
      )}
      <div
        className="rounded-xl p-4"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
      >
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

export function DailyChart({ selectedDate, onSelectDate, accountSessions }: {
  selectedDate: string | null
  onSelectDate: (date: string | null) => void
  /** When provided (a specific account is filtered), the chart is built from
   *  these account-scoped sessions instead of the global daily aggregates. */
  accountSessions?: TokenomicsSessionRecord[] | null
}) {
  const data = useTokenomicsStore(s => s.data)
  const aggregates = useMemo(() => {
    const result: Array<{ date: string; totalCostUsd: number; sessionCount: number; messageCount: number }> = []
    const now = new Date()

    // Per-account: roll the account-scoped sessions up into a per-day map.
    const perDay = accountSessions ? rollupSessionsByDay(accountSessions) : null

    for (let i = 29; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(d.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      const agg = perDay ? perDay[key] : data?.dailyAggregates[key]
      result.push({
        date: key,
        totalCostUsd: agg?.totalCostUsd || 0,
        sessionCount: agg?.sessionCount || 0,
        messageCount: agg?.messageCount || 0,
      })
    }
    return result
  }, [data, accountSessions])
  const maxCost = Math.max(...aggregates.map(a => a.totalCostUsd), 0.01)

  const barWidth = 16
  const gap = 4
  const chartWidth = aggregates.length * (barWidth + gap)
  const chartHeight = 120

  return (
    <div
      className="rounded-xl p-4"
      style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-overlay0 uppercase tracking-wider">
          Daily Cost (30 days)
          {selectedDate && (
            <span className="ml-2 text-blue normal-case">
              {formatDateFull(selectedDate)}
              <button onClick={() => onSelectDate(null)} className="ml-1 text-overlay0 hover:text-text">{'✕'}</button>
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
                  style={{ fill: isSelected ? 'var(--accent)' : 'var(--chart-other)', stroke: isSelected ? 'var(--accent)' : 'none' }}
                  opacity={agg.totalCostUsd > 0 ? (isSelected ? 1 : 0.85) : 0.15}
                  strokeWidth={isSelected ? 2 : 0}
                />
                <title>{`${agg.date}: ${formatCost(agg.totalCostUsd)} (${agg.sessionCount} sessions, ${agg.messageCount} msgs)`}</title>
                {showLabel && (
                  <text
                    x={x + barWidth / 2}
                    y={chartHeight + 14}
                    textAnchor="middle"
                    style={{ fill: isSelected ? 'var(--accent)' : 'var(--text-muted)' }}
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

// ── Breakdown Panel ──

export function BreakdownPanel({ sessions, groupBy, labelForAccount }: { sessions: TokenomicsSessionRecord[]; groupBy: GroupByLens; labelForAccount?: (email: string) => string }) {
  const breakdown = useMemo(() => {
    const buckets: Record<string, { costUsd: number; inputTokens: number; outputTokens: number; count: number }> = {}
    for (const s of sessions) {
      let key: string
      if (groupBy === 'project') key = s.projectDir || '(no project)'
      else if (groupBy === 'account') key = (s as any).accountEmail || '(unattributed)'
      else key = s.model || 'unknown'
      if (!buckets[key]) buckets[key] = { costUsd: 0, inputTokens: 0, outputTokens: 0, count: 0 }
      buckets[key].costUsd += s.totalCostUsd
      buckets[key].inputTokens += s.totalInputTokens + s.totalCacheReadTokens + s.totalCacheWriteTokens
      buckets[key].outputTokens += s.totalOutputTokens
      buckets[key].count++
    }
    return Object.entries(buckets)
      .map(([key, stats]) => ({ key, ...stats }))
      .sort((a, b) => b.costUsd - a.costUsd)
  }, [sessions, groupBy])
  const maxCost = breakdown.length > 0 ? breakdown[0].costUsd : 1

  const title = groupBy === 'project' ? 'Project Breakdown' : groupBy === 'account' ? 'Account Breakdown' : 'Model Breakdown'

  if (breakdown.length === 0) {
    return (
      <div
        className="rounded-xl p-4"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
      >
        <div className="text-xs text-overlay0 uppercase tracking-wider mb-3">{title}</div>
        <div className="text-sm text-overlay0">No data yet</div>
      </div>
    )
  }

  return (
    <div
      className="rounded-xl p-4"
      style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="text-xs text-overlay0 uppercase tracking-wider mb-3">{title}</div>
      <div className="space-y-3">
        {breakdown.map(m => {
          const pct = maxCost > 0 ? (m.costUsd / maxCost) * 100 : 0
          const color = groupBy === 'model' ? getModelColor(m.key) : 'var(--chart-other)'
          const label = groupBy === 'model'
            ? getModelShort(m.key)
            : groupBy === 'account' && labelForAccount && m.key !== '(unattributed)'
            ? labelForAccount(m.key)
            : m.key
          return (
            <div key={m.key}>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-text font-medium">{label} <span className="text-overlay0 font-normal">({m.count})</span></span>
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

// ── Old Filter Bar (kept for legacy export compatibility) ──

export function FilterBar({
  dateFilter, spendFilter, providerFilter,
  onDateFilter, onSpendFilter, onProviderFilter,
  selectedDate, projects, projectFilter, onProjectFilter,
  accountEmails, accountFilter, onAccountFilter, accountLabelFor,
  groupBy, onGroupBy,
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
  accountEmails: string[]
  accountFilter: AccountFilterValue
  onAccountFilter: (next: AccountFilterValue) => void
  accountLabelFor?: (email: string) => string
  groupBy: GroupByLens
  onGroupBy: (g: GroupByLens) => void
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
        <span className="text-xs text-overlay0 mr-1">Group by:</span>
        {(['project', 'account', 'model'] as GroupByLens[]).map(g => (
          <button
            key={g}
            onClick={() => onGroupBy(g)}
            className={`px-2 py-0.5 text-xs rounded capitalize ${
              groupBy === g
                ? 'bg-blue/20 text-blue'
                : 'bg-surface1 text-overlay1 hover:text-text'
            }`}
          >
            {g}
          </button>
        ))}
      </div>
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
            <button onClick={() => onDateFilter('all')} className="ml-1 hover:text-text">{'✕'}</button>
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
      <div className="flex items-center gap-1">
        <span className="text-xs text-overlay0 mr-1">Account:</span>
        <AccountFilter emails={accountEmails} value={accountFilter} onChange={onAccountFilter} labelForEmail={accountLabelFor} />
      </div>
    </div>
  )
}

// ── Sessions Table ──

type SortKey = 'project' | 'model' | 'cost' | 'inputTokens' | 'outputTokens' | 'date' | 'messages' | 'cacheTokens' | 'duration' | 'costPerHour'

export function SessionsTable({ sessions, title, observedEmails, onRefresh, groupBy, labelForAccount }: { sessions: TokenomicsSessionRecord[]; title?: string; observedEmails: string[]; onRefresh: () => void; groupBy?: GroupByLens; labelForAccount?: (email: string) => string }) {
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

  const groupedSorted = useMemo(() => {
    if (!groupBy) return null
    const buckets: Record<string, TokenomicsSessionRecord[]> = {}
    for (const s of sorted) {
      let key: string
      if (groupBy === 'project') key = s.projectDir || '(no project)'
      else if (groupBy === 'account') key = (s as any).accountEmail || '(unattributed)'
      else key = s.model || 'unknown'
      if (!buckets[key]) buckets[key] = []
      buckets[key].push(s)
    }
    return Object.entries(buckets).sort(([a], [b]) => a.localeCompare(b))
  }, [sorted, groupBy])

  const flatPages = !groupBy
  const totalPages = flatPages ? Math.ceil(sorted.length / PAGE_SIZE) : 1
  const paginated = flatPages ? sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE) : sorted

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

  const renderRow = (s: TokenomicsSessionRecord) => (
    <tr key={s.sessionId} className="border-b border-surface1/50 hover:bg-surface1/30">
      <td className="px-3 py-1.5 text-text truncate max-w-[180px]" title={s.projectDir}>
        {s.projectDir || '-'}
      </td>
      <td className="px-3 py-1.5">
        <span
          className="text-xs px-1.5 py-0.5 rounded"
          style={{ backgroundColor: `color-mix(in srgb, ${getModelColor(s.model)} 13%, transparent)`, color: getModelColor(s.model) }}
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
      <td className="px-3 py-1.5">
        <EditAttributionMenu
          sessionId={s.sessionId}
          detectedEmails={observedEmails}
          onChange={onRefresh}
        />
      </td>
    </tr>
  )

  const SortHeader = ({ label, sortKey, className }: { label: string; sortKey: SortKey; className?: string }) => (
    <th
      className={`text-left text-xs text-overlay0 font-medium px-3 py-2 cursor-pointer hover:text-text select-none ${className || ''}`}
      onClick={() => handleSort(sortKey)}
    >
      {label}
      {sortBy === sortKey && (
        <span className="ml-1 text-blue">{sortDir === 'asc' ? '▲' : '▼'}</span>
      )}
    </th>
  )

  return (
    <div
      className="rounded-xl p-4"
      style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="flex items-center justify-between mb-3">
        <div className="text-xs text-overlay0 uppercase tracking-wider">
          {title || 'Sessions'} ({sessions.length})
          <span className="ml-3 text-peach normal-case">Total: {formatCost(totals.cost)}</span>
          <span className="ml-2 text-overlay1 normal-case">{formatTokens(totals.input)} in / {formatTokens(totals.output)} out</span>
        </div>
        {flatPages && totalPages > 1 && (
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
              <th className="px-3 py-1.5 text-left text-xs text-overlay0 font-normal">Attribution</th>
            </tr>
          </thead>
          <tbody>
            {groupedSorted ? (
              groupedSorted.map(([key, group]) => (
                <React.Fragment key={key}>
                  <tr data-testid="group-header" className="bg-surface1/40">
                    <td colSpan={11} className="px-3 py-1.5 text-xs text-overlay1 font-semibold">
                      {groupBy === 'account' && labelForAccount && key !== '(unattributed)' ? labelForAccount(key) : key}
                      <span className="text-overlay0 font-normal ml-2">{group.length}</span>
                    </td>
                  </tr>
                  {group.map(s => renderRow(s))}
                </React.Fragment>
              ))
            ) : (
              <>
                {paginated.map(s => renderRow(s))}
                {paginated.length === 0 && (
                  <tr>
                    <td colSpan={11} className="px-3 py-6 text-center text-overlay0">
                      No sessions match the current filter
                    </td>
                  </tr>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

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

  useEffect(() => {
    const s = useTokenomicsStore.getState()
    s.init()
    return () => s.dispose()
  }, [])

  const contextText = summary
    ? `$${summary.kpis.lifeToDateCostUsd.toFixed(2)} life-to-date`
    : undefined

  return (
    <PageFrame
      icon={dollarIcon}
      iconAccent="teal"
      title="Tokenomics"
      context={contextText}
    >
      <div className="p-5">
        {/* Indexing / first-load gate */}
        {(indexStatus === null || !indexStatus.firstIndexComplete) ? (
          <IndexingState status={indexStatus} />
        ) : (
          <>
            {/* Page heading */}
            <div className="flex items-baseline gap-2 mb-4">
              <h2 className="text-sm font-semibold text-text">Usage dashboard</h2>
              <span className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                API-equivalent estimate
              </span>
            </div>

            {/* Filter bar */}
            <NewFilterBar />

            {/* KPI row + charts — shimmer while loading */}
            {loadingSummary && !summary ? (
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
            <SessionDetailDrawer />
          </>
        )}
      </div>
    </PageFrame>
  )
}
