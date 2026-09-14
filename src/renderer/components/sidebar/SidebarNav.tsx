import React from 'react'
import { ViewType } from '../../types/views'
import { useSettingsStore } from '../../stores/settingsStore'
import { useTokenomicsStore } from '../../stores/tokenomicsStore'
import { useAccountProfilesStore } from '../../stores/accountProfilesStore'

interface SidebarNavProps {
  currentView: ViewType
  onViewChange: (view: ViewType) => void
  insightsStatus: string | null
  insightsMessage: string | null
  cloudAgentRunning: number
  visionRunning?: boolean
  // P7.7: serverRunning replaces visionConnected for the Conductor MCP dot.
  // The dot now reflects MCP HTTP listener health, not Chrome CDP attach,
  // matching the P7.4 spec ("Red only if the MCP HTTP listener actually
  // died"). visionConnected was removed because it was the only consumer.
  serverRunning?: boolean
  tokenomicsIndexComplete?: boolean
  collapsed?: boolean
  /** Opens the all-accounts usage overview. Button shown only with 2+ accounts. */
  onShowAccountUsage?: () => void
}

const navItems: { view: ViewType; icon: React.ReactNode; label: string }[] = [
  {
    view: 'cloud-agents',
    label: 'Cloud Agents',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z" />
      </svg>
    )
  },
  {
    view: 'insights',
    label: 'Insights',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12h-4l-3 9L9 3l-3 9H2" />
      </svg>
    )
  },
  {
    view: 'tokenomics',
    label: 'Tokenomics',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <line x1="12" y1="1" x2="12" y2="23" />
        <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
      </svg>
    )
  },
  {
    view: 'vision',
    label: 'Conductor MCP',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="2" y="2" width="20" height="8" rx="2" />
        <rect x="2" y="14" width="20" height="8" rx="2" />
        <line x1="6" y1="6" x2="6.01" y2="6" />
        <line x1="6" y1="18" x2="6.01" y2="18" />
      </svg>
    )
  },
  {
    view: 'memory',
    label: 'Memory',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2a7 7 0 0 1 7 7c0 2.38-1.19 4.47-3 5.74V17a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1v-2.26C6.19 13.47 5 11.38 5 9a7 7 0 0 1 7-7z" />
        <line x1="9" y1="21" x2="15" y2="21" />
        <line x1="10" y1="24" x2="14" y2="24" />
      </svg>
    )
  },
  {
    view: 'logs',
    label: 'Logs',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <polyline points="14 2 14 8 20 8" />
        <line x1="8" y1="13" x2="16" y2="13" />
        <line x1="8" y1="17" x2="16" y2="17" />
        <line x1="8" y1="9" x2="10" y2="9" />
      </svg>
    )
  },
  {
    view: 'settings',
    label: 'Settings',
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    )
  },
]

