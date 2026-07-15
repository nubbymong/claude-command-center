import React, { useMemo } from 'react'

interface Props {
  buckets: number[]
}

export default function MemoryActivityChart({ buckets }: Props) {
  const allZero = buckets.every((v) => v === 0)

  const svgData = useMemo(() => {
    if (allZero) return null
    const n = buckets.length
    const max = Math.max(...buckets)
    const points = buckets.map((v, i) => ({
      x: n === 1 ? 50 : (i / (n - 1)) * 100,
      y: 33 - (v / max) * 28,
      v,
    }))

    // Area path: line points + close at y=33
    const linePoints = points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
    const firstX = points[0].x.toFixed(2)
    const lastX = points[points.length - 1].x.toFixed(2)
    const areaD =
      points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ') +
      ` L ${lastX} 33 L ${firstX} 33 Z`

    return { points, linePoints, areaD }
  }, [buckets, allZero])

  return (
    <div className="rounded-xl p-4" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}>
      <div className="text-[11px] text-overlay0 uppercase tracking-wider mb-3">
        Activity &mdash; memories touched / week
      </div>

      {allZero ? (
        <div className="text-xs text-overlay0 py-8 text-center">No activity in the last 12 weeks</div>
      ) : (
        <>
          <svg
            viewBox="0 0 100 36"
            preserveAspectRatio="none"
            className="w-full h-28"
          >
            <defs>
              <linearGradient id="memActivityFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.22" />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
              </linearGradient>
            </defs>
            {/* Area fill */}
            <path d={svgData!.areaD} fill="url(#memActivityFill)" />
            {/* Line */}
            <polyline
              points={svgData!.linePoints}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {/* Dots for non-zero buckets */}
            {svgData!.points.map((p, i) =>
              p.v > 0 ? (
                <circle
                  key={i}
                  cx={p.x}
                  cy={p.y}
                  r="1.4"
                  fill="var(--accent)"
                  fillOpacity="0.85"
                />
              ) : null
            )}
          </svg>
          <div className="flex justify-between mt-1">
            <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>12w ago</span>
            <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>now</span>
          </div>
        </>
      )}
    </div>
  )
}
