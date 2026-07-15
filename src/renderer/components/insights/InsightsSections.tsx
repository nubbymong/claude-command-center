// src/renderer/components/insights/InsightsSections.tsx
import React from 'react'
import type { InsightsSection } from './parseInsightsReport'
import { SectionLabel } from '../ui/SectionLabel'

const CARD: React.CSSProperties = {
  background: 'var(--surface-raised)',
  border: '1px solid var(--border-subtle)',
  borderRadius: 12,
  padding: 16,
  marginBottom: 12,
}

function AtAGlance({ s }: { s: Extract<InsightsSection, { kind: 'at-a-glance' }> }) {
  return (
    <div style={{ ...CARD, borderColor: 'color-mix(in srgb, var(--status-warning) 35%, var(--border-subtle))' }}>
      <SectionLabel>{s.title || 'At a glance'}</SectionLabel>
      <div style={{ color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>{s.body}</div>
    </div>
  )
}

function Narrative({ s }: { s: Extract<InsightsSection, { kind: 'narrative' }> }) {
  return (
    <div style={CARD}>
      <SectionLabel>{s.title || 'Narrative'}</SectionLabel>
      {s.paragraphs.map((p, i) => (
        <p key={i} style={{ color: 'var(--text-secondary)', marginBottom: 8 }}>{p}</p>
      ))}
    </div>
  )
}

function BigWins({ s }: { s: Extract<InsightsSection, { kind: 'big-wins' }> }) {
  return (
    <div style={CARD}>
      <SectionLabel>Big wins</SectionLabel>
      {s.items.map((it, i) => (
        <div key={i} style={{ borderLeft: '2px solid var(--status-success)', paddingLeft: 10, marginBottom: 10 }}>
          <div style={{ color: 'var(--status-success)', fontWeight: 600 }}>{it.title}</div>
          <div style={{ color: 'var(--text-secondary)' }}>{it.desc}</div>
        </div>
      ))}
    </div>
  )
}

function Friction({ s }: { s: Extract<InsightsSection, { kind: 'friction' }> }) {
  return (
    <div style={CARD}>
      <SectionLabel>Friction</SectionLabel>
      {s.items.map((it, i) => (
        <div key={i} style={{ borderLeft: '2px solid var(--status-danger)', paddingLeft: 10, marginBottom: 10 }}>
          <div style={{ color: 'var(--status-danger)', fontWeight: 600 }}>{it.title}</div>
          <div style={{ color: 'var(--text-secondary)' }}>{it.desc}</div>
        </div>
      ))}
    </div>
  )
}

function Features({ s }: { s: Extract<InsightsSection, { kind: 'features' }> }) {
  return (
    <div style={CARD}>
      <SectionLabel>Features</SectionLabel>
      {s.items.map((it, i) => (
        <div key={i} style={{ marginBottom: 12 }}>
          <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{it.title}</div>
          <div style={{ color: 'var(--text-secondary)' }}>{it.oneliner}</div>
          <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>{it.why}</div>
        </div>
      ))}
    </div>
  )
}

function Patterns({ s }: { s: Extract<InsightsSection, { kind: 'patterns' }> }) {
  return (
    <div style={CARD}>
      <SectionLabel>Patterns</SectionLabel>
      {s.items.map((it, i) => (
        <div key={i} style={{ marginBottom: 12 }}>
          <div style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{it.title}</div>
          <div style={{ color: 'var(--text-secondary)' }}>{it.summary}</div>
          <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>{it.detail}</div>
        </div>
      ))}
    </div>
  )
}

function Horizon({ s }: { s: Extract<InsightsSection, { kind: 'horizon' }> }) {
  return (
    <div style={{ ...CARD, borderColor: 'color-mix(in srgb, var(--chart-other) 40%, var(--border-subtle))' }}>
      <SectionLabel>{s.title || 'Horizon'}</SectionLabel>
      <div style={{ color: 'var(--text-primary)' }}>{s.body}</div>
    </div>
  )
}

export function InsightsSections({ sections }: { sections: InsightsSection[] }) {
  return (
    <div style={{ padding: 16 }}>
      {sections.map((s, i) => {
        switch (s.kind) {
          case 'at-a-glance': return <AtAGlance key={i} s={s} />
          case 'narrative':   return <Narrative   key={i} s={s} />
          case 'big-wins':    return <BigWins     key={i} s={s} />
          case 'friction':    return <Friction    key={i} s={s} />
          case 'features':    return <Features    key={i} s={s} />
          case 'patterns':    return <Patterns    key={i} s={s} />
          case 'horizon':     return <Horizon     key={i} s={s} />
          default: return null
        }
      })}
    </div>
  )
}
