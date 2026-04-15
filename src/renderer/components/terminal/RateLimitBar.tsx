import React from 'react'
import { formatResetTime } from '../../utils/terminalFormatting'

export default function RateLimitBar({ label, pct, resets }: { label: string; pct: number; resets?: string }) {
  const barWidth = 10
  const filled = Math.round(pct * barWidth / 100)
  const color = pct >= 90 ? '#F38BA8' : pct >= 70 ? '#F9E2AF' : pct >= 50 ? '#FAB387' : '#A6E3A1'
  return (
    <span className="flex items-center gap-1" title={resets ? `Resets: ${formatResetTime(resets)}` : undefined}>
      <span className="text-subtext0">{label}:</span>
      <span style={{ letterSpacing: '-1px' }}>
        {Array.from({ length: barWidth }, (_, i) => (
          <span key={i} style={{ color: i < filled ? color : '#2a3342', fontSize: '9px' }}>{String.fromCodePoint(0x25CF)}</span>
        ))}
      </span>
      <span className="text-subtext0">{pct}%</span>
    </span>
  )
}
