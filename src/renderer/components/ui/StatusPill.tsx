import React from 'react'
import type { SessionState } from './StatusDot'

// Health pill -- secondary to the name. Only emitted for states that carry a
// meaningful health signal; idle/background stay quiet (no pill) so the row
// reads calm. Colour is a status token; never an identity hue (spec section 6).
const PILL: Partial<Record<SessionState, { label: string; color: string }>> = {
  running:    { label: 'running',    color: 'var(--status-success)' },
  awaiting:   { label: 'attention',  color: 'var(--status-warning)' },
  error:      { label: 'stopped',    color: 'var(--status-danger)' },
  compacting: { label: 'compacting', color: 'var(--status-info)' },
}

export function StatusPill({ state }: { state: SessionState }) {
  const p = PILL[state]
  if (!p) return null
  return (
    <span
      className="text-[9px] font-medium uppercase tracking-wide px-1.5 py-px rounded-full shrink-0 leading-none"
      style={{ color: p.color, background: `color-mix(in srgb, ${p.color} 15%, transparent)` }}
    >
      {p.label}
    </span>
  )
}