function NavButton({ item, currentView, onViewChange, insightsStatus, insightsMessage, cloudAgentRunning, visionRunning, serverRunning, tokenomicsIndexComplete, isCollapsed, loggingEnabled, tooltipAlign = 'start' }: {
  item: typeof navItems[0]
  currentView: ViewType
  onViewChange: (view: ViewType) => void
  insightsStatus: string | null
  insightsMessage: string | null
  cloudAgentRunning: number
  visionRunning?: boolean
  serverRunning?: boolean
  tokenomicsIndexComplete?: boolean
  isCollapsed: boolean
  loggingEnabled?: boolean
  // Expanded-mode tooltip anchoring. Left-group icons anchor 'start' (extend
  // right); right-group icons anchor 'end' (extend left). Keeps every tooltip
  // inside the window instead of centring it (which clipped the leftmost icon
  // off the left edge). Ignored when collapsed (tooltip sits to the right).
  tooltipAlign?: 'start' | 'end'
}) {
  // Logs nav entry is greyed and non-interactive when session logging is off.
  const isLogsDisabled = item.view === 'logs' && loggingEnabled === false

  const isInsightsActive = item.view === 'insights' && !!insightsStatus
  const insightsDotColor = insightsStatus === 'running' ? 'var(--status-info)'
    : insightsStatus === 'extracting_kpis' ? 'var(--status-warning)'
    : insightsStatus === 'complete' ? 'var(--status-success)'
    : insightsStatus === 'failed' ? 'var(--status-danger)'
    : null
  // Scope to the Insights item, like isCloudAgentsRunning above. Unscoped, a
  // running Insights job rewrote EVERY nav button's title -> aria-label (so
  // screen readers announced the whole rail as "Insights running...", and any
  // aria-label selector — the guided tour's Settings step — stopped matching)
  // and tinted every icon blue.
  const isInsightsAnimating = isInsightsActive && (insightsStatus === 'running' || insightsStatus === 'extracting_kpis')
  const isCloudAgentsRunning = item.view === 'cloud-agents' && cloudAgentRunning > 0
  // P7.7: dot reflects MCP server health, not browser CDP attach. Show
  // the dot whenever serverRunning has been reported (defined) so users
  // see red immediately if the listener dies, not just when the browser
  // is also up. Sidebar key stayed 'vision' for back-compat with saved
  // view state.
  const isConductorMcpIcon = item.view === 'vision'
  const showServerDot = isConductorMcpIcon && serverRunning !== undefined
  // visionRunning is still consumed by callers but no longer gates the
  // dot rendering -- kept in the signature for future per-tool status
  // indicators on the Conductor MCP page.
  void visionRunning

  const title = isLogsDisabled
    ? 'Turn on "Index conversation logs" in Settings'
    : isCollapsed
    ? item.label
    : isCloudAgentsRunning
    ? `${cloudAgentRunning} agent${cloudAgentRunning !== 1 ? 's' : ''} running`
    : isInsightsAnimating
    ? (insightsMessage || 'Insights running...')
    : item.label

  const isTokenomicsBadge = item.view === 'tokenomics' && !!tokenomicsIndexComplete

  return (
    <button
      onClick={isLogsDisabled ? undefined : () => {
        if (item.view === 'tokenomics') {
          useTokenomicsStore.getState().clearIndexBadge()
        }
        onViewChange(item.view)
      }}
      aria-label={title}
      // Stable tour anchor: `title` is legitimately dynamic (collapsed state,
      // logs-disabled, running jobs), so the tour must not target aria-label.
      data-tour={`nav-${item.view}`}
      aria-disabled={isLogsDisabled || undefined}
      tabIndex={isLogsDisabled ? -1 : undefined}
      className={`group ${isCollapsed ? 'w-10 h-10' : 'flex-1 py-2'} flex items-center justify-center rounded-lg transition-colors relative ${
        isLogsDisabled
          ? 'text-overlay0/40 cursor-not-allowed'
          : currentView === item.view
          ? 'bg-surface0 rail-active focus-ring'
          : isInsightsAnimating
          ? 'text-blue'
          : isCloudAgentsRunning
          ? 'text-blue'
          : 'text-overlay0 hover:text-text hover:bg-surface0/50 focus-ring'
      }`}
      style={!isLogsDisabled && currentView === item.view ? { color: 'var(--accent)' } : undefined}
    >
      <span className={isLogsDisabled ? 'opacity-40' : undefined}>{item.icon}</span>
      {/* Instant inline tooltip -- the only tooltip (the OS-native `title` was
          removed so the two no longer conflict). Pointer-events:none so it
          doesn't block clicks. Position adapts: collapsed = right of icon;
          expanded = below, edge-anchored so it can't clip off-screen. */}
      <span
        className={`pointer-events-none absolute z-40 px-2 py-0.5 text-[11px] rounded bg-surface1 text-text border border-surface2 shadow-md whitespace-nowrap opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity duration-100 ${
          isCollapsed
            ? 'left-full ml-2 top-1/2 -translate-y-1/2'
            : tooltipAlign === 'end'
            ? 'top-full mt-1 right-0'
            : 'top-full mt-1 left-0'
        }`}
        aria-hidden="true"
      >
        {title}
      </span>
      {isInsightsActive && insightsDotColor && (
        <span
          className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ${isInsightsAnimating ? 'insights-pulse-dot' : ''}`}
          style={{
            backgroundColor: insightsDotColor,
            boxShadow: `0 0 6px 2px color-mix(in srgb, ${insightsDotColor} 38%, transparent)`,
          }}
        />
      )}
      {isCloudAgentsRunning && (
        <span
          className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full insights-pulse-dot"
          style={{
            backgroundColor: 'var(--status-info)',
            boxShadow: '0 0 6px 2px color-mix(in srgb, var(--status-info) 38%, transparent)',
          }}
        />
      )}
      {showServerDot && (
        <span
          data-testid="conductor-mcp-dot"
          role="img"
          aria-label={serverRunning ? 'Conductor MCP server running' : 'Conductor MCP server stopped'}
          title={serverRunning ? 'Conductor MCP server running' : 'Conductor MCP server stopped'}
          className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full"
          style={{
            backgroundColor: serverRunning ? 'var(--status-success)' : 'var(--status-danger)',
            boxShadow: `0 0 6px 2px color-mix(in srgb, ${serverRunning ? 'var(--status-success)' : 'var(--status-danger)'} 38%, transparent)`,
          }}
        />
      )}
      {isTokenomicsBadge && (
        <span
          data-testid="tokenomics-index-dot"
          role="img"
          aria-label="Tokenomics index complete"
          className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full"
          style={{
            backgroundColor: 'var(--status-success)',
            boxShadow: '0 0 6px 2px color-mix(in srgb, var(--status-success) 38%, transparent)',
          }}
        />
      )}
    </button>
  )
}

export default function SidebarNav({ currentView, onViewChange, insightsStatus, insightsMessage, cloudAgentRunning, visionRunning, serverRunning, tokenomicsIndexComplete, collapsed, onShowAccountUsage }: SidebarNavProps) {
  const loggingEnabled = useSettingsStore((s) => s.settings.loggingEnabled)
  // Account-usage button lives here in the nav rail (alongside Insights etc.),
  // shown only with 2+ accounts (never single-account or macOS).
  const hasMultipleAccounts = useAccountProfilesStore((s) => s.profiles.length >= 2)

  // Active when its view is showing, so the rail highlights it like any nav item.
  const accountUsageActive = currentView === 'account-usage'
  const accountUsageButton = onShowAccountUsage && hasMultipleAccounts ? (
    <button
      onClick={onShowAccountUsage}
      aria-label="Account usage"
      className={`group ${collapsed ? 'w-10 h-10' : 'flex-1 py-2'} flex items-center justify-center rounded-lg transition-colors focus-ring relative ${
        accountUsageActive ? 'bg-surface0 rail-active' : 'text-overlay0 hover:text-text hover:bg-surface0/50'
      }`}
      style={accountUsageActive ? { color: 'var(--accent)' } : undefined}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="8" r="3.25" />
        <path d="M5.5 19.5c0-3.4 3-5.5 6.5-5.5s6.5 2.1 6.5 5.5" />
      </svg>
      <span
        className={`pointer-events-none absolute z-40 px-2 py-0.5 text-[11px] rounded bg-surface1 text-text border border-surface2 shadow-md whitespace-nowrap opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity duration-100 ${
          collapsed ? 'left-full ml-2 top-1/2 -translate-y-1/2' : 'top-full mt-1 right-0'
        }`}
        aria-hidden="true"
      >
        Account usage
      </span>
    </button>
  ) : null

  const helpActive = currentView === 'help'
  const helpButton = (
    <button
      onClick={() => onViewChange('help')}
      aria-label="Feature Guide"
      aria-current={helpActive ? 'page' : undefined}
      data-tour="help-button"
      className={`group ${collapsed ? 'w-10 h-10' : 'flex-1 py-2'} flex items-center justify-center rounded-lg transition-colors ${helpActive ? 'bg-surface0/60' : 'text-overlay0 hover:text-text hover:bg-surface0/50'} focus-ring relative`}
      style={helpActive ? { color: 'var(--accent)' } : undefined}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10" />
        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
        <line x1="12" y1="17" x2="12.01" y2="17" />
      </svg>
      <span
        className={`pointer-events-none absolute z-40 px-2 py-0.5 text-[11px] rounded bg-surface1 text-text border border-surface2 shadow-md whitespace-nowrap opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity duration-100 ${
          collapsed ? 'left-full ml-2 top-1/2 -translate-y-1/2' : 'top-full mt-1 right-0'
        }`}
        aria-hidden="true"
      >
        Feature Guide
      </span>
    </button>
  )

  const primary = navItems.filter(i => ['cloud-agents', 'insights', 'tokenomics'].includes(i.view))
  const system = navItems.filter(i => !['cloud-agents', 'insights', 'tokenomics'].includes(i.view))
  const renderItem = (item: typeof navItems[0], tooltipAlign: 'start' | 'end') => (
    <NavButton key={item.view} item={item} currentView={currentView} onViewChange={onViewChange}
      insightsStatus={insightsStatus} insightsMessage={insightsMessage} cloudAgentRunning={cloudAgentRunning}
      visionRunning={visionRunning} serverRunning={serverRunning} tokenomicsIndexComplete={tokenomicsIndexComplete}
      isCollapsed={false} loggingEnabled={loggingEnabled} tooltipAlign={tooltipAlign} />
  )

  if (collapsed) {
    return (
      <div
        data-tour="nav-rail"
        className="flex flex-col items-center gap-1 py-2 border-b border-surface0"
        style={{ background: 'var(--surface-chrome)', color: 'var(--text-on-chrome)' }}
      >
        {navItems.filter(i => ['cloud-agents', 'insights', 'tokenomics'].includes(i.view)).map(item => (
          <NavButton key={item.view} item={item} currentView={currentView} onViewChange={onViewChange}
            insightsStatus={insightsStatus} insightsMessage={insightsMessage} cloudAgentRunning={cloudAgentRunning}
            visionRunning={visionRunning} serverRunning={serverRunning} tokenomicsIndexComplete={tokenomicsIndexComplete}
            isCollapsed loggingEnabled={loggingEnabled} />
        ))}
        <span className="h-px w-6 my-1 bg-surface1" aria-hidden />
        {navItems.filter(i => !['cloud-agents', 'insights', 'tokenomics'].includes(i.view)).map(item => (
          <NavButton key={item.view} item={item} currentView={currentView} onViewChange={onViewChange}
            insightsStatus={insightsStatus} insightsMessage={insightsMessage} cloudAgentRunning={cloudAgentRunning}
            visionRunning={visionRunning} serverRunning={serverRunning} tokenomicsIndexComplete={tokenomicsIndexComplete}
            isCollapsed loggingEnabled={loggingEnabled} />
        ))}
        {accountUsageButton}
        {helpButton}
      </div>
    )
  }

  return (
    <div
      data-tour="nav-rail"
      className="px-2 pt-2 flex gap-1 items-center border-b border-surface0 pb-2"
      style={{ background: 'var(--surface-chrome)', color: 'var(--text-on-chrome)' }}
    >
      {primary.map((item) => renderItem(item, 'start'))}
      <span className="w-px self-stretch my-1 bg-surface1 shrink-0" aria-hidden />
      {system.map((item) => renderItem(item, 'end'))}
      {accountUsageButton}
      {helpButton}
    </div>
  )
}
