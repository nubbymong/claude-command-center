import React from 'react'
export type SessionState = 'running'|'idle'|'awaiting'|'compacting'|'error'|'background'|'blocked'|'permission-pending'|'success'
const COLOR: Record<SessionState,string> = {
  running:'var(--status-success)', idle:'var(--text-muted)', awaiting:'var(--status-warning)',
  compacting:'var(--status-info)', error:'var(--status-danger)', background:'var(--text-muted)', blocked:'var(--status-danger)',
  'permission-pending':'var(--status-warning)', success:'var(--status-success)',
}
export function StatusDot({ state, title }: { state: SessionState; title?: string }) {
  // Decorative by default (status is also conveyed by adjacent text/row state);
  // pass `title` at a call site where the dot alone carries meaning.
  return (
    <span
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      title={title}
      style={{ width:7, height:7, borderRadius:'50%', background:COLOR[state], flex:'none', display:'inline-block' }}
    />
  )
}
