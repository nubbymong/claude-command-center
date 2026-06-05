import React, { useState, useEffect, useRef } from 'react'
import type { ConfigGroup, GroupedSession } from '../lib/groupSessions'

function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + 'B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB'
  return (bytes / (1024 * 1024)).toFixed(1) + 'MB'
}

interface Props {
  groups: ConfigGroup[]
  orphaned: GroupedSession[]
  selectedId: string | null
  onSelect: (s: GroupedSession) => void
  onDeleteGroup: (group: ConfigGroup) => void
  onDeleteOrphaned: () => void
  nameForAccount: (email: string | null) => string | null
  accounts: { email: string; name: string }[]
  accountFilter: string
  onAccountFilter: (v: string) => void
}

export default function LogTree({
  groups, orphaned, selectedId, onSelect, onDeleteGroup, onDeleteOrphaned,
  nameForAccount, accounts, accountFilter, onAccountFilter,
}: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const initedRef = useRef(false)
  useEffect(() => {
    if (!initedRef.current && groups.length > 0) {
      initedRef.current = true
      setExpanded(new Set([...groups.map((g) => g.configId), '__orphaned__']))
    }
  }, [groups])
  const toggle = (k: string) =>
    setExpanded((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n })

  const sessionRow = (s: GroupedSession) => {
    const active = selectedId === s.sessionId
    return (
      <button
        key={s.sessionId}
        onClick={() => onSelect(s)}
        className={`w-full text-left rounded-md px-2.5 py-2 transition-all ${active ? 'bg-surface0/70 border-l-2 border-l-mauve' : 'hover:bg-surface0/30 border-l-2 border-l-transparent'}`}
      >
        <div className="flex items-center gap-1.5">
          <span className="text-[11px] text-text truncate font-medium">{s.configLabel}</span>
          {s.legacy && <span className="text-[9px] uppercase tracking-wide text-overlay0 bg-surface0/70 rounded px-1 shrink-0">legacy</span>}
        </div>
        {nameForAccount(s.accountEmail) && (
          <div className="text-[10px] text-overlay1 truncate mt-0.5" title={s.accountEmail ?? undefined}>{nameForAccount(s.accountEmail)}</div>
        )}
        <div className="flex items-center gap-1.5 mt-0.5 text-[10px] text-overlay0">
          <span>{new Date(s.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          <span className="text-overlay0/30">{String.fromCodePoint(0x00B7)}</span>
          <span>{formatSize(s.byteSize)}</span>
          <span className="text-overlay0/30">{String.fromCodePoint(0x00B7)}</span>
          <span className="font-mono">{s.sessionId.slice(0, 6)}</span>
        </div>
      </button>
    )
  }

  const groupHeader = (key: string, label: string, count: number, onDelete: () => void) => (
    <div className="w-full flex items-center gap-1.5 px-3 py-1.5">
      <button onClick={() => toggle(key)} className="flex items-center gap-1.5 flex-1 min-w-0 text-[10px] font-semibold text-overlay0 uppercase tracking-wider hover:text-overlay1 transition-colors">
        <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" className={`transition-transform shrink-0 ${expanded.has(key) ? 'rotate-90' : ''}`}><polygon points="2,0 7,4 2,8" /></svg>
        <span className="truncate">{label}</span>
        <span className="ml-auto text-overlay0/50 shrink-0">{count}</span>
      </button>
      <button onClick={onDelete} title="Delete this group's logs (permanent)" className="text-overlay0 hover:text-red transition-colors shrink-0">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"><path d="M3 4h10M6 4V3h4v1M5 4l.5 9h5L11 4" /></svg>
      </button>
    </div>
  )

  return (
    <div className="w-56 bg-mantle/30 border-r border-surface0/60 flex flex-col overflow-hidden shrink-0">
      {accounts.length > 1 && (
        <div className="p-2 border-b border-surface0/40">
          <select value={accountFilter} onChange={(e) => onAccountFilter(e.target.value)} className="w-full bg-surface0/30 rounded-md px-2 py-1.5 text-[11px] text-text outline-none border border-transparent focus:border-surface1 transition-colors" title="Filter by account">
            <option value="all">All accounts</option>
            {accounts.map((a) => <option key={a.email} value={a.email}>{a.name}</option>)}
          </select>
        </div>
      )}
      <div className="flex-1 overflow-y-auto py-1">
        {groups.map((g) => (
          <div key={g.configId}>
            {groupHeader(g.configId, g.configLabel, g.sessions.length, () => onDeleteGroup(g))}
            {expanded.has(g.configId) && <div className="space-y-0.5 px-1.5 mb-1">{g.sessions.map(sessionRow)}</div>}
          </div>
        ))}
        {orphaned.length > 0 && (
          <div>
            {groupHeader('__orphaned__', 'Orphaned', orphaned.length, onDeleteOrphaned)}
            {expanded.has('__orphaned__') && <div className="space-y-0.5 px-1.5 mb-1">{orphaned.map(sessionRow)}</div>}
          </div>
        )}
        {groups.length === 0 && orphaned.length === 0 && (
          <div className="px-4 py-10 text-center">
            <p className="text-[11px] text-overlay0">No session logs yet</p>
            <p className="text-[10px] text-overlay0/60 mt-1">Logs appear after running sessions</p>
          </div>
        )}
      </div>
    </div>
  )
}
