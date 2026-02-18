import React from 'react'
import { ViewType } from '../../types/views'

interface SidebarNavProps {
  currentView: ViewType
  onViewChange: (view: ViewType) => void
  insightsStatus: string | null
  insightsMessage: string | null
  cloudAgentRunning: number
  collapsed?: boolean
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

function NavButton({ item, currentView, onViewChange, insightsStatus, insightsMessage, cloudAgentRunning, isCollapsed }: {
  item: typeof navItems[0]
  currentView: ViewType
  onViewChange: (view: ViewType) => void
  insightsStatus: string | null
  insightsMessage: string | null
  cloudAgentRunning: number
  isCollapsed: boolean
}) {
  const isInsightsActive = item.view === 'insights' && !!insightsStatus
  const insightsDotColor = insightsStatus === 'running' ? '#89B4FA'
    : insightsStatus === 'extracting_kpis' ? '#F9E2AF'
    : insightsStatus === 'complete' ? '#A6E3A1'
    : insightsStatus === 'failed' ? '#F38BA8'
    : null
  const isInsightsAnimating = insightsStatus === 'running' || insightsStatus === 'extracting_kpis'
  const isCloudAgentsRunning = item.view === 'cloud-agents' && cloudAgentRunning > 0

  const title = isCollapsed
    ? item.label
    : isCloudAgentsRunning
    ? `${cloudAgentRunning} agent${cloudAgentRunning !== 1 ? 's' : ''} running`
    : isInsightsAnimating
    ? (insightsMessage || 'Insights running...')
    : item.label

  return (
    <button
      onClick={() => onViewChange(item.view)}
      title={title}
      className={`${isCollapsed ? 'w-10 h-10' : 'flex-1 py-2'} flex items-center justify-center rounded-lg transition-colors relative ${
        currentView === item.view
          ? 'bg-surface0 text-text'
          : isInsightsAnimating
          ? 'text-blue'
          : isCloudAgentsRunning
          ? 'text-blue'
          : 'text-overlay0 hover:text-text hover:bg-surface0/50'
      }`}
    >
      {item.icon}
      {isInsightsActive && insightsDotColor && (
        <span
          className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ${isInsightsAnimating ? 'insights-pulse-dot' : ''}`}
          style={{
            backgroundColor: insightsDotColor,
            boxShadow: `0 0 6px 2px ${insightsDotColor}60`,
          }}
        />
      )}
      {isCloudAgentsRunning && (
        <span
          className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full insights-pulse-dot"
          style={{
            backgroundColor: '#89B4FA',
            boxShadow: '0 0 6px 2px #89B4FA60',
          }}
        />
      )}
    </button>
  )
}

export default function SidebarNav({ currentView, onViewChange, insightsStatus, insightsMessage, cloudAgentRunning, collapsed }: SidebarNavProps) {
  if (collapsed) {
    return (
      <div className="flex flex-col items-center gap-1 py-2 border-b border-surface0">
        {navItems.map(item => (
          <NavButton
            key={item.view}
            item={item}
            currentView={currentView}
            onViewChange={onViewChange}
            insightsStatus={insightsStatus}
            insightsMessage={insightsMessage}
            cloudAgentRunning={cloudAgentRunning}
            isCollapsed
          />
        ))}
      </div>
    )
  }

  return (
    <div className="px-2 pt-2 flex gap-1 border-b border-surface0 pb-2">
      {navItems.map(item => (
        <NavButton
          key={item.view}
          item={item}
          currentView={currentView}
          onViewChange={onViewChange}
          insightsStatus={insightsStatus}
          insightsMessage={insightsMessage}
          cloudAgentRunning={cloudAgentRunning}
          isCollapsed={false}
        />
      ))}
    </div>
  )
}
