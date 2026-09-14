import React from 'react'
import SubToolCard from './SubToolCard'
import { useConductorMcpStore } from '../../stores/conductorMcpStore'

const visionIcon = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
)

export default function VisionSubTool() {
  const { browserRunning, browserConnected, stopBrowser, launchBrowser, error } = useConductorMcpStore()

  const statusLabel = browserRunning && browserConnected ? 'Connected'
    : browserRunning ? 'Browser launching...'
    : 'Stopped'
  const statusColor: 'green' | 'yellow' | 'overlay1' =
    browserRunning && browserConnected ? 'green'
    : browserRunning ? 'yellow'
    : 'overlay1'

  const actions = browserRunning ? (
    <button onClick={stopBrowser} className="px-2.5 py-0.5 text-xs rounded border border-red/40 bg-red/10 text-red hover:bg-red/20 transition-colors">
      Stop browser
    </button>
  ) : (
    <button onClick={launchBrowser} className="px-2.5 py-0.5 text-xs rounded border border-green/40 bg-green/10 text-green hover:bg-green/20 transition-colors">
      Start browser
    </button>
  )

  return (
    <SubToolCard
      title="Vision (browser automation)"
      icon={visionIcon}
      statusLabel={statusLabel}
      statusColor={statusColor}
      description="Headless Chrome via CDP. Auto-starts at app boot; Stop button kills it for the current run."
      toolList={['screenshot', 'navigate', 'click', 'type', 'eval']}
      actions={actions}
    >
      {/* #371: the store's error had no surface at all, so a refused settings
          read/write — and a failed browser launch before it — were silent. */}
      {error && (
        <div
          role="alert"
          className="text-xs leading-snug rounded-lg px-2.5 py-1.5"
          style={{
            color: 'var(--status-danger)',
            background: 'color-mix(in srgb, var(--status-danger) 12%, transparent)',
            border: '1px solid color-mix(in srgb, var(--status-danger) 30%, transparent)',
          }}
        >
          {error}
        </div>
      )}
    </SubToolCard>
  )
}
