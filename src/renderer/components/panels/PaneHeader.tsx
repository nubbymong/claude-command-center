import React from 'react'
import type { PaneType } from '../../../shared/types'

interface Props {
  paneId: string
  paneType: PaneType
  title?: string
  isMaximized?: boolean
  canClose?: boolean
  onClose: () => void
  onMaximize: () => void
  onDragStart: (e: React.DragEvent) => void
}

const PANE_ICONS: Record<PaneType, string> = {
  'claude-terminal': String.fromCodePoint(0x25B6),
  'partner-terminal': String.fromCodePoint(0x25B6),
  'diff-viewer': String.fromCodePoint(0x25B2) + String.fromCodePoint(0x25BC),
  'preview': String.fromCodePoint(0x25C9),
  'file-editor': String.fromCodePoint(0x1F4C4),
}

const PANE_COLORS: Record<PaneType, string> = {
  'claude-terminal': '#89b4fa',
  'partner-terminal': '#a6e3a1',
  'diff-viewer': '#f9e2af',
  'preview': '#94e2d5',
  'file-editor': '#fab387',
}

const PANE_LABELS: Record<PaneType, string> = {
  'claude-terminal': 'Claude Terminal',
  'partner-terminal': 'Partner Terminal',
  'diff-viewer': 'Diff Viewer',
  'preview': 'Preview',
  'file-editor': 'File Editor',
}

export default function PaneHeader({
  paneId,
  paneType,
  title,
  isMaximized,
  canClose = true,
  onClose,
  onMaximize,
  onDragStart,
}: Props) {
  const label = title || PANE_LABELS[paneType]
  const color = PANE_COLORS[paneType]
  const icon = PANE_ICONS[paneType]

  return (
    <div
      className="flex items-center justify-between px-2 py-1 bg-mantle border-b border-surface0 select-none shrink-0"
      draggable
      onDragStart={onDragStart}
      style={{ cursor: 'grab' }}
    >
      <div className="flex items-center gap-1.5 text-xs min-w-0">
        <span style={{ color, fontSize: '9px' }}>{icon}</span>
        <span className="text-text font-medium truncate">{label}</span>
      </div>
      <div className="flex items-center gap-1 text-overlay0 text-xs">
        <button
          onClick={onMaximize}
          className="hover:text-text px-1 transition-colors"
          title={isMaximized ? 'Restore' : 'Maximize'}
        >
          {isMaximized ? String.fromCodePoint(0x25A3) : String.fromCodePoint(0x25A1)}
        </button>
        {canClose && (
          <button
            onClick={onClose}
            className="hover:text-red px-1 transition-colors"
            title="Close pane"
          >
            {String.fromCodePoint(0x00D7)}
          </button>
        )}
      </div>
    </div>
  )
}
