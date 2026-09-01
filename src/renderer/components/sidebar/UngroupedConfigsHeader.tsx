import React from 'react'

interface UngroupedConfigsHeaderProps {
  collapsed?: boolean
  onToggleCollapse: () => void
}

/**
 * The "Ungrouped" heading over the loose SAVED configs (phase 6, signed-off
 * replica) — the counterpart of `UngroupedSessionsHeader` on the Running tab.
 *
 * The loose tail used to sit under a bare rule with no name, so the eye read it
 * as the last group's overflow: the divider said "something changed here" but
 * never said what, and the rows below had no heading of their own while every
 * other row on the tab did. Same anatomy as `GroupHeader` — chevron + label,
 * collapsible — minus the actions a pseudo-group cannot offer (there is nothing
 * to rename, and nothing to delete: these configs are loose BY not belonging).
 *
 * Callers decide WHEN it shows: only when something organised sits above it, so
 * a sidebar of nothing but loose configs stays clean (the divider's own rule).
 */
export default function UngroupedConfigsHeader({ collapsed, onToggleCollapse }: UngroupedConfigsHeaderProps) {
  return (
    <div
      className="flex items-center gap-1 py-1 px-1 rounded hover:bg-surface0/30 transition-colors"
      data-testid="ungrouped-configs-header"
    >
      <button
        onClick={onToggleCollapse}
        aria-label={collapsed ? 'Expand ungrouped configs' : 'Collapse ungrouped configs'}
        aria-expanded={!collapsed}
        className="p-0.5 text-overlay0 hover:text-text transition-colors focus-ring"
        data-testid="ungrouped-configs-toggle"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"
          style={{ transform: collapsed ? 'rotate(-90deg)' : 'rotate(0deg)', transition: 'transform 150ms' }}>
          <polygon points="2,2 8,5 2,8" />
        </svg>
      </button>
      <span className="text-xs font-medium text-subtext1 truncate flex-1">Ungrouped</span>
    </div>
  )
}
