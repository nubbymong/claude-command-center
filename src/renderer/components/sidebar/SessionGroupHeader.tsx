import React from 'react'

interface SessionGroupHeaderProps {
  /** Heading text: the group's name, or "Ungrouped" for the loose tail (#363). */
  name: string
  collapsed?: boolean
  onToggleCollapse: () => void
  onCloseAll: () => void
  /** Wording overrides so the "Ungrouped" pseudo-group reads right to
   *  screen readers and tooltips. Defaults are the group wording. */
  collapseLabel?: string
  expandLabel?: string
  closeAllTitle?: string
  testId?: string
}

export default function SessionGroupHeader({
  name,
  collapsed,
  onToggleCollapse,
  onCloseAll,
  collapseLabel = 'Collapse group',
  expandLabel = 'Expand group',
  closeAllTitle = 'Close all sessions in group',
  testId
}: SessionGroupHeaderProps) {
  return (
    <div className="flex items-center gap-1 py-1 px-1 rounded hover:bg-surface0/30 transition-colors group/sheader" data-testid={testId}>
      <button
        onClick={onToggleCollapse}
        aria-label={collapsed ? expandLabel : collapseLabel}
        aria-expanded={!collapsed}
        className="p-0.5 text-overlay0 hover:text-text transition-colors focus-ring"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"
          style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 150ms' }}>
          <polygon points="2,2 8,5 2,8" />
        </svg>
      </button>
      <span className="text-xs font-medium text-subtext1 truncate flex-1">{name}</span>
      <button
        onClick={onCloseAll}
        className="p-0.5 rounded hover:bg-surface1 text-overlay1 hover:text-red opacity-0 group-hover/sheader:opacity-100 transition-opacity focus-ring"
        title={closeAllTitle}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>
      </button>
    </div>
  )
}
