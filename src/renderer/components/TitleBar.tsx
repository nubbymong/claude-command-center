import React, { useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '../stores/settingsStore'
import ThemeToggle from './ThemeToggle'
import ConductorHealthPill from './ConductorHealthPill'
import ConductorServicesPanel from './ConductorServicesPanel'
import SentinelDot from './sentinel/SentinelDot'

interface Props {
  sidebarOpen: boolean
  onToggleSidebar: () => void
}

interface ComponentStatus {
  id: string
  label: string
  status: string
  name: string
}

interface ServiceStatusPayload {
  fetchedAt: string
  claudeCode: ComponentStatus | null
  claudeAi: ComponentStatus | null
  api: ComponentStatus | null
  worst: string
}

const STATUS_COLORS: Record<string, string> = {
  operational: 'bg-green',
  under_maintenance: 'bg-blue',
  degraded_performance: 'bg-yellow',
  partial_outage: 'bg-peach',
  major_outage: 'bg-red',
}

const STATUS_TEXT_COLORS: Record<string, string> = {
  operational: 'text-green',
  under_maintenance: 'text-blue',
  degraded_performance: 'text-yellow',
  partial_outage: 'text-peach',
  major_outage: 'text-red',
}

const STATUS_LABELS: Record<string, string> = {
  operational: 'OK',
  under_maintenance: 'Maint.',
  degraded_performance: 'Degraded',
  partial_outage: 'Partial',
  major_outage: 'Outage',
}

const STATUS_LONG_LABELS: Record<string, string> = {
  operational: 'Operational',
  under_maintenance: 'Under Maintenance',
  degraded_performance: 'Degraded Performance',
  partial_outage: 'Partial Outage',
  major_outage: 'Major Outage',
}

const STATUS_GRADIENT_COLORS: Record<string, string> = {
  degraded_performance: 'var(--status-warning)',
  partial_outage: 'var(--brand)',
  major_outage: 'var(--status-danger)',
}

function formatRelative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return `${hours}h ago`
}

interface StatusPillProps {
  label: string
  status: string | undefined
  highlight?: boolean
}

function StatusPill({ label, status, highlight }: StatusPillProps) {
  if (!status) {
    return (
      <div
        className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-surface0/60 bg-surface0/40"
        title={`${label}: status unknown`}
      >
        <div className="w-1.5 h-1.5 rounded-full bg-overlay0" />
        <span className="text-[10px] text-overlay0 font-medium leading-none">{label}</span>
      </div>
    )
  }
  const dot = STATUS_COLORS[status] || 'bg-overlay0'
  const txt = status === 'operational' ? 'text-overlay1' : (STATUS_TEXT_COLORS[status] || 'text-text')
  return (
    <div
      className={`flex items-center gap-1 px-1.5 py-0.5 rounded border ${
        highlight && status !== 'operational'
          ? 'border-current bg-surface0/70'
          : 'border-surface0/60 bg-surface0/40'
      }`}
      title={`${label}: ${STATUS_LONG_LABELS[status] || status}`}
    >
      <div className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      <span className={`text-[10px] font-medium leading-none ${txt}`}>{label}</span>
      {status !== 'operational' && (
        <span className={`text-[10px] font-semibold leading-none ${txt}`}>{STATUS_LABELS[status] || status}</span>
      )}
    </div>
  )
}

