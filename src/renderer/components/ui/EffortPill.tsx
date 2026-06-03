import React from 'react'
import type { EffortLevel } from '../../stores/sessionStore'

// Effort indicator for session cards. Tinted text pill (mirrors StatusPill's
// grammar) coloured by the per-level --effort-<level> ramp token (theme-aware,
// defined in styles.css). Text + tooltip carry the meaning, so it is not
// colour-only. Returns null for an unknown level (defensive).
const LEVELS = new Set<EffortLevel>(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'])

export function EffortPill({ level }: { level: EffortLevel }) {
  if (!LEVELS.has(level)) return null
  const token = `var(--effort-${level})`
  return (
    <span
      data-testid="effort-pill"
      title={`Effort: ${level}`}
      className="text-[9px] font-medium uppercase tracking-wide px-1.5 py-px rounded-full shrink-0 leading-none transition-colors duration-150"
      style={{ color: token, background: `color-mix(in srgb, ${token} 18%, transparent)` }}
    >
      {level}
    </span>
  )
}
