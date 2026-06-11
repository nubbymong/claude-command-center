import React from 'react'
import { useTokenomicsStore } from '../../stores/tokenomicsStore'
import type { TkSessionDetail } from '../../../shared/types'
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

function formatTs(ts: number): string {
  if (!ts) return '-'
  try {
    return new Date(ts).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return '-'
  }
}

// ── Drawer panel ───────────────────────────────────────────────────────────────

function DrawerContent({
  detail,
  onClose,
}: {
  detail: TkSessionDetail
  onClose: () => void
}) {
  const projectShort = detail.projectDir
    ? detail.projectDir.split(/[/\\]/).slice(-2).join('/')
    : null

  return (
    <div
      className="fixed right-0 top-0 bottom-0 z-50 flex flex-col overflow-y-auto"
      style={{
        width: 360,
        background: 'var(--surface-overlay)',
        borderLeft: '1px solid var(--border-strong)',
        boxShadow: '-4px 0 24px rgba(0,0,0,0.4)',
      }}
      role="dialog"
      aria-label="Session detail"
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-3 shrink-0"
        style={{ borderBottom: '1px solid var(--border-subtle)' }}
      >
        <div className="text-[11px] uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          Session detail
        </div>
        <button
          onClick={onClose}
          className="text-lg leading-none transition-colors"
          style={{ color: 'var(--text-muted)' }}
          aria-label="Close"
        >
          {'×'}
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4">

        {/* Identity */}
        <section>
          <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>
            Identity
          </div>
          <div
            className="font-mono text-[11px] break-all rounded px-2 py-1.5"
            style={{ background: 'var(--surface-stage)', color: 'var(--text-secondary)' }}
          >
            {detail.sessionId}
          </div>
          {detail.configLabel && (
            <div className="mt-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
              {detail.configLabel}
            </div>
          )}
          {projectShort && (
            <div className="mt-0.5 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {projectShort}
            </div>
          )}
        </section>

        {/* Metadata */}
        <section>
          <div className="text-[10px] uppercase tracking-wider mb-1.5" style={{ color: 'var(--text-muted)' }}>
            Metadata
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
            <span style={{ color: 'var(--text-muted)' }}>Provider</span>
            <span className="capitalize" style={{ color: 'var(--text-secondary)' }}>{detail.provider}</span>
            <span style={{ color: 'var(--text-muted)' }}>First</span>
            <span style={{ color: 'var(--text-secondary)' }}>{formatTs(detail.firstTs)}</span>
            <span style={{ color: 'var(--text-muted)' }}>Last</span>
            <span style={{ color: 'var(--text-secondary)' }}>{formatTs(detail.lastTs)}</span>
          </div>
        </section>

        {/* Totals */}
        <section
          className="rounded-lg p-3"
          style={{ background: 'var(--surface-stage)', border: '1px solid var(--border-subtle)' }}
        >
          <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
            Totals
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
            <span style={{ color: 'var(--text-muted)' }}>Cost</span>
            <span className="font-mono" style={{ color: 'var(--color-peach)' }}>{formatCost(detail.costUsd)}</span>
            <span style={{ color: 'var(--text-muted)' }}>Input</span>
            <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>{formatTokensCompact(detail.inTok)}</span>
            <span style={{ color: 'var(--text-muted)' }}>Output</span>
            <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>{formatTokensCompact(detail.outTok)}</span>
            <span style={{ color: 'var(--text-muted)' }}>Cache read</span>
            <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>{formatTokensCompact(detail.cacheReadTok)}</span>
            <span style={{ color: 'var(--text-muted)' }}>Cache write</span>
            <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>{formatTokensCompact(detail.cacheCreateTok)}</span>
            <span style={{ color: 'var(--text-muted)' }}>Messages</span>
            <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>{detail.msgCount}</span>
          </div>
        </section>

        {/* Per-model breakdown */}
        {detail.byModel && detail.byModel.length > 0 && (
          <section>
            <div className="text-[10px] uppercase tracking-wider mb-2" style={{ color: 'var(--text-muted)' }}>
              Per-model breakdown
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    {['Model', 'Cost', 'In', 'Out', 'Cache', 'Msgs'].map((h) => (
                      <th
                        key={h}
                        className="text-left px-2 py-1 font-medium uppercase tracking-wider"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {detail.byModel.map((m, i) => {
                    const color = getModelColor(m.model)
                    return (
                      <tr
                        key={i}
                        className="border-b"
                        style={{ borderColor: 'var(--border-subtle)' }}
                      >
                        <td className="px-2 py-1.5">
                          <span
                            className="px-1.5 py-0.5 rounded text-[10px]"
                            style={{
                              backgroundColor: `color-mix(in srgb, ${color} 13%, transparent)`,
                              color,
                            }}
                          >
                            {getModelShort(m.model)}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 font-mono" style={{ color: 'var(--color-peach)' }}>
                          {formatCost(m.costUsd)}
                        </td>
                        <td className="px-2 py-1.5 font-mono" style={{ color: 'var(--text-secondary)' }}>
                          {formatTokensCompact(m.inTok)}
                        </td>
                        <td className="px-2 py-1.5 font-mono" style={{ color: 'var(--text-secondary)' }}>
                          {formatTokensCompact(m.outTok)}
                        </td>
                        <td className="px-2 py-1.5 font-mono" style={{ color: 'var(--text-muted)' }}>
                          {formatTokensCompact(m.cacheReadTok)}
                        </td>
                        <td className="px-2 py-1.5 font-mono" style={{ color: 'var(--text-muted)' }}>
                          {m.msgCount}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

export function SessionDetailDrawer() {
  const selected = useTokenomicsStore((s) => s.selected)
  const clearSelected = useTokenomicsStore((s) => s.clearSelected)

  if (!selected) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        style={{ background: 'rgba(0,0,0,0.35)' }}
        onClick={clearSelected}
        aria-hidden="true"
      />
      {/* Panel */}
      <DrawerContent detail={selected} onClose={clearSelected} />
    </>
  )
}
