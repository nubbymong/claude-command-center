import React, { useState } from 'react'
import type { MemoryFile } from '../../../shared/types'
import { TypeBadge, fmt, fmtRel, renderMarkdown, TYPE_COLORS } from './memory-ui'

interface Props {
  memory: MemoryFile
  content: string | null
  onClose: () => void
  onDelete: () => void
  onWriteFrontmatter: () => void
}

export default function MemoryReadingDrawer({ memory, content, onClose, onDelete, onWriteFrontmatter }: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  // TYPE_COLORS lookup kept for future use (matches DetailPanel pattern)
  const _tc = TYPE_COLORS[memory.type] || TYPE_COLORS.uncategorized

  return (
    <div
      className="fixed inset-0 z-50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
      style={{ background: 'rgba(0,0,0,0.4)' }}
    >
      <div
        className="absolute right-0 top-0 bottom-0 w-[440px] flex flex-col"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--surface-overlay)',
          borderLeft: '2px solid var(--border-strong)',
          boxShadow: '-4px 0 24px rgba(0,0,0,0.4)',
        }}
      >
        {/* Header */}
        <div className="px-4 py-3 border-b border-surface0 flex items-center gap-2.5 shrink-0">
          <TypeBadge type={memory.type} />
          <span className="font-mono text-[13px] font-medium text-text flex-1 truncate">{memory.name}</span>
          <div className="flex gap-1.5">
            {!memory.hasFrontmatter && (
              <button
                onClick={onWriteFrontmatter}
                className="font-mono text-[10px] px-2.5 py-1 rounded-sm border border-surface1 bg-surface0 text-subtext0 cursor-pointer hover:border-overlay0 hover:text-text transition-all"
              >
                + Metadata
              </button>
            )}
            {!confirmDelete ? (
              <button
                onClick={() => setConfirmDelete(true)}
                className="font-mono text-[10px] px-2.5 py-1 rounded-sm border border-surface1 bg-surface0 text-subtext0 cursor-pointer hover:border-red hover:text-red transition-all"
              >
                Delete
              </button>
            ) : (
              <button
                onClick={onDelete}
                className="font-mono text-[10px] px-2.5 py-1 rounded-sm border border-red bg-red/10 text-red cursor-pointer"
              >
                Confirm
              </button>
            )}
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded bg-transparent border-none text-overlay0 cursor-pointer hover:bg-surface0 hover:text-text transition-all text-base"
          >
            {String.fromCodePoint(0x00D7)}
          </button>
        </div>

        {/* Metadata grid */}
        <div className="px-4 py-3 border-b border-surface0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 shrink-0">
          <span className="font-mono text-[10px] text-overlay0 uppercase tracking-wide">Type</span>
          <span className="font-mono text-[11px] text-subtext1">{memory.type} {memory.hasFrontmatter ? '(frontmatter)' : '(inferred)'}</span>
          <span className="font-mono text-[10px] text-overlay0 uppercase tracking-wide">Project</span>
          <span className="font-mono text-[11px] text-subtext1">{memory.project}</span>
          <span className="font-mono text-[10px] text-overlay0 uppercase tracking-wide">Machine</span>
          <span className="font-mono text-[11px] text-subtext1">Local</span>
          <span className="font-mono text-[10px] text-overlay0 uppercase tracking-wide">Path</span>
          <span className="font-mono text-[11px] text-subtext1 truncate" title={memory.path}>{memory.path}</span>
          <span className="font-mono text-[10px] text-overlay0 uppercase tracking-wide">Size</span>
          <span className="font-mono text-[11px] text-subtext1">{fmt(memory.size)}</span>
          <span className="font-mono text-[10px] text-overlay0 uppercase tracking-wide">Modified</span>
          <span className="font-mono text-[11px] text-subtext1">{new Date(memory.modified).toISOString().slice(0, 10)} ({fmtRel(memory.modified)})</span>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {content === null ? (
            <div className="text-overlay0 font-mono text-xs">Loading...</div>
          ) : (
            <div
              className="text-xs leading-relaxed text-subtext1"
              dangerouslySetInnerHTML={{ __html: '<p>' + renderMarkdown(content) + '</p>' }}
            />
          )}
        </div>
      </div>
    </div>
  )
}