export default function TitleBar({ sidebarOpen, onToggleSidebar }: Props) {
  const [maximized, setMaximized] = useState(false)
  const [serviceStatus, setServiceStatus] = useState<ServiceStatusPayload | null>(null)
  // panelOpen drives the open/closed visual state; panelMounted keeps the panel in
  // the DOM through its ~200ms closing transition before unmount (so close is animated).
  const [panelOpen, setPanelOpen] = useState(false)
  const [panelMounted, setPanelMounted] = useState(false)
  const panelCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const openPanel = () => {
    if (panelCloseTimer.current) { clearTimeout(panelCloseTimer.current); panelCloseTimer.current = null }
    setPanelMounted(true)
    setPanelOpen(true)
  }
  const closePanel = () => {
    setPanelOpen(false)
    panelCloseTimer.current = setTimeout(() => { setPanelMounted(false); panelCloseTimer.current = null }, 200)
  }

  useEffect(() => {
    window.electronAPI.window.isMaximized().then(setMaximized)
    const unsub = window.electronAPI.window.onMaximizedChanged(setMaximized)
    return unsub
  }, [])

  useEffect(() => {
    let active = true
    // Seed from the cached payload so the pills appear immediately on mount,
    // rather than staying blank until the next 5-min poll push (the immediate
    // startup poll fires before this subscribes, behind the splash).
    window.electronAPI.serviceStatus.get().then((data: ServiceStatusPayload | null) => {
      if (active && data) setServiceStatus(data)
    })
    const unsub = window.electronAPI.serviceStatus.onUpdate((data: ServiceStatusPayload) => {
      setServiceStatus(data)
    })
    return () => { active = false; unsub() }
  }, [])

  const worst = serviceStatus?.worst || 'operational'
  const isHealthy = !serviceStatus || worst === 'operational'
  const gradientColor = STATUS_GRADIENT_COLORS[worst]
  const apiStatus = serviceStatus?.api?.status
  const tooltipLines: string[] = []
  if (serviceStatus) {
    if (serviceStatus.claudeCode) tooltipLines.push(`Claude Code: ${STATUS_LONG_LABELS[serviceStatus.claudeCode.status] || serviceStatus.claudeCode.status}`)
    if (serviceStatus.claudeAi) tooltipLines.push(`Claude.ai: ${STATUS_LONG_LABELS[serviceStatus.claudeAi.status] || serviceStatus.claudeAi.status}`)
    if (serviceStatus.api) tooltipLines.push(`API: ${STATUS_LONG_LABELS[serviceStatus.api.status] || serviceStatus.api.status}`)
    tooltipLines.push(`Last checked ${formatRelative(serviceStatus.fetchedAt)}`)
  }
  const tooltip = tooltipLines.join(' · ')

  return (
    <div
      className="titlebar-drag flex items-center h-10 px-3 shrink-0 relative"
      style={gradientColor ? {
        background: `linear-gradient(90deg, var(--surface-panel) 0%, ${gradientColor}18 30%, ${gradientColor}25 50%, ${gradientColor}18 70%, var(--surface-panel) 100%)`,
        color: 'var(--text-on-chrome)',
      } : {
        background: 'var(--surface-panel)',
        color: 'var(--text-on-chrome)',
      }}
    >
      <div className="titlebar-no-drag flex items-center gap-1 mr-3">
        <button
          onClick={onToggleSidebar}
          className="p-1.5 rounded hover:bg-surface0 text-overlay1 hover:text-text transition-colors focus-ring"
          title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="1" y="2" width="14" height="12" rx="1" stroke="currentColor" strokeWidth="1.2" />
            <line x1="5.5" y1="2" x2="5.5" y2="14" stroke="currentColor" strokeWidth="1.2" />
          </svg>
        </button>
      </div>

      <div className="flex-1 text-center text-xs text-overlay1 font-medium flex items-center justify-center gap-0">
        <span>Claude Command Center</span>
        {useSettingsStore((s) => s.settings.updateChannel) === 'beta' && (
          <span className="ml-2 px-1.5 py-px rounded-full text-[10px] font-semibold align-middle" style={{ color: 'var(--brand)', background: 'color-mix(in srgb, var(--brand) 16%, transparent)' }}>Beta</span>
        )}
      </div>

      <div className="titlebar-no-drag flex items-center gap-1">
        {/* Conductor services health pill + anchored diagnostics console (D1b) */}
        <div className="relative mr-2">
          <ConductorHealthPill open={panelOpen} onOpen={() => (panelOpen ? closePanel() : openPanel())} />
          {panelMounted && <ConductorServicesPanel open={panelOpen} onClose={closePanel} />}
        </div>
        {/* Claude service status — two pills (Claude Code + Claude.ai) with API in tooltip */}
        {serviceStatus && (
          <div
            className="flex items-center gap-1 mr-2"
            title={tooltip}
          >
            <StatusPill
              label="Code"
              status={serviceStatus.claudeCode?.status}
              highlight={!isHealthy}
            />
            <StatusPill
              label="Claude.ai"
              status={serviceStatus.claudeAi?.status}
              highlight={!isHealthy}
            />
            {apiStatus && apiStatus !== 'operational' && (
              <StatusPill label="API" status={apiStatus} highlight />
            )}
          </div>
        )}
        <SentinelDot />
        <ThemeToggle />
        <button
          onClick={() => window.electronAPI.window.minimize()}
          className="p-2 hover:bg-surface0 rounded transition-colors text-overlay1 hover:text-text focus-ring"
        >
          <svg width="12" height="12" viewBox="0 0 12 12"><line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.2"/></svg>
        </button>
        <button
          onClick={() => window.electronAPI.window.maximize()}
          className="p-2 hover:bg-surface0 rounded transition-colors text-overlay1 hover:text-text focus-ring"
        >
          {maximized ? (
            <svg width="12" height="12" viewBox="0 0 12 12"><rect x="2" y="3.5" width="7" height="7" rx="0.5" stroke="currentColor" strokeWidth="1.2" fill="none"/><path d="M3.5 3.5V2.5C3.5 2.22 3.72 2 4 2H9.5C9.78 2 10 2.22 10 2.5V8C10 8.28 9.78 8.5 9.5 8.5H9" stroke="currentColor" strokeWidth="1.2" fill="none"/></svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1.5" y="1.5" width="9" height="9" rx="0.5" stroke="currentColor" strokeWidth="1.2" fill="none"/></svg>
          )}
        </button>
        <button
          onClick={() => window.electronAPI.window.close()}
          className="p-2 hover:bg-red rounded transition-colors text-overlay1 hover:text-text focus-ring"
        >
          <svg width="12" height="12" viewBox="0 0 12 12"><line x1="2" y1="2" x2="10" y2="10" stroke="currentColor" strokeWidth="1.2"/><line x1="10" y1="2" x2="2" y2="10" stroke="currentColor" strokeWidth="1.2"/></svg>
        </button>
      </div>
    </div>
  )
}
