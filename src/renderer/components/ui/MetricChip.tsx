import React from 'react'
export function MetricChip({ label, value, tone }: { label?: string; value: React.ReactNode; tone?: string }) {
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:5, fontSize:11, padding:'3px 9px',
      borderRadius:8, color:'var(--text-secondary)', background:'var(--surface-panel)',
      boxShadow:'inset 0 0 0 1px color-mix(in srgb, var(--text-muted) 25%, transparent)' }}>
      {label && <span>{label}</span>}
      <span style={{ fontFamily:"'JetBrains Mono', monospace", fontWeight:450, color: tone || 'var(--text-primary)' }}>{value}</span>
    </span>
  )
}
