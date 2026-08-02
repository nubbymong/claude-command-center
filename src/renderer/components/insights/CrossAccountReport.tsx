import React from 'react'
import { formatValue } from '../../utils/kpiTrends'
import type { CrossAccountComparisonRow, CrossAccountInsights, InsightsRun } from '../../types/electron'

interface Props {
  data: CrossAccountInsights
  run: InsightsRun
  /** Resolve an account's display name (alias-aware). Falls back to the captured label. */
  nameForAccount?: (email?: string) => string | null
}

const ARROW_UP = String.fromCodePoint(0x25b2)
const ARROW_DOWN = String.fromCodePoint(0x25bc)
const ARROW_RIGHT = String.fromCodePoint(0x2192)

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

/**
 * Which values in a row are the best and the worst, by the metric's own
 * goodDirection. Returns nulls for a neutral or undirected metric — colouring a
 * metric where neither end is "good" would invent a judgement the data doesn't
 * carry. Ties are left uncoloured for the same reason.
 */
function extremes(row: CrossAccountComparisonRow): { best: number | null; worst: number | null } {
  const good = row.goodDirection
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
  columns: Array<{ key: string; label: string }>
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
                return (
                  <tr key={`${row.category}:${row.metricKey}`} className="border-b border-surface0/60 last:border-b-0">
                    <td className="px-3 py-1.5 text-subtext1">{row.label}</td>
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
  }))
  const failedMembers = (run.members || []).filter((m) => m.status !== 'complete' || m.kpisUnavailable)
  const summary = data.summary

  return (
    <div className="w-full h-full overflow-auto">
      <div className="p-4 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-text">Cross-account report</h2>
          <p className="text-xs text-overlay1 mt-0.5">
            {data.accounts.length} account{data.accounts.length !== 1 ? 's' : ''} compared
            {' · '}
            {data.comparison.length} shared metric{data.comparison.length !== 1 ? 's' : ''}
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
          <ComparisonTable rows={data.comparison} columns={columns} />
        </div>

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
                    {a.period.days != null && ` (${a.period.days}d)`}
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
