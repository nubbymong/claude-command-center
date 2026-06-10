import React from 'react'
import type { TkSummary } from '../../../shared/types'
import { useTokenomicsStore } from '../../stores/tokenomicsStore'

interface Props {
  data: TkSummary['costByConfig']
}

function formatCostShort(usd: number): string {
  if (usd >= 1000) return `$${(usd / 1000).toFixed(1)}k`
  if (usd >= 100) return `$${usd.toFixed(0)}`
  if (usd >= 10) return `$${usd.toFixed(1)}`
  return `$${usd.toFixed(2)}`
}

export function CostByConfig({ data }: Props) {
  const setConfig = useTokenomicsStore((s) => s.setConfig)
  const activeConfigId = useTokenomicsStore((s) => s.filter.configId)

  if (!data || data.length === 0) {
    return (
      <div
        className="rounded-xl p-4 mb-5"
        style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
      >
        <div className="text-[11px] text-overlay0 uppercase tracking-wider mb-2">
          Cost by config
        </div>
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>No config data</div>
      </div>
    )
  }

  const maxCost = Math.max(...data.map((d) => d.costUsd), 0.001)

  return (
    <div
      className="rounded-xl p-4 mb-5"
      style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="text-[11px] text-overlay0 uppercase tracking-wider mb-3">
        Cost by config
      </div>
      <div className="space-y-2.5">
        {data.map((entry) => {
          const isExternal = entry.configId === null
          const barPct = maxCost > 0 ? (entry.costUsd / maxCost) * 100 : 0
          // Determine active state: undefined = all configs selected (no filter)
          const isActive =
            activeConfigId === undefined
              ? false
              : activeConfigId === entry.configId

          return (
            <div
              key={entry.configId ?? '__null__'}
              className="cursor-pointer group"
              onClick={() =>
                // Clicking again when already active = clear the filter
                isActive
                  ? setConfig(undefined)
                  : setConfig(entry.configId)
              }
            >
              <div className="flex items-baseline justify-between mb-1">
                <span
                  className="text-xs font-medium truncate max-w-[60%]"
                  style={{
                    color: isActive
                      ? 'var(--accent)'
                      : isExternal
                      ? 'var(--text-muted)'
                      : 'var(--text-primary)',
                  }}
                  title={entry.label}
                >
                  {entry.label}
                </span>
                <span
                  className="text-[11px] font-mono shrink-0 ml-2"
                  style={{ color: isExternal ? 'var(--text-muted)' : 'var(--text-secondary)' }}
                >
                  {formatCostShort(entry.costUsd)}
                  <span
                    className="ml-1.5"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {entry.sessions} session{entry.sessions === 1 ? '' : 's'}
                  </span>
                </span>
              </div>
              <div
                className="h-2 rounded-full overflow-hidden"
                style={{ background: 'var(--surface-stage)' }}
              >
                <div
                  className="h-full rounded-full transition-all duration-200"
                  style={{
                    width: `${Math.max(barPct, 1)}%`,
                    background: isActive
                      ? 'var(--accent)'
                      : isExternal
                      ? 'var(--text-muted)'
                      : 'var(--chart-other)',
                    opacity: isActive ? 1 : 0.72,
                  }}
                />
              </div>
            </div>
          )
        })}
      </div>
      {activeConfigId !== undefined && (
        <button
          className="mt-3 text-[11px] transition-colors"
          style={{ color: 'var(--accent)' }}
          onClick={() => setConfig(undefined)}
        >
          Clear config filter
        </button>
      )}
    </div>
  )
}
