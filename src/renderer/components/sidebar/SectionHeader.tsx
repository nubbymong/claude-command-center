import React from 'react'
import { ConfigSection } from '../../stores/configStore'

interface SectionHeaderProps {
  section: ConfigSection
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
}

export default function SectionHeader({ section, isRenaming, renameValue, renameRef, onRenameChange, onRenameFinish, onRenameCancel, onToggleCollapse, onStartRename, onLaunchAll, onDelete }: SectionHeaderProps) {
  return (
    <div className="flex items-center gap-1 py-1.5 px-1 rounded hover:bg-surface0/20 transition-colors group/section">
      <button
        onClick={onToggleCollapse}
        className="p-0.5 text-overlay0 hover:text-text transition-colors"
        title={section.collapsed ? 'Expand' : 'Collapse'}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"
          style={{ transform: section.collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 150ms' }}>
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
          className="flex-1 bg-base border border-blue rounded px-1.5 py-0.5 text-[10px] text-text outline-none min-w-0 uppercase tracking-widest font-bold"
        />
      ) : (
        <span
          className="text-[10px] font-bold uppercase tracking-widest text-overlay1 truncate flex-1 cursor-pointer"
          onDoubleClick={onStartRename}
          onContextMenu={(e) => { e.preventDefault(); onStartRename() }}
          title="Double-click or right-click to rename"
        >
          {section.name}
        </span>
      )}
      <div className="flex gap-0.5 opacity-0 group-hover/section:opacity-100 transition-opacity">
        <button
          onClick={onLaunchAll}
          className="p-0.5 rounded hover:bg-surface1 text-green"
          title="Launch all in section"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 8,5 2,9" /></svg>
        </button>
        <button
          onClick={onDelete}
          className="p-0.5 rounded hover:bg-surface1 text-overlay1 hover:text-red"
          title="Delete section (items move to root)"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>
        </button>
      </div>
    </div>
  )
}
