import React from 'react'
import type { MemoryKpis, IndexHealth } from './memory-stats'
import { fmt } from './memory-ui'

function Card({ label, value, valueClass, valueStyle, sub }: {
  label: string; value: React.ReactNode; valueClass?: string; valueStyle?: React.CSSProperties; sub?: React.ReactNode
}) {
  return (
    <div className="rounded-xl p-4" style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}>
      <div className="text-[11px] text-overlay0 uppercase tracking-wider mb-1.5">{label}</div>
      <div className={`text-2xl font-mono font-bold ${valueClass ?? ''}`} style={valueStyle}>{value}</div>
      {sub && <div className="text-[10px] mt-1" style={{ color: 'var(--text-muted)' }}>{sub}</div>}
    </div>
  )
}

export default function MemoryKpiRow({ kpis, health }: { kpis: MemoryKpis; health: IndexHealth }) {
  const healthSub = health.overLimit > 0
    ? `${health.overLimit} over 200 lines`
    : health.missing > 0 ? `${health.missing} missing index` : 'all indexes healthy'
  return (
    <div className="grid grid-cols-5 gap-3 mb-5">
      <Card label="Memories" value={kpis.total} valueStyle={{ color: 'var(--accent)' }}
        sub={`+${kpis.touchedThisWeek} touched this week`} />
      <Card label="Projects" value={kpis.projects} valueClass="text-blue" />
      <Card label="Total size" value={fmt(kpis.totalSize)} valueClass="text-text" />
      <Card label="Stale >30d" value={kpis.staleCount}
        valueStyle={{ color: kpis.staleCount > 0 ? 'var(--status-warning)' : 'var(--status-success)' }}
        sub={`${kpis.stalePct}% of corpus`} />
      <Card label="Index health" value={`${health.healthy}/${health.total}`}
        valueStyle={{ color: health.healthy === health.total ? 'var(--status-success)' : 'var(--status-warning)' }}
        sub={healthSub} />
    </div>
  )
}
