import React, { useMemo } from 'react'
import type { MemoryFile, MemoryProject } from '../../../shared/types'
import { TypeBadge, fmt, fmtRel, staleClass, staleShadow, TYPE_ORDER, TYPE_COLORS } from './memory-ui'

interface Props {
  projectDir: string
  project: MemoryProject | undefined
  memories: MemoryFile[]
  typeFilter: string | null
  sortBy: 'modified' | 'size' | 'name'
  sortDir: 'asc' | 'desc'
  recentSessions: Array<{ sessionId: string; lastActive: number }>
  liveSessions: Array<{ id: string; label: string }>
  selectedMemoryId: string | null
  onBack: () => void
  onSelectMemory: (id: string) => void
  onSetTypeFilter: (t: string | null) => void
  onSetSort: (k: 'modified' | 'size' | 'name') => void
  onJumpToSession: (sessionId: string) => void
  onOpenSessionLogs: (sessionId: string) => void
}

// Two-letter abbreviation per type
const TYPE_ABBR: Record<string, string> = {
  user:          'US',
  feedback:      'FB',
  project:       'PR',
  reference:     'RF',
  snapshot:      'SS',
  uncategorized: 'UN',
}

export default function ProjectDrilldown({
  projectDir,
  project,
  memories,
  typeFilter,
  sortBy,
  sortDir,
  recentSessions,
  liveSessions,
  selectedMemoryId,
  onBack,
  onSelectMemory,
  onSetTypeFilter,
  onSetSort,
  onJumpToSession,
  onOpenSessionLogs,
}: Props) {
  const totalSize = memories.reduce((s, m) => s + m.size, 0)

  // Types actually present in this project's memories, in TYPE_ORDER order
  const presentTypes = useMemo(() => {
    const seen: Set<string> = new Set(memories.map(m => m.type))
    return TYPE_ORDER.filter(t => seen.has(t))
  }, [memories])

  // Filtered + sorted memories
  const displayedMemories = useMemo(() => {
    const filtered = typeFilter ? memories.filter(m => m.type === typeFilter) : memories
    const dir = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => {
      if (sortBy === 'modified') return dir * (a.modified - b.modified)
      if (sortBy === 'size') return dir * (a.size - b.size)
      return dir * a.name.localeCompare(b.name)
    })
  }, [memories, typeFilter, sortBy, sortDir])

  const indexLines = project?.memoryMdLines

  return (
    <div>
      {/* Header row */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        {/* Back button — exact style from MemoryPage:153-156 minus mb-4 */}
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 font-mono text-[11px] text-blue bg-transparent border-none cursor-pointer hover:opacity-80"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
          All Projects
        </button>

        {/* Project name */}
        <span className="text-sm font-medium text-text">{project?.name ?? projectDir}</span>

        {/* Inline stats */}
        <span className="font-mono text-[11px] text-overlay0">
          {memories.length} memories · {fmt(totalSize)} ·{' '}
          {indexLines == null ? (
            <span style={{ color: 'var(--text-muted)' }}>no index</span>
          ) : (
            <span style={{ color: indexLines > 200 ? 'var(--status-warning)' : 'var(--status-success)' }}>
              index {indexLines} lines
            </span>
          )}
        </span>

        <div className="flex-1" />

        {/* Type segmented control — FilterBar idiom */}
        <div
          className="flex rounded overflow-hidden"
          style={{ border: '1px solid var(--border-subtle)' }}
        >
          {/* "All" segment */}
          <button
            onClick={() => onSetTypeFilter(null)}
            className="px-2.5 py-0.5 text-xs transition-colors"
            style={{
              background: typeFilter === null ? 'var(--accent)' : 'var(--surface-stage)',
              color: typeFilter === null ? 'var(--surface-base)' : 'var(--text-secondary)',
              fontWeight: typeFilter === null ? 600 : 400,
            }}
          >
            All
          </button>

          {presentTypes.map(t => {
            const active = typeFilter === t
            return (
              <button
                key={t}
                onClick={() => onSetTypeFilter(t)}
                title={TYPE_COLORS[t]?.label ?? t}
                className="px-2.5 py-0.5 text-xs transition-colors"
                style={{
                  background: active ? 'var(--accent)' : 'var(--surface-stage)',
                  color: active ? 'var(--surface-base)' : 'var(--text-secondary)',
                  fontWeight: active ? 600 : 400,
                }}
              >
                {TYPE_ABBR[t] ?? t.slice(0, 2).toUpperCase()}
              </button>
            )
          })}
        </div>
      </div>

      {/* Body */}
      <div className="flex gap-3 items-start">
        {/* LEFT — memory table panel */}
        <div
          className="flex-[3] rounded-xl p-4"
          style={{
            background: 'var(--surface-raised)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          <div className="text-[11px] text-overlay0 uppercase tracking-wider mb-3">Memories</div>

          {/* Column headers */}
          <div
            className="grid items-center gap-2.5 px-3 pb-1.5 border-b mb-1"
            style={{
              gridTemplateColumns: 'auto minmax(0,1.2fr) minmax(0,2fr) auto auto',
              borderColor: 'var(--border-subtle)',
            }}
          >
            {/* Badge column spacer */}
            <div />

            {/* Name — sortable */}
            <button
              className="text-[10px] uppercase tracking-wide cursor-pointer bg-transparent border-none p-0 text-left"
              style={{ color: sortBy === 'name' ? 'var(--accent)' : 'var(--text-muted)' }}
              onClick={() => onSetSort('name')}
            >
              Name{sortBy === 'name' ? ` ${String.fromCodePoint(sortDir === 'asc' ? 0x25b2 : 0x25bc)}` : ''}
            </button>

            {/* Description — not sortable */}
            <span className="text-[10px] text-overlay0 uppercase tracking-wide">Description</span>

            {/* Size — sortable */}
            <button
              className="text-[10px] uppercase tracking-wide cursor-pointer bg-transparent border-none p-0 text-left"
              style={{ color: sortBy === 'size' ? 'var(--accent)' : 'var(--text-muted)' }}
              onClick={() => onSetSort('size')}
            >
              Size{sortBy === 'size' ? ` ${String.fromCodePoint(sortDir === 'asc' ? 0x25b2 : 0x25bc)}` : ''}
            </button>

            {/* Modified — sortable */}
            <button
              className="text-[10px] uppercase tracking-wide cursor-pointer bg-transparent border-none p-0 text-left"
              style={{ color: sortBy === 'modified' ? 'var(--accent)' : 'var(--text-muted)' }}
              onClick={() => onSetSort('modified')}
            >
              Modified{sortBy === 'modified' ? ` ${String.fromCodePoint(sortDir === 'asc' ? 0x25b2 : 0x25bc)}` : ''}
            </button>
          </div>

          {/* Rows */}
          {displayedMemories.length === 0 ? (
            <div className="text-xs text-overlay0 py-8 text-center">No memories of this type</div>
          ) : (
            displayedMemories.map(m => (
              <div
                key={m.id}
                className="grid items-center gap-2.5 px-3 py-2 rounded cursor-pointer transition-colors mb-0.5"
                style={{
                  gridTemplateColumns: 'auto minmax(0,1.2fr) minmax(0,2fr) auto auto',
                  background:
                    selectedMemoryId === m.id
                      ? 'rgba(137,180,250,0.1)'
                      : undefined,
                }}
                onClick={() => onSelectMemory(m.id)}
                onMouseEnter={e => {
                  if (selectedMemoryId !== m.id)
                    (e.currentTarget as HTMLDivElement).style.background = 'rgba(137,180,250,0.05)'
                }}
                onMouseLeave={e => {
                  if (selectedMemoryId !== m.id)
                    (e.currentTarget as HTMLDivElement).style.background = ''
                }}
              >
                <TypeBadge type={m.type} />
                <span className="font-mono text-xs text-text truncate">{m.name}</span>
                <span className="text-[11px] text-overlay1 truncate">{m.description}</span>
                <span className="text-[10px] font-mono text-overlay0">{fmt(m.size)}</span>
                <div className="flex items-center gap-1.5 text-[10px] text-overlay0 shrink-0">
                  <div
                    className={`w-1.5 h-1.5 rounded-full ${staleClass(m.modified)}`}
                    style={{ boxShadow: staleShadow(m.modified) }}
                  />
                  {fmtRel(m.modified)}
                </div>
              </div>
            ))
          )}
        </div>

        {/* RIGHT — sessions rail */}
        <div
          className="flex-[1.25] rounded-xl p-4 min-w-[180px]"
          style={{
            background: 'var(--surface-raised)',
            border: '1px solid var(--border-subtle)',
          }}
        >
          {/* Live sessions */}
          <div className="text-[11px] text-overlay0 uppercase tracking-wider mb-3">Live sessions</div>

          {liveSessions.length === 0 ? (
            <div className="text-[10px] text-overlay0 mb-3">none running</div>
          ) : (
            liveSessions.map(s => (
              <div key={s.id} className="flex items-center gap-1.5 mb-1.5">
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded-full truncate"
                  style={{
                    background: 'color-mix(in srgb, var(--status-success) 18%, transparent)',
                    color: 'var(--status-success)',
                  }}
                >
                  {String.fromCodePoint(0x25cf)} {s.label}
                </span>
                <button
                  className="text-[10px] bg-transparent border-none cursor-pointer p-0 shrink-0"
                  style={{ color: 'var(--accent)' }}
                  onClick={() => onJumpToSession(s.id)}
                >
                  jump {String.fromCodePoint(0x2192)}
                </button>
              </div>
            ))
          )}

          {/* Recent sessions */}
          <div className="text-[11px] text-overlay0 uppercase tracking-wider mb-3 mt-3">Recent sessions</div>

          {recentSessions.length === 0 ? (
            <div className="text-[10px] text-overlay0">no indexed sessions</div>
          ) : (
            recentSessions.map(s => (
              <div key={s.sessionId} className="flex items-center gap-1.5 mb-1.5">
                <span
                  className="font-mono text-[10px] px-1.5 py-0.5 rounded"
                  style={{
                    background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
                    color: 'var(--accent)',
                  }}
                >
                  {s.sessionId.slice(0, 8)}
                </span>
                <span className="text-[10px] text-overlay0">{fmtRel(s.lastActive)}</span>
                <button
                  className="text-[10px] bg-transparent border-none cursor-pointer p-0 shrink-0"
                  style={{ color: 'var(--accent)' }}
                  onClick={() => onOpenSessionLogs(s.sessionId)}
                >
                  logs {String.fromCodePoint(0x2192)}
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
