import React from 'react'
import { formatValue } from '../../utils/kpiTrends'
import type { CrossAccountComparisonRow, CrossAccountInsights, InsightsRun } from '../../types/electron'

// Values here are rendered with the SAME formatter the main process uses to write
// the synthesis prompt (shared/kpi-format), so a number the model quotes in its
// prose always matches the number in the table beside it.

interface Props {
  data: CrossAccountInsights
  run: InsightsRun
  /** Resolve an account's display name (alias-aware). Falls back to the captured label. */
  nameForAccount?: (email?: string) => string | null
}

const ARROW_UP = String.fromCodePoint(0x25b2)
const ARROW_DOWN = String.fromCodePoint(0x25bc)
const ARROW_RIGHT = String.fromCodePoint(0x2192)
const WARN = String.fromCodePoint(0x26a0)

function Bullets({
  label,
  items,
  color,
  bg,
  border,
  icon,
}: {
  label: string
  items: string[]
  color: string
  bg: string
  border: string
  icon: string
}) {
  if (!items.length) return null
  return (
    <div className={`px-3 py-2 rounded-lg ${bg} border ${border}`}>
      <div className={`text-[10px] font-semibold uppercase tracking-wider ${color} mb-1.5`}>{label}</div>
      <ul className="space-y-1">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-1.5 text-xs">
            <span className={`${color} shrink-0 mt-0.5 text-[10px]`}>{icon}</span>
            <span className="text-subtext0 leading-relaxed">{item}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A row is only comparable when the accounts agreed on what the metric means. */
function isComparable(row: CrossAccountComparisonRow): boolean {
  return !row.labelVariants && !row.formatVariants
}

/**
 * Which values in a row are the best and the worst, by the metric's own
 * goodDirection. Returns nulls for a neutral or undirected metric — colouring a
 * metric where neither end is "good" would invent a judgement the data doesn't
 * carry. Ties are left uncoloured for the same reason.
 *
 * Also returns nulls for a row the accounts labelled differently: colouring one
 * account green for beating another at a metric they may not both be measuring
 * is how the first cut of this table asserted the exact inverse of the truth.
 */
function extremes(row: CrossAccountComparisonRow): { best: number | null; worst: number | null } {
  const good = row.goodDirection
  if (!isComparable(row)) return { best: null, worst: null }
  if (good !== 'up' && good !== 'down') return { best: null, worst: null }
  const values = row.values.map((v) => v.value)
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return { best: null, worst: null }
  return good === 'up' ? { best: max, worst: min } : { best: min, worst: max }
}

function ComparisonTable({
  rows,
  columns,
}: {
  rows: CrossAccountComparisonRow[]
  columns: Array<{ key: string; label: string; span?: number }>
}) {
  if (rows.length === 0) {
    return (
      <p className="text-xs text-overlay0">
        No metric appears in two or more of these accounts, so there is nothing to line up
        side by side. Each account&apos;s own report still has its full metric set.
      </p>
    )
  }

  const byCategory = new Map<string, CrossAccountComparisonRow[]>()
  for (const row of rows) {
    const list = byCategory.get(row.category)
    if (list) list.push(row)
    else byCategory.set(row.category, [row])
  }
  const showTotal = rows.some((r) => r.total != null)

  return (
    <div className="overflow-x-auto rounded-lg border border-surface0">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="bg-mantle">
            <th className="text-left font-semibold text-subtext0 px-3 py-2 whitespace-nowrap">Metric</th>
            {columns.map((c) => (
              <th key={c.key} className="text-right font-semibold text-subtext0 px-3 py-2 whitespace-nowrap">
                {c.label}
                {/* Window length under each account: a raw count from a 23-day
                    window sitting beside one from a 35-day window is only honest
                    if the reader can see the difference. */}
                {c.span != null && (
                  <span className="block text-[10px] font-normal text-overlay0">{c.span}d window</span>
                )}
              </th>
            ))}
            {showTotal && (
              <th className="text-right font-semibold text-subtext0 px-3 py-2 whitespace-nowrap">Total</th>
            )}
          </tr>
        </thead>
        <tbody>
          {[...byCategory.entries()].map(([category, catRows]) => (
            <React.Fragment key={category}>
              <tr>
                <td
                  colSpan={columns.length + 1 + (showTotal ? 1 : 0)}
                  className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-overlay0 bg-surface0/30 border-y border-surface0"
                >
                  {category}
                </td>
              </tr>
              {catRows.map((row) => {
                const { best, worst } = extremes(row)
                const byKey = new Map(row.values.map((v) => [v.key, v.value]))
                const conflict = !isComparable(row)
                const conflictTitle = conflict
                  ? [
                      row.labelVariants
                        ? `These accounts named this metric differently: ${row.labelVariants
                            .map((l) => `"${l}"`)
                            .join(' vs ')}. They may not be measuring the same thing, so the values are shown but not ranked.`
                        : '',
                      row.formatVariants ? `Units disagree: ${row.formatVariants.join(' vs ')}.` : '',
                    ]
                      .filter(Boolean)
                      .join(' ')
                  : undefined
                return (
                  <tr key={`${row.category}:${row.metricKey}`} className="border-b border-surface0/60 last:border-b-0">
                    <td className="px-3 py-1.5 text-subtext1">
                      {conflict ? (
                        <span className="flex items-center gap-1.5" title={conflictTitle}>
                          <span className="text-yellow text-[10px] shrink-0">{WARN}</span>
                          <span className="font-mono text-[11px]">{row.label}</span>
                        </span>
                      ) : (
                        row.label
                      )}
                    </td>
                    {columns.map((c) => {
                      const value = byKey.get(c.key)
                      if (value == null) {
                        // This account didn't report this metric. Blank, not zero:
                        // "absent" and "zero" are different findings.
                        return (
                          <td key={c.key} className="px-3 py-1.5 text-right text-overlay0 tabular-nums">
                            &ndash;
                          </td>
                        )
                      }
                      const tone =
                        best != null && value === best
                          ? 'text-green'
                          : worst != null && value === worst
                            ? 'text-red'
                            : 'text-text'
                      return (
                        <td key={c.key} className={`px-3 py-1.5 text-right tabular-nums ${tone}`}>
                          {formatValue(value, row.format)}
                        </td>
                      )
                    })}
                    {showTotal && (
                      <td className="px-3 py-1.5 text-right tabular-nums text-subtext0">
                        {row.total != null ? formatValue(row.total, row.format) : ''}
                      </td>
                    )}
                  </tr>
                )
              })}
            </React.Fragment>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * Renders a cross-account (aggregate) run. An aggregate has no report.html — its
 * only artifact is the CrossAccountInsights JSON — so this view replaces the
 * parsed-HTML report rather than sitting beside it.
 */
export default function CrossAccountReport({ data, run, nameForAccount }: Props) {
  const columns = data.accounts.map((a) => ({
    key: a.key,
    label: nameForAccount?.(a.accountEmail) || a.label,
    span: a.spanDays,
  }))
  const failedMembers = (run.members || []).filter((m) => m.status !== 'complete' || m.kpisUnavailable)
  const summary = data.summary
  const comparison = data.comparison ?? []
  const conflictCount = comparison.filter((r) => !isComparable(r)).length
  // Older aggregates were written before these fields existed; treat absent as
  // "nothing to disclose" rather than crashing or claiming false precision.
  const uniqueMetrics = data.uniqueMetrics ?? []
  const windowsComparable = data.windowsComparable !== false
  const uniqueByAccount = data.accounts.map((a) => ({
    account: a,
    label: nameForAccount?.(a.accountEmail) || a.label,
    metrics: uniqueMetrics.filter((u) => u.key === a.key),
  }))

  return (
    <div className="w-full h-full overflow-auto">
      <div className="p-4 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-text">Cross-account report</h2>
          <p className="text-xs text-overlay1 mt-0.5">
            {data.accounts.length} account{data.accounts.length !== 1 ? 's' : ''} compared
            {' · '}
            {comparison.length} shared metric{comparison.length !== 1 ? 's' : ''}
            {uniqueMetrics.length > 0 && ` · ${uniqueMetrics.length} single-account`}
            {' · '}
            {new Date(run.timestamp).toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
            })}
          </p>
        </div>

        {data.synthesis === 'deterministic' && (
          <div className="px-3 py-2 rounded-lg bg-yellow/10 border border-yellow/25 text-xs text-yellow">
            The written analysis could not be generated for this roll-up, so this is the
            measured comparison only. The numbers below come straight from each
            account&apos;s own report.
          </div>
        )}

        {failedMembers.length > 0 && (
          <div className="px-3 py-2 rounded-lg bg-surface0/40 border border-surface1 text-xs text-overlay1">
            <span className="text-subtext0">Left out of this comparison:</span>{' '}
            {failedMembers
              .map((m) => `${m.label || m.accountEmail || 'account'} (${m.kpisUnavailable ? 'no KPIs' : m.error || 'failed'})`)
              .join('; ')}
          </div>
        )}

        {summary && (
          <div className="grid gap-2 md:grid-cols-3">
            <Bullets
              label="Improvements"
              items={summary.improvements || []}
              color="text-green"
              bg="bg-green/5"
              border="border-green/20"
              icon={ARROW_UP}
            />
            <Bullets
              label="Regressions"
              items={summary.regressions || []}
              color="text-red"
              bg="bg-red/5"
              border="border-red/20"
              icon={ARROW_DOWN}
            />
            <Bullets
              label="Suggestions"
              items={summary.suggestions || []}
              color="text-mauve"
              bg="bg-mauve/5"
              border="border-mauve/20"
              icon={ARROW_RIGHT}
            />
          </div>
        )}

        {(data.crossAccount?.observations?.length || data.crossAccount?.recommendations?.length) && (
          <div className="grid gap-2 md:grid-cols-2">
            <Bullets
              label="Across accounts"
              items={data.crossAccount?.observations || []}
              color="text-teal"
              bg="bg-teal/5"
              border="border-teal/20"
              icon={ARROW_RIGHT}
            />
            <Bullets
              label="What to change"
              items={data.crossAccount?.recommendations || []}
              color="text-blue"
              bg="bg-blue/5"
              border="border-blue/20"
              icon={ARROW_RIGHT}
            />
          </div>
        )}

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-subtext0 mb-2">
            Metrics side by side
          </h3>
          <ComparisonTable rows={comparison} columns={columns} />
          {(conflictCount > 0 || !windowsComparable) && (
            <ul className="mt-2 space-y-1 text-[11px] text-overlay1">
              {conflictCount > 0 && (
                <li>
                  <span className="text-yellow">{WARN}</span> {conflictCount} row
                  {conflictCount !== 1 ? 's' : ''} shown by raw metric key: the accounts named the
                  metric differently, so the values are listed but not ranked. Hover a row for both
                  wordings.
                </li>
              )}
              {!windowsComparable && (
                <li>
                  No totals: these accounts cover reporting windows of different lengths, so summing
                  raw counts across them would not mean anything. Per-account windows are in the
                  column headers.
                </li>
              )}
            </ul>
          )}
        </div>

        {uniqueMetrics.length > 0 && (
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-subtext0 mb-2">
              Reported by one account only
            </h3>
            <p className="text-[11px] text-overlay1 mb-2">
              These have no comparison row because no other account reported them. That can be a real
              difference in how the accounts are used, or just different naming in each account&apos;s
              own report.
            </p>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {uniqueByAccount
                .filter((u) => u.metrics.length > 0)
                .map((u) => (
                  <div key={u.account.key} className="rounded-lg border border-surface0 bg-mantle/40 p-3">
                    <div className="text-xs font-semibold text-text truncate">{u.label}</div>
                    <ul className="mt-1.5 space-y-0.5">
                      {u.metrics.map((m) => (
                        <li
                          key={`${m.category}:${m.metricKey}`}
                          className="flex items-baseline justify-between gap-2 text-[11px]"
                        >
                          <span className="text-overlay1 truncate" title={`${m.category}.${m.metricKey}`}>
                            {m.label}
                          </span>
                          <span className="text-text tabular-nums shrink-0">
                            {formatValue(m.value, m.format)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
            </div>
          </div>
        )}

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-subtext0 mb-2">
            Per account
          </h3>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {data.accounts.map((a) => (
              <div key={a.key} className="rounded-lg border border-surface0 bg-mantle/40 p-3">
                <div className="text-xs font-semibold text-text truncate" title={a.accountEmail || a.label}>
                  {nameForAccount?.(a.accountEmail) || a.label}
                </div>
                {a.period && (
                  <div className="text-[10px] text-overlay0 mt-0.5">
                    {a.period.start} {ARROW_RIGHT} {a.period.end}
                    {/* spanDays is the calendar window computed from the dates.
                        period.days is the model's ACTIVE-day count, so the two are
                        labelled separately instead of one standing in for the other. */}
                    {a.spanDays != null && ` · ${a.spanDays}d`}
                    {a.period.days != null && `, ${a.period.days} active`}
                  </div>
                )}
                {a.topLists && (
                  <div className="mt-2 space-y-0.5">
                    {Object.entries(a.topLists).map(([name, items]) => (
                      <div key={name} className="text-[10px] text-overlay1 truncate" title={name}>
                        <span className="text-overlay0">{name}: </span>
                        {items.map((i) => `${i.name} (${i.count})`).join(', ')}
                      </div>
                    ))}
                  </div>
                )}
                {a.highlights?.length ? (
                  <ul className="mt-2 space-y-1">
                    {a.highlights.map((h, i) => (
                      <li key={i} className="flex items-start gap-1.5 text-xs">
                        <span className="text-overlay0 shrink-0 mt-0.5 text-[10px]">{ARROW_RIGHT}</span>
                        <span className="text-subtext0 leading-relaxed">{h}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-[11px] text-overlay0">No written highlights for this account.</p>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
