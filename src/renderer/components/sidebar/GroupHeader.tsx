import React from 'react'
import { ConfigGroup } from '../../stores/configStore'

interface GroupHeaderProps {
  group: ConfigGroup
  isRenaming: boolean
  renameValue: string
  renameRef: React.RefObject<HTMLInputElement | null>
  onRenameChange: (val: string) => void
  onRenameFinish: () => void
  onRenameCancel: () => void
  onToggleCollapse: () => void
  onStartRename: () => void
  onLaunchAll: () => void
  onDelete: () => void
  onContextMenu: (e: React.MouseEvent) => void
}

export default function GroupHeader({ group, isRenaming, renameValue, renameRef, onRenameChange, onRenameFinish, onRenameCancel, onToggleCollapse, onStartRename, onLaunchAll, onDelete, onContextMenu }: GroupHeaderProps) {
  return (
    <div
      className="flex items-center gap-1 py-1 px-1 rounded hover:bg-surface0/30 transition-colors group/header"
      onContextMenu={onContextMenu}
    >
      <button
        onClick={onToggleCollapse}
        className="p-0.5 text-overlay0 hover:text-text transition-colors"
        title={group.collapsed ? 'Expand' : 'Collapse'}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"
          style={{ transform: group.collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 150ms' }}>
          <polygon points="2,2 8,5 2,8" />
        </svg>
      </button>
      {isRenaming ? (
        <input
          ref={renameRef}
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={onRenameFinish}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRenameFinish()
            if (e.key === 'Escape') onRenameCancel()
          }}
          className="flex-1 bg-base border border-blue rounded px-1.5 py-0.5 text-xs text-text outline-none min-w-0"
        />
      ) : (
        <span
          className="text-xs font-medium text-subtext1 truncate flex-1 cursor-pointer"
          onDoubleClick={onStartRename}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onStartRename() }}
          title="Double-click or right-click to rename"
        >
          {group.name}
        </span>
      )}
      <div className="flex gap-0.5 opacity-0 group-hover/header:opacity-100 transition-opacity">
        <button
          onClick={onLaunchAll}
          className="p-0.5 rounded hover:bg-surface1 text-green"
          title="Launch all"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 8,5 2,9" /></svg>
        </button>
        <button
          onClick={onDelete}
          className="p-0.5 rounded hover:bg-surface1 text-overlay1 hover:text-red"
          title="Delete group (configs kept)"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>
        </button>
      </div>
    </div>
  )
}
