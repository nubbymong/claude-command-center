import React from 'react'
import { useTokenomicsStore } from '../../stores/tokenomicsStore'
import type { TkSessionRow } from '../../../shared/types'
import { getModelColor, getModelShort } from './modelColors'

// ── Format helpers ─────────────────────────────────────────────────────────────

function formatCost(usd: number): string {
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

function SessionRow({
  row,
  onSelect,
}: {
  row: TkSessionRow
  onSelect: (id: string) => void
}) {
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
      {/* Model */}
      <td className="px-3 py-2">
        <span
          className="text-xs px-1.5 py-0.5 rounded"
          style={{
            backgroundColor: `color-mix(in srgb, ${color} 13%, transparent)`,
            color,
          }}
        >
          {getModelShort(row.model)}
        </span>
      </td>
      {/* Cost */}
      <td
        className="px-3 py-2 font-mono text-xs"
        style={{ color: 'var(--color-peach)' }}
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
}

// ── Main component ─────────────────────────────────────────────────────────────

const HEADER_CELLS: { label: string; className?: string }[] = [
  { label: 'Config' },
  { label: 'Model' },
  { label: 'Cost' },
  { label: 'In' },
  { label: 'Out' },
  { label: 'Cache' },
  { label: 'Msgs' },
  { label: 'Date' },
]

export function SessionsTable() {
  const sessions = useTokenomicsStore((s) => s.sessions)
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
                <SessionRow key={row.sessionId} row={row} onSelect={selectSession} />
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
}
