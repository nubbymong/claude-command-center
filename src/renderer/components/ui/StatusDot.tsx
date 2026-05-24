import React from 'react'
export type SessionState = 'running'|'idle'|'awaiting'|'compacting'|'error'|'background'|'blocked'
const COLOR: Record<SessionState,string> = {
  running:'var(--status-success)', idle:'var(--text-muted)', awaiting:'var(--status-warning)',
  compacting:'var(--status-info)', error:'var(--status-danger)', background:'var(--chart-other)', blocked:'var(--status-danger)',
}
export function StatusDot({ state, title }: { state: SessionState; title?: string }) {
  // Decorative by default (status is also conveyed by adjacent text/row state);
  // pass `title` at a call site where the dot alone carries meaning.
  const a11y = title ? { role: 'img', 'aria-label': title, title } : { 'aria-hidden': true }
  return <span {...a11y} style={{ width:7, height:7, borderRadius:'50%', background:COLOR[state], flex:'none', display:'inline-block' }} />
}
