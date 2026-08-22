import React, { useState } from 'react'
import type { MemoryFile } from '../../../shared/types'
import { TypeBadge, fmt, fmtRel, renderMarkdown } from './memory-ui'
import { SanitizedMarkdown } from '../github/SanitizedMarkdown'
import { sanitizeMemoryHtml } from '../../utils/markdownSanitizer'
import { useDialogEscape } from '../ui/Dialog'

interface Props {
  memory: MemoryFile
  content: string | null
  onClose: () => void
  onDelete: () => void
  onWriteFrontmatter: () => void
}

/**
 * The memory reading drawer: a scrim plus a panel pinned to the right edge.
 * It is NOT a centred dialog, so it keeps its own positioning rather than
 * taking DialogOverlay/DialogPanel (an absolutely-positioned child of the
 * overlay would be inset by the overlay's padding). Colours are on the tokens
 * and Escape closes it (#360).
 *
 * The scrim deliberately has NO click-to-close: Ctrl+C in a terminal fires
 * click events, which used to eat dialogs (AGENTS.md). Escape and the close
 * glyph are the ways out.
 */
export default function MemoryReadingDrawer({ memory, content, onClose, onDelete, onWriteFrontmatter }: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  useDialogEscape(onClose)

  const chipClass = 'font-mono text-[10px] px-2.5 py-1 rounded-sm border cursor-pointer transition-all'
  const labelClass = 'font-mono text-[10px] uppercase tracking-wide text-[var(--text-muted)]'
  const valueClass = 'font-mono text-[11px] text-[var(--text-secondary)]'
  const ruleStyle: React.CSSProperties = { borderBottom: '1px solid var(--border-subtle)' }

  return (
    <div
      className="fixed inset-0 z-50"
      style={{ background: 'rgba(0,0,0,0.4)' }}
    >
      <div
        className="absolute right-0 top-0 bottom-0 w-[440px] flex flex-col"
        style={{
          background: 'var(--surface-overlay)',
          borderLeft: '2px solid var(--border-strong)',
          boxShadow: '-4px 0 24px rgba(0,0,0,0.4)',
        }}
      >
        {/* Header */}
        <div className="px-4 py-3 flex items-center gap-2.5 shrink-0" style={ruleStyle}>
          <TypeBadge type={memory.type} />
          <span className="font-mono text-[13px] font-medium text-[var(--text-primary)] flex-1 truncate">{memory.name}</span>
          <div className="flex gap-1.5">
            {!memory.hasFrontmatter && (
              <button
                onClick={onWriteFrontmatter}
                className={`${chipClass} border-[var(--border-subtle)] bg-[var(--surface-raised)] text-[var(--text-secondary)] hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]`}
              >
                + Metadata
              </button>
            )}
            {!confirmDelete ? (
              <button
                onClick={() => setConfirmDelete(true)}
                className={`${chipClass} border-[var(--border-subtle)] bg-[var(--surface-raised)] text-[var(--text-secondary)] hover:border-[var(--status-danger)] hover:text-[var(--status-danger)]`}
              >
                Delete
              </button>
            ) : (
              <button
                onClick={onDelete}
                className={`${chipClass} border-[var(--status-danger)] bg-[color-mix(in_srgb,var(--status-danger)_16%,transparent)] text-[var(--status-danger)]`}
              >
                Confirm
              </button>
            )}
          </div>
          <button
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center rounded bg-transparent border-none text-[var(--text-muted)] cursor-pointer hover:bg-[var(--surface-raised)] hover:text-[var(--text-primary)] transition-all text-base"
          >
            {String.fromCodePoint(0x00D7)}
          </button>
        </div>

        {/* Metadata grid */}
        <div className="px-4 py-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 shrink-0" style={ruleStyle}>
          <span className={labelClass}>Type</span>
          <span className={valueClass}>{memory.type} {memory.hasFrontmatter ? '(frontmatter)' : '(inferred)'}</span>
          <span className={labelClass}>Project</span>
          <span className={valueClass}>{memory.project}</span>
          <span className={labelClass}>Machine</span>
          <span className={valueClass}>Local</span>
          <span className={labelClass}>Path</span>
          <span className={`${valueClass} truncate`} title={memory.path}>{memory.path}</span>
          <span className={labelClass}>Size</span>
          <span className={valueClass}>{fmt(memory.size)}</span>
          <span className={labelClass}>Modified</span>
          <span className={valueClass}>{new Date(memory.modified).toISOString().slice(0, 10)} ({fmtRel(memory.modified)})</span>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-4">
          {content === null ? (
            <div className="text-[var(--text-muted)] font-mono text-xs">Loading...</div>
          ) : (
            // P2.6: route the (already entity-escaped + themed) memory markdown
            // through the single audited SanitizedMarkdown render site + DOMPurify
            // rather than a bespoke dangerouslySetInnerHTML. Styling is unchanged.
            <SanitizedMarkdown
              source={content}
              render={(md) => sanitizeMemoryHtml('<p>' + renderMarkdown(md) + '</p>')}
              className="text-xs leading-relaxed text-[var(--text-secondary)]"
            />
          )}
        </div>
      </div>
    </div>
  )
}
