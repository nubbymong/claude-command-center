import React from 'react'
import { TerminalConfig, useConfigStore } from '../../stores/configStore'

interface PinnedConfigsPanelProps {
  configs: TerminalConfig[]
  onLaunch: (config: TerminalConfig) => void
}

export default function PinnedConfigsPanel({ configs, onLaunch }: PinnedConfigsPanelProps) {
  const togglePinned = useConfigStore((s) => s.togglePinned)

  if (configs.length === 0) return null

  return (
    <div className="px-2 pb-1 space-y-0.5">
      {configs.map((config) => (
        <div
          key={config.id}
          className="flex items-center gap-2 rounded-md py-1 px-2 group transition-colors hover:bg-surface0/40"
        >
          <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: config.color }} />
          <span className="text-xs text-text truncate flex-1">{config.label}</span>
          <button
            onClick={() => onLaunch(config)}
            className="p-0.5 rounded hover:bg-surface1 text-green opacity-0 group-hover:opacity-100 transition-opacity"
            title="Launch"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor"><polygon points="2,1 8,5 2,9" /></svg>
          </button>
          <button
            onClick={() => togglePinned(config.id)}
            className="p-0.5 rounded hover:bg-surface1 text-overlay0 hover:text-text opacity-0 group-hover:opacity-100 transition-opacity"
            title="Unpin"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>
          </button>
        </div>
      ))}
    </div>
  )
}
