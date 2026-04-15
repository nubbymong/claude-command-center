import React from 'react'
import { ConfigSection } from '../../stores/configStore'

interface SessionSectionHeaderProps {
  section: ConfigSection
  collapsed?: boolean
  onToggleCollapse: () => void
  onCloseAll: () => void
}

export default function SessionSectionHeader({ section, collapsed, onToggleCollapse, onCloseAll }: SessionSectionHeaderProps) {
  return (
    <div className="flex items-center gap-1 py-1.5 px-1 rounded hover:bg-surface0/20 transition-colors group/ssection">
      <button
        onClick={onToggleCollapse}
        className="p-0.5 text-overlay0 hover:text-text transition-colors"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"
          style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 150ms' }}>
          <polygon points="2,2 8,5 2,8" />
        </svg>
      </button>
      <span className="text-[10px] font-bold uppercase tracking-widest text-overlay1 truncate flex-1">
        {section.name}
      </span>
      <button
        onClick={onCloseAll}
        className="p-0.5 rounded hover:bg-surface1 text-overlay1 hover:text-red opacity-0 group-hover/ssection:opacity-100 transition-opacity"
        title="Close all sessions in section"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>
      </button>
    </div>
  )
}
