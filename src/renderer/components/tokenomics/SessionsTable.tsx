import React, { memo } from 'react'
import { useTokenomicsStore } from '../../stores/tokenomicsStore'
import type { TkSessionRow } from '../../../shared/types'
import type { AccountsSnapshot } from '../../../shared/providers'
import { getModelColor, getModelShort } from './modelColors'
import { useProviderAccountsStore } from '../../stores/providerAccountsStore'
import { ProviderMark } from '../sidebar/Badges'
import { tkAccountLabel, tkAccountColourKey, tkCostTooltip, TK_PROVIDER_LABEL, TK_NOT_RECORDED } from './tk-labels'
import { IdentityChip } from '../ui/IdentityChip'
import { resolveIdentityColor } from '../../../shared/identity-colors'
import { useResolvedTheme } from '../../hooks/useThemeController'

// ── Format helpers ─────────────────────────────────────────────────────────────

function formatCost(usd: number | null): string {
  // No price for its model (usage track MP11): never shown as $0.
  if (usd === null) return 'no price'
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 10) return `$${usd.toFixed(1)}`
  return `$${usd.toFixed(2)}`
}

function formatTokensCompact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** epoch ms → e.g. "Jun 5" */
function formatTs(ts: number): string {
  if (!ts) return '-'
  try {
    return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch {
    return '-'
  }
}

// ── Row renderer ───────────────────────────────────────────────────────────────

// Memoised (MP12 round 1): a row re-renders only when its own data does.
const SessionRow = memo(function SessionRow({
  row,
  onSelect,
  snapshot,
  theme,
}: {
  row: TkSessionRow
  onSelect: (id: string) => void
  snapshot: AccountsSnapshot | null
  theme: 'dark' | 'light'
}) {
  const account = tkAccountLabel(snapshot, row.accountKey ?? '')
  // The account's identity chip, as the approved canvas draws it.
  const colourKey = tkAccountColourKey(snapshot, row.accountKey ?? '')
  const notRecorded = account === TK_NOT_RECORDED
  const color = getModelColor(row.model)
  return (
    <tr
      className="border-b cursor-pointer hover:bg-surface1/30 transition-colors"
      style={{ borderColor: 'var(--border-subtle)' }}
      onClick={() => onSelect(row.sessionId)}
    >
      {/* Config */}
      <td
        className="px-3 py-2 text-xs truncate max-w-[160px]"
        style={{ color: 'var(--text-secondary)' }}
        title={row.configLabel}
      >
        {row.configLabel || <span style={{ color: 'var(--text-muted)' }}>External</span>}
      </td>
      {/* Model, with its provider's mark (MP12) */}
      <td className="px-3 py-2">
        <span className="inline-flex items-center gap-1.5">
          <ProviderMark providerId={row.provider} size={14} title={TK_PROVIDER_LABEL[row.provider]} />
          <span
            className="text-xs px-1.5 py-0.5 rounded"
            style={{
              backgroundColor: `color-mix(in srgb, ${color} 13%, transparent)`,
              color,
            }}
          >
            {getModelShort(row.model)}
          </span>
        </span>
      </td>
      {/* Account (MP12): its identity chip and name; "Not recorded" muted */}
      <td
        className="px-3 py-2 text-xs max-w-[160px]"
        style={{ color: notRecorded ? 'var(--text-muted)' : 'var(--text-secondary)' }}
        title={account}
      >
        <span className="inline-flex items-center gap-1.5 min-w-0">
          {colourKey && <IdentityChip color={resolveIdentityColor(colourKey, theme)} />}
          <span className="truncate" data-testid="tk-session-account">{account}</span>
        </span>
      </td>
      {/* Cost, with its wording per provider (Q1.5) */}
      <td
        className="px-3 py-2 font-mono text-xs"
        style={{ color: row.costUsd === null ? 'var(--text-muted)' : 'var(--color-peach)', fontStyle: row.costUsd === null ? 'italic' : undefined }}
        title={tkCostTooltip(row.provider, row.accountKey ?? '', snapshot, row.costUsd)}
      >
        {formatCost(row.costUsd)}
      </td>
      {/* In */}
      <td
        className="px-3 py-2 font-mono text-xs"
        style={{ color: 'var(--text-secondary)' }}
      >
        {formatTokensCompact(row.inTok)}
      </td>
      {/* Out */}
      <td
        className="px-3 py-2 font-mono text-xs"
        style={{ color: 'var(--text-secondary)' }}
      >
        {formatTokensCompact(row.outTok)}
      </td>
      {/* Cache */}
      <td
        className="px-3 py-2 font-mono text-xs"
        style={{ color: 'var(--text-muted)' }}
      >
        {formatTokensCompact(row.cacheReadTok)}
      </td>
      {/* Msgs */}
      <td
        className="px-3 py-2 font-mono text-xs"
        style={{ color: 'var(--text-muted)' }}
      >
        {row.msgCount}
      </td>
      {/* Date */}
      <td
        className="px-3 py-2 text-xs"
        style={{ color: 'var(--text-muted)' }}
      >
        {formatTs(row.lastTs)}
      </td>
    </tr>
  )
})

// ── Main component ─────────────────────────────────────────────────────────────

const HEADER_CELLS: { label: string; className?: string }[] = [
  { label: 'Config' },
  { label: 'Model' },
  { label: 'Account' },
  { label: 'Cost' },
  { label: 'In' },
  { label: 'Out' },
  { label: 'Cache' },
  { label: 'Msgs' },
  { label: 'Date' },
]

// Memoised (MP12 round 1): it reads the store itself, so a page re-render
// passes it nothing new.
export const SessionsTable = memo(function SessionsTable() {
  const theme = useResolvedTheme()
  const sessions = useTokenomicsStore((s) => s.sessions)
  const snapshot = useProviderAccountsStore((s) => s.snapshot)
  const nextCursor = useTokenomicsStore((s) => s.nextCursor)
  const loadingSessions = useTokenomicsStore((s) => s.loadingSessions)
  const loadMore = useTokenomicsStore((s) => s.loadMore)
  const selectSession = useTokenomicsStore((s) => s.selectSession)

  return (
    <div
      className="rounded-xl p-4 mb-5"
      style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="text-[11px] text-overlay0 uppercase tracking-wider mb-3">
        Sessions
        {sessions.length > 0 && (
          <span className="ml-2 normal-case" style={{ color: 'var(--text-muted)' }}>
            {sessions.length} loaded
          </span>
        )}
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
              {HEADER_CELLS.map(({ label, className }) => (
                <th
                  key={label}
                  className={`text-left px-3 py-2 text-[11px] font-medium uppercase tracking-wider ${className ?? ''}`}
                  style={{ color: 'var(--text-muted)' }}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sessions.length === 0 ? (
              <tr>
                <td
                  colSpan={HEADER_CELLS.length}
                  className="px-3 py-8 text-center text-xs"
                  style={{ color: 'var(--text-muted)' }}
                >
                  No sessions
                </td>
              </tr>
            ) : (
              sessions.map((row) => (
                <SessionRow key={row.sessionId} row={row} onSelect={selectSession} snapshot={snapshot} theme={theme} />
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Load more */}
      {nextCursor !== null && (
        <div className="mt-3 flex justify-center">
          <button
            onClick={() => loadMore()}
            disabled={loadingSessions}
            className="px-4 py-1.5 text-xs rounded-lg transition-colors disabled:opacity-40"
            style={{
              background: 'var(--surface-stage)',
              border: '1px solid var(--border-subtle)',
              color: 'var(--text-secondary)',
            }}
          >
            {loadingSessions ? 'Loading…' : 'Load more'}
          </button>
        </div>
      )}
    </div>
  )
})
