import React, { useMemo } from 'react'
import { TYPE_COLORS } from './memory-ui'

interface Props {
  types: Array<{ type: string; count: number }>
}

export default function MemoryTypeDonut({ types }: Props) {
  const r = 44
  const cx = 52
  const cy = 52
  const C = 2 * Math.PI * r

  const total = useMemo(() => types.reduce((a, t) => a + t.count, 0), [types])

  const segments = useMemo(() => {
    if (total === 0) return []
    let offset = 0
    return types.map((t) => {
      const frac = t.count / total
      const dasharray = `${(frac * C).toFixed(4)} ${C.toFixed(4)}`
      const dashoffset = -offset
      offset += frac * C
      return { ...t, dasharray, dashoffset }
    })
  }, [types, total, C])

  return (
    <div className="rounded-xl p-4" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}>
      <div className="text-[11px] text-overlay0 uppercase tracking-wider mb-3">
        By type
      </div>

      {types.length === 0 ? (
        <div className="text-xs text-overlay0 py-8 text-center">No memories</div>
      ) : (
        <div className="flex items-center gap-4">
          {/* Donut SVG */}
          <svg width={104} height={104} viewBox="0 0 104 104" className="shrink-0">
            {segments.map((seg) => (
              <circle
                key={seg.type}
                cx={cx}
                cy={cy}
                r={r}
                fill="none"
                stroke={TYPE_COLORS[seg.type]?.fg ?? 'var(--text-muted)'}
                strokeWidth="12"
                strokeDasharray={seg.dasharray}
                strokeDashoffset={seg.dashoffset}
                transform="rotate(-90 52 52)"
              />
            ))}
            {/* Centre: total count */}
            <text
              x="52"
              y="50"
              textAnchor="middle"
              fontSize="16"
              fill="var(--text-primary)"
              fontFamily="monospace"
              fontWeight="700"
            >
              {total}
            </text>
            <text
              x="52"
              y="61"
              textAnchor="middle"
              fontSize="7"
              fill="var(--text-muted)"
            >
              memories
            </text>
          </svg>

          {/* Legend */}
          <div className="flex flex-col gap-1">
            {types.map((t) => (
              <div key={t.type} className="flex items-center gap-1.5 text-[11px]">
                <div
                  className="rounded-sm shrink-0"
                  style={{ width: 8, height: 8, background: TYPE_COLORS[t.type]?.fg ?? 'var(--text-muted)' }}
                />
                <span style={{ color: 'var(--text-secondary)' }}>
                  {TYPE_COLORS[t.type]?.label ?? t.type}
                </span>
                <span className="font-mono text-overlay0">{t.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
