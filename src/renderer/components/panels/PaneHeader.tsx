import React from 'react'
import type { PaneType } from '../../../shared/types'

interface Props {
  paneId: string
  paneType: PaneType
  title?: string
  isMaximized?: boolean
  isFocused?: boolean
  canClose?: boolean
  onClose: () => void
  onMaximize: () => void
  onDragStart: (e: React.DragEvent) => void
  onFocus: () => void
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
  isFocused = false,
  canClose = true,
  onClose,
  onMaximize,
  onDragStart,
  onFocus,
}: Props) {
  const label = title || PANE_LABELS[paneType]
  const color = PANE_COLORS[paneType]
  const icon = PANE_ICONS[paneType]

  return (
    <div
      className="group flex items-center select-none shrink-0 overflow-hidden rounded-t transition-all duration-150"
      draggable
      onDragStart={onDragStart}
      onDoubleClick={onMaximize}
      onPointerDown={onFocus}
      style={{
        cursor: 'grab',
        background: isFocused
          ? `linear-gradient(to right, ${color}12, ${color}06)`
          : '#181825',
        boxShadow: isFocused
          ? `0 0 0 1px ${color}30, inset 0 0 0 1px ${color}10`
          : 'none',
      }}
    >
      {/* Colored left accent bar */}
      <div
        className="shrink-0 transition-all duration-150"
        style={{
          width: '3px',
          height: '100%',
          background: color,
          opacity: isFocused ? 1 : 0.4,
        }}
      />
      <div className="flex items-center justify-between flex-1 px-2 py-1 min-w-0">
        <div className="flex items-center gap-1.5 text-xs min-w-0">
          <span
            className="transition-opacity duration-150"
            style={{ color, fontSize: '9px', opacity: isFocused ? 1 : 0.5 }}
          >
            {icon}
          </span>
          <span
            className="truncate transition-colors duration-150"
            style={{
              color: isFocused ? '#cdd6f4' : '#a6adc8',
              fontWeight: isFocused ? 600 : 400,
            }}
          >
            {label}
          </span>
        </div>
        {/* Controls: visible on hover or when focused */}
        <div
          className="flex items-center gap-1 text-xs transition-opacity duration-150"
          style={{ opacity: isFocused ? 0.7 : 0 }}
        >
          <div className="group-hover:opacity-100 opacity-0 flex items-center gap-1 transition-opacity duration-150"
            style={{ opacity: isFocused ? 1 : undefined }}
          >
            <button
              onClick={(e) => { e.stopPropagation(); onMaximize() }}
              className="hover:text-text px-1 transition-colors duration-150 text-overlay0"
              title={isMaximized ? 'Restore (double-click header)' : 'Maximize (double-click header)'}
            >
              {isMaximized ? String.fromCodePoint(0x25A3) : String.fromCodePoint(0x25A1)}
            </button>
            {canClose && (
              <button
                onClick={(e) => { e.stopPropagation(); onClose() }}
                className="hover:text-red px-1 transition-colors duration-150 text-overlay0"
                title="Close pane"
              >
                {String.fromCodePoint(0x00D7)}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
