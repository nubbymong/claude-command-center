import React from 'react'
import { formatResetTime } from '../../utils/terminalFormatting'

// Slim contiguous bar instead of a row of dots. Easier to scan in
// peripheral vision and uses less horizontal space — UX audit 2026-04-25
// flagged the dot row as the hardest-to-parse element on the status line.
export default function RateLimitBar({ label, pct, resets }: { label: string; pct: number; resets?: string }) {
  const clamped = Math.min(100, Math.max(0, pct))
  const color = clamped >= 90 ? '#F38BA8' : clamped >= 70 ? '#F9E2AF' : clamped >= 50 ? '#FAB387' : '#A6E3A1'
  return (
    <span
      className="flex items-center gap-1.5"
      title={resets ? `${label} window — resets ${formatResetTime(resets)}` : `${label} window`}
    >
      <span className="text-subtext0">{label}:</span>
      <span
        className="inline-block bg-surface1 rounded-sm overflow-hidden"
        style={{ width: '64px', height: '6px' }}
        role="progressbar"
        aria-valuenow={clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${label} rate limit utilisation`}
      >
        <span
          className="block h-full rounded-sm transition-[width] duration-300 ease-out"
          style={{ width: `${clamped}%`, backgroundColor: color }}
        />
      </span>
      <span className="text-subtext0 tabular-nums">{Math.round(clamped)}%</span>
    </span>
  )
}
