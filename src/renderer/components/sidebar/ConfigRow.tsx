import React from 'react'
import { TerminalConfig } from '../../stores/configStore'
import { ClaudeBadge, ShellBadge, SshBadge } from './Badges'

interface ConfigRowProps {
  config: TerminalConfig
  onLaunch: () => void
  onEdit: () => void
  onDelete: () => void
  onPin?: () => void
  onContextMenu: (e: React.MouseEvent) => void
  draggable?: boolean
  onDragStart?: (e: React.DragEvent) => void
  onDragOver?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  onDragEnd?: () => void
  isDragOver?: boolean
}

export default function ConfigRow({ config, onLaunch, onEdit, onDelete, onPin, onContextMenu, draggable, onDragStart, onDragOver, onDrop, onDragEnd, isDragOver }: ConfigRowProps) {
  return (
    <div
      className={`flex items-center gap-2 rounded-md py-1.5 px-2 group transition-colors ${isDragOver ? 'border-t-2 border-blue' : ''}`}
      style={{ borderLeft: `3px solid ${config.color}`, opacity: undefined }}
      onContextMenu={onContextMenu}
      onMouseEnter={(e) => (e.currentTarget as HTMLElement).style.backgroundColor = config.color + '12'}
      onMouseLeave={(e) => (e.currentTarget as HTMLElement).style.backgroundColor = ''}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    >
      <span className="text-sm text-text truncate flex-1">{config.label}</span>
      {config.sessionType === 'ssh' && <SshBadge />}
      {config.shellOnly ? <ShellBadge /> : <ClaudeBadge needsAttention={false} />}
      <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          onClick={onLaunch}
          className="p-1 rounded hover:bg-surface1 text-green"
          title="Launch"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor"><polygon points="3,1 10,6 3,11" /></svg>
        </button>
        {onPin && (
          <button
            onClick={onPin}
            className={`p-1 rounded hover:bg-surface1 transition-colors ${config.pinned ? 'text-blue' : 'text-overlay1 hover:text-text'}`}
            title={config.pinned ? 'Unpin' : 'Pin to top'}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
            </svg>
          </button>
        )}
        <button
          onClick={onEdit}
          className="p-1 rounded hover:bg-surface1 text-overlay1 hover:text-text"
          title="Edit"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><path d="M8.5 1.5l2 2-7 7H1.5v-2z"/></svg>
        </button>
        <button
          onClick={onDelete}
          className="p-1 rounded hover:bg-surface1 text-overlay1 hover:text-red"
          title="Delete"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="10" y2="10"/><line x1="10" y1="2" x2="2" y2="10"/></svg>
        </button>
      </div>
    </div>
  )
}
