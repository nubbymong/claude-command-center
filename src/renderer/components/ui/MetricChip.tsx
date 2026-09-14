import React from 'react'

export type MetricTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info'

const TONE_COLOR: Record<MetricTone, string> = {
  neutral: 'var(--text-primary)',
  success: 'var(--status-success)',
  warning: 'var(--status-warning)',
  danger: 'var(--status-danger)',
  info: 'var(--status-info)',
}

/**
 * A small label-over-value chip for dense metrics (Tokenomics summary cards,
 * Insights KPI sidebar, Cloud Agents usage cells). Value is JetBrains Mono so
 * tabular numerics align across rows. Tone tints only the value, never the
 * label, so the chip stays readable when scanned.
 */
export function MetricChip({
  label,
  value,
  tone = 'neutral',
  title,
}: {
  label: string
  value: React.ReactNode
  tone?: MetricTone
  title?: string
}) {
  return (
    <div
      title={title}
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        gap: 2,
        padding: '6px 10px',
        borderRadius: 8,
        background: 'var(--surface-raised)',
        border: '1px solid var(--border-subtle)',
        minWidth: 60,
      }}
    >
      <span
        style={{
          fontSize: 9.5,
          letterSpacing: '.10em',
          textTransform: 'uppercase',
          fontWeight: 600,
          color: 'var(--text-muted)',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontWeight: 500,
          fontSize: 14,
          color: TONE_COLOR[tone],
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
    </div>
  )
}
