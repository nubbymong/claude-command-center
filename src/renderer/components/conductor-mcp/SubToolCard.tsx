import React from 'react'

interface SubToolCardProps {
  title: string
  icon: React.ReactNode
  statusLabel: string
  statusColor: 'green' | 'yellow' | 'red' | 'overlay1'
  description?: string
  toolList?: string[]
  actions?: React.ReactNode
  children?: React.ReactNode
}

const COLOR_CLASSES: Record<SubToolCardProps['statusColor'], string> = {
  green: 'bg-green/15 text-green',
  yellow: 'bg-yellow/15 text-yellow',
  red: 'bg-red/15 text-red',
  overlay1: 'bg-overlay1/15 text-overlay1',
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
    <div className="rounded-md border border-surface0 bg-base p-4 space-y-3">
      <div className="flex items-center gap-3">
        <div className="text-text">{icon}</div>
        <div className="text-text font-medium">{title}</div>
        <span className={`text-xs px-2 py-0.5 rounded ${COLOR_CLASSES[statusColor]}`}>
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
