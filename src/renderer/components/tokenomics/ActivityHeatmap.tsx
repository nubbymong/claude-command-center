import React, { useMemo } from 'react'
import type { TkSummary } from '../../../shared/types'

interface Props {
  data: TkSummary['heatmap']
}

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const HOUR_LABEL_AT = [0, 6, 12, 18]

function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function ActivityHeatmap({ data }: Props) {
  // Build a full 168-cell array from the sparse data
  const cells = useMemo(() => {
    const grid = new Array<number>(168).fill(0)
    if (data) {
      for (const { bucket, tokens } of data) {
        if (bucket >= 0 && bucket < 168) {
          grid[bucket] = tokens
        }
      }
    }
    return grid
  }, [data])

  const maxTokens = useMemo(() => Math.max(...cells, 1), [cells])

  // Compute intensity: 0..1
  const intensity = (tokens: number) => tokens / maxTokens

  // Accent colour ramp via opacity on --accent
  const cellStyle = (tokens: number): React.CSSProperties => {
    const alpha = intensity(tokens)
    if (alpha === 0) {
      return {
        background: 'var(--surface-stage)',
        border: '1px solid var(--border-subtle)',
      }
    }
    // Use color-mix to blend accent with surface-stage by alpha
    const pct = Math.round(alpha * 100)
    return {
      background: `color-mix(in srgb, var(--accent) ${pct}%, var(--surface-stage))`,
      border: '1px solid var(--border-subtle)',
    }
  }

  const CELL_SIZE = 14
  const CELL_GAP = 2
  const ROW_LABEL_W = 32

  return (
    <div
      className="rounded-xl p-4 mb-5"
      style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="text-[11px] text-overlay0 uppercase tracking-wider mb-3">
        Activity heatmap (tokens by day &amp; hour)
      </div>

      <div className="overflow-x-auto">
        {/* Hour axis labels */}
        <div
          className="flex mb-1"
          style={{ paddingLeft: ROW_LABEL_W }}
        >
          {Array.from({ length: 24 }, (_, h) => (
            <div
              key={h}
              style={{
                width: CELL_SIZE,
                marginRight: CELL_GAP,
                flexShrink: 0,
                fontSize: 9,
                color: 'var(--text-muted)',
                textAlign: 'center',
              }}
            >
              {HOUR_LABEL_AT.includes(h) ? h : ''}
            </div>
          ))}
        </div>

        {/* Rows: Sun..Sat (dow 0..6) */}
        {DAY_LABELS.map((dayLabel, dow) => (
          <div key={dow} className="flex items-center mb-0.5">
            {/* Row label */}
            <div
              style={{
                width: ROW_LABEL_W,
                fontSize: 10,
                color: 'var(--text-muted)',
                flexShrink: 0,
              }}
            >
              {dayLabel}
            </div>
            {/* 24 hour cells */}
            {Array.from({ length: 24 }, (_, hour) => {
              const bucket = dow * 24 + hour
              const tokens = cells[bucket] ?? 0
              const tooltip = `${dayLabel} ${hour}:00 — ${formatTokensCompact(tokens)} tokens`
              return (
                <div
                  key={hour}
                  title={tooltip}
                  style={{
                    width: CELL_SIZE,
                    height: CELL_SIZE,
                    borderRadius: 3,
                    marginRight: CELL_GAP,
                    flexShrink: 0,
                    ...cellStyle(tokens),
                  }}
                />
              )
            })}
          </div>
        ))}

        {/* Legend */}
        <div className="flex items-center gap-1 mt-2" style={{ paddingLeft: ROW_LABEL_W }}>
          <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>Less</span>
          {[0, 0.25, 0.5, 0.75, 1].map((alpha) => {
            const pct = Math.round(alpha * 100)
            return (
              <div
                key={alpha}
                style={{
                  width: CELL_SIZE,
                  height: CELL_SIZE,
                  borderRadius: 3,
                  flexShrink: 0,
                  background: alpha === 0
                    ? 'var(--surface-stage)'
                    : `color-mix(in srgb, var(--accent) ${pct}%, var(--surface-stage))`,
                  border: '1px solid var(--border-subtle)',
                }}
              />
            )
          })}
          <span style={{ fontSize: 9, color: 'var(--text-muted)' }}>More</span>
        </div>
      </div>
    </div>
  )
}
