import React from 'react'
import type { SessionState } from './StatusDot'

// Health pill -- secondary to the name. Only emitted for states that carry a
// meaningful health signal; idle/background stay quiet (no pill) so the row
// reads calm. Colour is a status token; never an identity hue (spec section 6).
// `base`: a surface the wash is mixed over instead of whatever is beneath. The
// awaiting pill has the card's identity-colour pulse beneath it, and a tint of
// any identity colour takes the warning colour on its own wash below 4.5:1 in
// the light theme, so it is mixed over the panel the sidebar sits on and its
// contrast does not depend on the pulse (token-contrast.test.ts).
const PILL: Partial<Record<SessionState, { label: string; color: string; base?: string }>> = {
  running:    { label: 'running',    color: 'var(--status-success)' },
  awaiting:   { label: 'attention',  color: 'var(--status-warning)', base: 'var(--surface-panel)' },
  error:      { label: 'stopped',    color: 'var(--status-danger)' },
  compacting: { label: 'compacting', color: 'var(--status-info)' },
}

export function StatusPill({ state }: { state: SessionState }) {
  const p = PILL[state]
  if (!p) return null
  return (
    <span
      className="text-[9px] font-medium uppercase tracking-wide px-1.5 py-px rounded-full shrink-0 leading-none"
      style={{ color: p.color, background: `color-mix(in srgb, ${p.color} 15%, ${p.base ?? 'transparent'})` }}
    >
      {p.label}
    </span>
  )
}
