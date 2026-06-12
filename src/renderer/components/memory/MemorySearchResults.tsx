import React from 'react'
import type { MemoryFile } from '../../../shared/types'
import { TypeBadge, fmt, fmtRel } from './memory-ui'

interface Props {
  memories: MemoryFile[]
  query: string
  selectedId: string | null
  onSelect: (id: string) => void
  onClear: () => void
}

export default function MemorySearchResults({ memories, query, selectedId, onSelect, onClear }: Props) {
  const ql = query.toLowerCase()
  const results = memories.filter(m =>
    m.name.toLowerCase().includes(ql) ||
    m.description.toLowerCase().includes(ql) ||
    m.project.toLowerCase().includes(ql) ||
    m.filename.toLowerCase().includes(ql)
  ).sort((a, b) => b.modified - a.modified)

  return (
    <div>
      <button
        onClick={onClear}
        className="flex items-center gap-1.5 font-mono text-[11px] text-blue bg-transparent border-none cursor-pointer mb-4 hover:opacity-80"
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        Clear search
      </button>

      <div className="font-mono text-[11px] text-overlay1 mb-3">
        {results.length} result{results.length !== 1 ? 's' : ''} for &ldquo;{query}&rdquo;
      </div>

      {results.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-overlay0 gap-2">
          <span className="font-mono text-xs">No memories match &ldquo;{query}&rdquo;</span>
        </div>
      ) : (
        <div
          className="rounded-xl p-4"
          style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
        >
          {results.map(m => {
            const isSelected = selectedId === m.id
            return (
              <div
                key={m.id}
                onClick={() => onSelect(m.id)}
                className={`grid grid-cols-[auto_minmax(0,1.4fr)_minmax(0,2fr)_auto] items-center gap-2.5 px-3 py-2 rounded cursor-pointer transition-colors mb-0.5 ${
                  isSelected
                    ? 'bg-[rgba(137,180,250,0.1)]'
                    : 'hover:bg-[rgba(137,180,250,0.05)]'
                }`}
              >
                {/* TypeBadge */}
                <TypeBadge type={m.type} />

                {/* Name + breadcrumb */}
                <div className="min-w-0">
                  <div className="font-mono text-xs text-text truncate">{m.name}</div>
                  <div className="font-mono text-[10px] text-overlay0">Local / {m.project} / {m.filename}</div>
                </div>

                {/* Description */}
                <div className="text-[11px] text-overlay1 truncate">{m.description}</div>

                {/* Size + relative date */}
                <div className="text-right font-mono text-[10px] text-overlay0 shrink-0">
                  <div>{fmt(m.size)}</div>
                  <div>{fmtRel(m.modified)}</div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
