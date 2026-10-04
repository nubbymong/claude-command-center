import React, { useLayoutEffect, useMemo, useState } from 'react'

interface Props {
  buckets: number[]
}

/** The width the chart is laid out at until it is measured (and where there
 *  is no layout to measure). */
const DEFAULT_W = 460
/** The drawing's height in pixels (the h-28 it has always had). */
const CHART_H = 112
/** Keeps the first and last dots inside the drawing rather than half cut off. */
const PAD_X = 3
const DOT_R = 2.5
/** The baseline and the busiest week's height, as fractions of the height
 *  (the 33 and 28 of the 36-unit drawing this replaced). */
const BASE_Y = CHART_H * (33 / 36)
const SPAN_Y = CHART_H * (28 / 36)

/**
 * Memories touched per week, as an area + line. Drawn at the width it is
 * given, one SVG unit to a pixel, as Tokenomics' cost chart is (PR 4 review
 * T-S1), so its dots stay round and its line one thickness: before, a
 * 100-unit drawing was stretched over the whole card.
 */
export default function MemoryActivityChart({ buckets }: Props) {
  const allZero = buckets.every((v) => v === 0)

  // The width the chart is drawn at: measured, and re-measured on resize.
  const [frame, setFrame] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(DEFAULT_W)
  useLayoutEffect(() => {
    if (!frame) return
    const measure = () => {
      const w = frame.clientWidth
      if (w > 0) setWidth(w)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(frame)
    return () => ro.disconnect()
  }, [frame])

  const svgData = useMemo(() => {
    if (allZero) return null
    const n = buckets.length
    const max = Math.max(...buckets)
    const points = buckets.map((v, i) => ({
      x: n === 1 ? width / 2 : PAD_X + (i / (n - 1)) * (width - 2 * PAD_X),
      y: BASE_Y - (v / max) * SPAN_Y,
      v,
    }))

    // Area path: line points + close at the baseline
    const linePoints = points.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
    const firstX = points[0].x.toFixed(2)
    const lastX = points[points.length - 1].x.toFixed(2)
    const baseY = BASE_Y.toFixed(2)
    const areaD =
      points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(' ') +
      ` L ${lastX} ${baseY} L ${firstX} ${baseY} Z`

    return { points, linePoints, areaD }
  }, [buckets, allZero, width])

  return (
    <div className="rounded-xl p-4" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}>
      <div className="text-[11px] text-overlay0 uppercase tracking-wider mb-3">
        Activity &mdash; memories touched / week
      </div>

      {allZero ? (
        <div className="text-xs text-overlay0 py-8 text-center">No activity in the last 12 weeks</div>
      ) : (
        <>
          <div ref={setFrame}>
            <svg
              width="100%"
              height={CHART_H}
              viewBox={`0 0 ${width} ${CHART_H}`}
              style={{ display: 'block' }}
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
                    r={DOT_R}
                    fill="var(--accent)"
                    fillOpacity="0.85"
                  />
                ) : null
              )}
            </svg>
          </div>
          <div className="flex justify-between mt-1">
            <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>12w ago</span>
            <span className="text-[9px]" style={{ color: 'var(--text-muted)' }}>now</span>
          </div>
        </>
      )}
    </div>
  )
}
