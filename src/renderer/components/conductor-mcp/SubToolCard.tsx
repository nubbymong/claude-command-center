import React from 'react'
import { SUB_TOOL_PILL_TOKEN, SUB_TOOL_PILL_WASH, type SubToolStatusColor } from './sub-tool-tones'

interface SubToolCardProps {
  title: string
  icon: React.ReactNode
  statusLabel: string
  statusColor: SubToolStatusColor
  description?: string
  toolList?: string[]
  actions?: React.ReactNode
  children?: React.ReactNode
}

/** A status pill: its semantic token over a wash of itself (sub-tool-tones). */
function pillStyle(color: SubToolStatusColor): React.CSSProperties {
  const token = `var(--${SUB_TOOL_PILL_TOKEN[color]})`
  return { color: token, background: `color-mix(in srgb, ${token} ${SUB_TOOL_PILL_WASH}%, transparent)` }
}

/**
 * P7.4: Generic sub-tool card used by ConductorMcpPage. Each card
 * shows one MCP sub-tool's status, optional tool list, and actions.
 * Server-level state lives in the page header, not here.
 */
export default function SubToolCard({
  title, icon, statusLabel, statusColor, description, toolList, actions, children,
}: SubToolCardProps) {
  return (
    <div
      className="rounded-xl p-4 space-y-3 transition-colors duration-200"
      style={{ background: 'var(--surface-raised)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="flex items-center gap-3">
        <div className="text-text">{icon}</div>
        <div className="text-text font-medium text-sm">{title}</div>
        <span className="text-xs px-2 py-0.5 rounded-full transition-colors duration-200" style={pillStyle(statusColor)} data-testid="sub-tool-status" data-tone={statusColor}>
          {statusLabel}
        </span>
        <div className="flex-1" />
        {actions}
      </div>
      {description && <div className="text-sm text-subtext0">{description}</div>}
      {toolList && toolList.length > 0 && (
        <div className="text-xs text-overlay1">
          Tools: <span className="font-mono">{toolList.join(', ')}</span>
        </div>
      )}
      {children}
    </div>
  )
}
