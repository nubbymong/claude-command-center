import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useCloudAgentStore, setupCloudAgentListener } from '../stores/cloudAgentStore'
import type { CloudAgent, CloudAgentStatus } from '../types/electron'
import NewAgentDialog from './NewAgentDialog'
import AgentLibrary from './AgentLibrary'

const STATUS_COLORS: Record<CloudAgentStatus, string> = {
  running: '#89B4FA',
  pending: '#F9E2AF',
  completed: '#A6E3A1',
  failed: '#F38BA8',
  cancelled: '#F38BA8',
}

const STATUS_LABELS: Record<CloudAgentStatus, string> = {
  running: 'Running',
  pending: 'Starting',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function formatCost(cost?: number): string {
  if (cost == null) return ''
  return `$${cost.toFixed(4)}`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function getElapsed(agent: CloudAgent): string {
  if (agent.duration) return formatDuration(agent.duration)
  if (agent.status === 'running' || agent.status === 'pending') {
    return formatDuration(Date.now() - agent.createdAt)
  }
  return ''
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// --- Context Menu ---

interface ContextMenuState {
  x: number
  y: number
  agentId: string
}

function ContextMenu({ x, y, agent, onClose }: {
  x: number; y: number; agent: CloudAgent; onClose: () => void
}) {
  const cancel = useCloudAgentStore(s => s.cancel)
  const remove = useCloudAgentStore(s => s.remove)
  const retry = useCloudAgentStore(s => s.retry)
  const menuRef = useRef<HTMLDivElement>(null)
  const isRunning = agent.status === 'running' || agent.status === 'pending'

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onClose])

  const menuItems: Array<{ label: string; icon: string; action: () => void; danger?: boolean; disabled?: boolean }> = []

  if (isRunning) {
    menuItems.push({
      label: 'Stop Agent',
      icon: String.fromCodePoint(0x25A0),
      action: () => { cancel(agent.id); onClose() },
      danger: true,
    })
  }

  if (!isRunning) {
    menuItems.push({
      label: 'Retry',
      icon: String.fromCodePoint(0x21BB),
      action: () => { retry(agent.id); onClose() },
    })
  }

  menuItems.push({
    label: 'Copy Output',
    icon: String.fromCodePoint(0x2398),
    action: () => {
      navigator.clipboard.writeText(agent.output || '(no output)')
      onClose()
    },
    disabled: !agent.output,
  })

  menuItems.push({
    label: 'Copy Description',
    icon: String.fromCodePoint(0x270E),
    action: () => {
      navigator.clipboard.writeText(agent.description)
      onClose()
    },
  })

  if (!isRunning) {
    menuItems.push({
      label: 'Remove',
      icon: String.fromCodePoint(0x2715),
      action: () => { remove(agent.id); onClose() },
      danger: true,
    })
  }

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-surface0 border border-surface1 rounded-xl shadow-2xl py-1.5 min-w-[180px]"
      style={{ left: x, top: y }}
    >
      {menuItems.map((item, i) => (
        <button
          key={i}
          onClick={item.action}
          disabled={item.disabled}
          className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2.5 transition-colors ${
            item.disabled
              ? 'text-overlay0 cursor-not-allowed'
              : item.danger
              ? 'text-red hover:bg-red/10'
              : 'text-text hover:bg-surface1'
          }`}
        >
          <span className="w-4 text-center text-[11px]">{item.icon}</span>
          {item.label}
        </button>
      ))}
    </div>
  )
}

// --- Sub-components ---

function FilterChip({ label, count, color, active, onClick }: {
  label: string; count: number; color: string; active: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-full text-[11px] font-medium transition-all ${
        active ? 'text-crust shadow-sm' : 'text-overlay1 hover:text-text'
      }`}
      style={active ? { backgroundColor: color } : { backgroundColor: 'transparent', border: `1px solid ${color}30` }}
    >
      {label} {count}
    </button>
  )
}

function AgentCard({ agent, selected, onClick, onContextMenu }: {
  agent: CloudAgent; selected: boolean; onClick: () => void; onContextMenu: (e: React.MouseEvent) => void
}) {
  const color = STATUS_COLORS[agent.status]
  const isRunning = agent.status === 'running' || agent.status === 'pending'
  const [elapsed, setElapsed] = useState(getElapsed(agent))

  useEffect(() => {
    if (!isRunning) {
      setElapsed(getElapsed(agent))
      return
    }
    setElapsed(getElapsed(agent))
    const interval = setInterval(() => setElapsed(getElapsed(agent)), 1000)
    return () => clearInterval(interval)
  }, [agent.status, agent.createdAt, agent.duration])

  const projectName = agent.projectPath.split(/[/\\]/).filter(Boolean).pop() || agent.projectPath
  const outputSize = agent.output ? agent.output.length : 0

  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      className={`w-full text-left rounded-xl p-3 transition-all duration-150 border group ${
        selected
          ? 'bg-surface0/60 border-sapphire/30'
          : 'bg-mantle/30 border-transparent hover:bg-surface0/30 hover:border-surface0/60'
      }`}
    >
      {/* Row 1: Status dot + name + elapsed */}
      <div className="flex items-center gap-2 mb-1">
        <span
          className={`w-2.5 h-2.5 rounded-full shrink-0 ${isRunning ? 'animate-pulse' : ''}`}
          style={{ backgroundColor: color, boxShadow: isRunning ? `0 0 8px 2px ${color}60` : undefined }}
        />
        <span className="text-sm font-medium text-text truncate flex-1">{agent.name}</span>
        {elapsed && (
          <span className="text-[10px] text-overlay0 shrink-0 tabular-nums">{elapsed}</span>
        )}
      </div>

      {/* Row 2: Description */}
      <div className="pl-[18px] text-[11px] text-overlay1 truncate mb-1">{agent.description}</div>

      {/* Row 3: Status + project + output + cost */}
      <div className="flex items-center gap-1.5 pl-[18px] text-[10px] text-overlay0">
        <span className="capitalize" style={{ color }}>{STATUS_LABELS[agent.status]}</span>
        <span>{String.fromCodePoint(0x00B7)}</span>
        <span className="truncate max-w-[120px]">{projectName}</span>
        {outputSize > 0 && (
          <>
            <span>{String.fromCodePoint(0x00B7)}</span>
            <span>{formatBytes(outputSize)}</span>
          </>
        )}
        {agent.cost != null && (
          <>
            <span>{String.fromCodePoint(0x00B7)}</span>
            <span>{formatCost(agent.cost)}</span>
          </>
        )}
      </div>

      {/* Running progress bar */}
      {isRunning && (
        <div className="mt-2 ml-[18px] h-[2px] rounded-full bg-surface1 overflow-hidden">
          <div className="h-full rounded-full animate-pulse" style={{ backgroundColor: color, width: '60%' }} />
        </div>
      )}
    </button>
  )
}

function OutputTab({ agent }: { agent: CloudAgent }) {
  const preRef = useRef<HTMLPreElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)
  const [copied, setCopied] = useState(false)
  const isRunning = agent.status === 'running' || agent.status === 'pending'

  useEffect(() => {
    if (autoScroll && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight
    }
  }, [agent.output, autoScroll])

  const handleScroll = () => {
    if (!preRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = preRef.current
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50)
  }

  const handleCopy = () => {
    navigator.clipboard.writeText(agent.output || '')
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const outputSize = agent.output ? agent.output.length : 0

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 mb-2 px-1">
        <span className="text-[10px] text-overlay0 flex-1">
          {outputSize > 0 ? formatBytes(outputSize) : ''}
          {isRunning && outputSize === 0 && (
            <span className="inline-flex items-center gap-1.5">
              <span className="animate-pulse">Waiting for output</span>
              <span className="inline-block w-1.5 h-1.5 rounded-full bg-sapphire animate-ping" />
            </span>
          )}
        </span>
        {outputSize > 0 && (
          <button
            onClick={handleCopy}
            className="text-[10px] text-overlay0 hover:text-text transition-colors px-2 py-0.5 rounded-md hover:bg-surface0/50"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        )}
        {!autoScroll && (
          <button
            onClick={() => {
              setAutoScroll(true)
              if (preRef.current) preRef.current.scrollTop = preRef.current.scrollHeight
            }}
            className="text-[10px] text-sapphire hover:text-sapphire/80 transition-colors px-2 py-0.5 rounded-md hover:bg-surface0/50"
          >
            Scroll to bottom
          </button>
        )}
      </div>

      {/* Content */}
      <pre
        ref={preRef}
        onScroll={handleScroll}
        className="flex-1 bg-crust/60 rounded-xl p-4 text-xs text-text font-mono overflow-auto whitespace-pre-wrap break-words border border-surface0/30"
      >
        {agent.output ? (
          agent.output
        ) : isRunning ? (
          <span className="text-overlay0 flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-sapphire animate-pulse" />
            Agent is running... output will stream here in real-time
          </span>
        ) : (
          <span className="text-overlay0">No output captured</span>
        )}
      </pre>
    </div>
  )
}

function SummaryTab({ agent }: { agent: CloudAgent }) {
  const isRunning = agent.status === 'running' || agent.status === 'pending'

  return (
    <div className="flex-1 overflow-auto space-y-4 p-1">
      {/* Description */}
      <div>
        <div className="text-[10px] text-subtext0 uppercase tracking-wider font-semibold mb-1.5">Description / Prompt</div>
        <div className="text-sm text-text bg-crust/60 rounded-xl p-3.5 whitespace-pre-wrap border border-surface0/30">{agent.description}</div>
      </div>

      {/* Status grid */}
      <div className="grid grid-cols-2 gap-2.5">
        <InfoCell label="Status">
          <div className="flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${isRunning ? 'animate-pulse' : ''}`} style={{ backgroundColor: STATUS_COLORS[agent.status] }} />
            <span className="capitalize">{STATUS_LABELS[agent.status]}</span>
          </div>
        </InfoCell>
        <InfoCell label="Duration">
          <span className="tabular-nums">{getElapsed(agent) || (isRunning ? 'Just started...' : '-')}</span>
        </InfoCell>
        <InfoCell label="Project Path">
          <span className="truncate" title={agent.projectPath}>{agent.projectPath}</span>
        </InfoCell>
        <InfoCell label="Created">
          {formatTimestamp(agent.createdAt)}
        </InfoCell>
        <InfoCell label="Output Size">
          {agent.output ? formatBytes(agent.output.length) : '-'}
        </InfoCell>
        <InfoCell label="Agent ID">
          <span className="font-mono text-[10px]">{agent.id}</span>
        </InfoCell>
      </div>

      {/* Cost & Tokens */}
      {(agent.cost != null || agent.tokenUsage) && (
        <div>
          <div className="text-[10px] text-subtext0 uppercase tracking-wider font-semibold mb-1.5">Usage</div>
          <div className="flex gap-2.5">
            {agent.cost != null && (
              <div className="text-xs text-text bg-crust/60 rounded-lg px-3 py-2 border border-surface0/30">
                Cost: <span className="text-green font-medium">{formatCost(agent.cost)}</span>
              </div>
            )}
            {agent.tokenUsage && (
              <div className="text-xs text-text bg-crust/60 rounded-lg px-3 py-2 border border-surface0/30 tabular-nums">
                {agent.tokenUsage.inputTokens.toLocaleString()} in / {agent.tokenUsage.outputTokens.toLocaleString()} out
              </div>
            )}
          </div>
        </div>
      )}

      {/* Error */}
      {agent.error && (
        <div>
          <div className="text-[10px] text-red uppercase tracking-wider font-semibold mb-1.5">Error</div>
          <div className="text-xs text-red bg-red/8 rounded-xl px-3.5 py-2.5 font-mono border border-red/15">{agent.error}</div>
        </div>
      )}
    </div>
  )
}

function InfoCell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="bg-crust/60 rounded-lg px-3 py-2 border border-surface0/30">
      <div className="text-[10px] text-subtext0 mb-0.5">{label}</div>
      <div className="text-xs text-text">{children}</div>
    </div>
  )
}

function AgentDetail({ agent }: { agent: CloudAgent }) {
  const [tab, setTab] = useState<'output' | 'summary'>('output')
  const cancel = useCloudAgentStore(s => s.cancel)
  const remove = useCloudAgentStore(s => s.remove)
  const retry = useCloudAgentStore(s => s.retry)
  const isRunning = agent.status === 'running' || agent.status === 'pending'

  return (
    <div className="flex-1 flex flex-col min-h-0 p-4">
      {/* Header */}
      <div className="mb-3">
        <div className="flex items-center gap-2.5 mb-1">
          <span
            className={`w-3 h-3 rounded-full shrink-0 ${isRunning ? 'animate-pulse' : ''}`}
            style={{ backgroundColor: STATUS_COLORS[agent.status], boxShadow: isRunning ? `0 0 8px 2px ${STATUS_COLORS[agent.status]}60` : undefined }}
          />
          <h2 className="text-lg font-semibold text-text truncate flex-1">{agent.name}</h2>
          <div className="flex gap-1.5 shrink-0">
            {isRunning && (
              <button
                onClick={() => cancel(agent.id)}
                className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-red/10 text-red hover:bg-red/20 transition-colors border border-red/20"
              >
                Stop
              </button>
            )}
            {!isRunning && (
              <>
                <button
                  onClick={() => retry(agent.id)}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-sapphire/10 text-sapphire hover:bg-sapphire/20 transition-colors border border-sapphire/20"
                >
                  Retry
                </button>
                <button
                  onClick={() => remove(agent.id)}
                  className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-surface0/50 text-overlay1 hover:bg-surface1 hover:text-text transition-colors border border-surface0/60"
                >
                  Remove
                </button>
              </>
            )}
          </div>
        </div>
        <div className="text-xs text-overlay0 pl-[22px] flex items-center gap-1.5">
          <span style={{ color: STATUS_COLORS[agent.status] }}>{STATUS_LABELS[agent.status]}</span>
          {getElapsed(agent) && (
            <><span>{String.fromCodePoint(0x00B7)}</span><span className="tabular-nums">{getElapsed(agent)}</span></>
          )}
          {agent.projectPath && (
            <><span>{String.fromCodePoint(0x00B7)}</span><span className="truncate max-w-[200px]" title={agent.projectPath}>{agent.projectPath.split(/[/\\]/).filter(Boolean).pop()}</span></>
          )}
          {agent.cost != null && (
            <><span>{String.fromCodePoint(0x00B7)}</span><span className="text-green">{formatCost(agent.cost)}</span></>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-0.5 mb-3 bg-crust/50 rounded-lg p-0.5 self-start">
        <button
          onClick={() => setTab('output')}
          className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
            tab === 'output' ? 'bg-surface0 text-text shadow-sm' : 'text-overlay1 hover:text-text'
          }`}
        >
          Output
          {agent.output && <span className="ml-1 text-overlay0">({formatBytes(agent.output.length)})</span>}
        </button>
        <button
          onClick={() => setTab('summary')}
          className={`px-3 py-1 rounded-md text-xs font-medium transition-all ${
            tab === 'summary' ? 'bg-surface0 text-text shadow-sm' : 'text-overlay1 hover:text-text'
          }`}
        >
          Summary
        </button>
      </div>

      {tab === 'output' ? <OutputTab agent={agent} /> : <SummaryTab agent={agent} />}
    </div>
  )
}

// --- Main Page ---

type HubTab = 'tasks' | 'library'

export default function CloudAgentsPage() {
  const [hubTab, setHubTab] = useState<HubTab>('tasks')
  const allAgents = useCloudAgentStore(s => s.agents)
  const selectedAgentId = useCloudAgentStore(s => s.selectedAgentId)
  const selectAgent = useCloudAgentStore(s => s.selectAgent)
  const filter = useCloudAgentStore(s => s.filter)
  const setFilter = useCloudAgentStore(s => s.setFilter)
  const searchQuery = useCloudAgentStore(s => s.searchQuery)
  const setSearchQuery = useCloudAgentStore(s => s.setSearchQuery)
  const clearCompleted = useCloudAgentStore(s => s.clearCompleted)
  const [showNewDialog, setShowNewDialog] = useState(false)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  const agents = useMemo(() => {
    return useCloudAgentStore.getState().getFilteredAgents()
  }, [allAgents, filter, searchQuery])

  const counts = useMemo(() => {
    return useCloudAgentStore.getState().getCounts()
  }, [allAgents])

  const selectedAgent = allAgents.find(a => a.id === selectedAgentId) || null

  useEffect(() => {
    const cleanup = setupCloudAgentListener()
    return cleanup
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && contextMenu) {
        setContextMenu(null)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [contextMenu])

  const handleCardContextMenu = useCallback((e: React.MouseEvent, agentId: string) => {
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY, agentId })
  }, [])

  const contextMenuAgent = contextMenu ? allAgents.find(a => a.id === contextMenu.agentId) : null

  if (hubTab === 'library') {
    return (
      <div className="flex-1 flex flex-col bg-base overflow-hidden">
        {/* Hub tab bar */}
        <div className="px-5 pt-3 bg-mantle/30 shrink-0">
          <div className="flex gap-0.5 bg-crust/50 rounded-lg p-0.5 self-start w-fit">
            <button
              onClick={() => setHubTab('tasks')}
              className={`px-4 py-1.5 rounded-md text-xs font-medium transition-all ${
                hubTab === 'tasks' ? 'bg-surface0 text-text shadow-sm' : 'text-overlay1 hover:text-text'
              }`}
            >
              Tasks
            </button>
            <button
              onClick={() => setHubTab('library')}
              className={`px-4 py-1.5 rounded-md text-xs font-medium transition-all ${
                hubTab === 'library' ? 'bg-surface0 text-text shadow-sm' : 'text-overlay1 hover:text-text'
              }`}
            >
              Agent Library
            </button>
          </div>
        </div>
        <AgentLibrary />
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col bg-base overflow-hidden">
      {/* Page header */}
      <div className="px-5 pt-4 pb-3 border-b border-surface0/80 bg-mantle/30 shrink-0">
        {/* Hub tab bar */}
        <div className="flex gap-0.5 bg-crust/50 rounded-lg p-0.5 self-start w-fit mb-3">
          <button
            onClick={() => setHubTab('tasks')}
            className={`px-4 py-1.5 rounded-md text-xs font-medium transition-all ${
              hubTab === 'tasks' ? 'bg-surface0 text-text shadow-sm' : 'text-overlay1 hover:text-text'
            }`}
          >
            Tasks
          </button>
          <button
            onClick={() => setHubTab('library')}
            className={`px-4 py-1.5 rounded-md text-xs font-medium transition-all ${
              hubTab === 'library' ? 'bg-surface0 text-text shadow-sm' : 'text-overlay1 hover:text-text'
            }`}
          >
            Agent Library
          </button>
        </div>
        <div className="flex items-center gap-3 mb-3">
          <div className="w-8 h-8 rounded-lg bg-sapphire/10 flex items-center justify-center shrink-0">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-sapphire">
              <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2.5">
              <h1 className="text-base font-semibold text-text">Agent Hub</h1>
              {counts.running > 0 && (
                <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium text-crust" style={{ backgroundColor: '#89B4FA' }}>
                  <span className="w-1.5 h-1.5 rounded-full bg-crust animate-pulse" />
                  {counts.running} running
                </span>
              )}
            </div>
            <p className="text-[11px] text-overlay0 mt-0.5">Headless Claude CLI background tasks</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {counts.completed + counts.failed > 0 && (
              <button
                onClick={() => clearCompleted()}
                className="text-[11px] text-overlay1 hover:text-text px-2.5 py-1 rounded-lg hover:bg-surface0/50 transition-colors"
              >
                Clear done
              </button>
            )}
            <button
              onClick={() => setShowNewDialog(true)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-sapphire hover:bg-sapphire/85 text-crust transition-colors flex items-center gap-1.5 shadow-sm"
            >
              <svg width="12" height="12" viewBox="0 0 12 12"><line x1="6" y1="1" x2="6" y2="11" stroke="currentColor" strokeWidth="1.5"/><line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.5"/></svg>
              New Agent
            </button>
          </div>
        </div>

        {/* Filter chips + search */}
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            <FilterChip label="All" count={counts.all} color="#b8c5d6" active={filter === 'all'} onClick={() => setFilter('all')} />
            <FilterChip label="Running" count={counts.running} color="#89B4FA" active={filter === 'running'} onClick={() => setFilter('running')} />
            <FilterChip label="Done" count={counts.completed} color="#A6E3A1" active={filter === 'completed'} onClick={() => setFilter('completed')} />
            <FilterChip label="Failed" count={counts.failed} color="#F38BA8" active={filter === 'failed'} onClick={() => setFilter('failed')} />
          </div>
          <div className="flex-1" />
          <div className="relative">
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search agents..."
              className="bg-surface0/40 border border-surface0/80 rounded-lg px-3 py-1.5 text-xs text-text placeholder:text-overlay0 outline-none focus:border-blue/40 w-44 transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-overlay0 hover:text-text transition-colors"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Split panel */}
      <div className="flex-1 flex overflow-hidden border-t border-surface0/40">
        {/* Left: Agent list */}
        <div className="w-[40%] border-r border-surface0/40 overflow-y-auto p-3 space-y-1.5">
          {agents.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center py-16 text-center">
              <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-surface0/30 flex items-center justify-center">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" className="text-overlay0">
                  <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
                </svg>
              </div>
              <p className="text-sm text-subtext1 font-medium mb-1">
                {filter !== 'all' || searchQuery ? 'No matching agents' : 'No agents yet'}
              </p>
              <p className="text-xs text-overlay0 mb-4 max-w-[200px]">
                {filter !== 'all' || searchQuery
                  ? 'Try a different filter or search term'
                  : 'Dispatch a cloud agent to run headless Claude tasks'}
              </p>
              {filter === 'all' && !searchQuery && (
                <button
                  onClick={() => setShowNewDialog(true)}
                  className="px-4 py-2 rounded-lg text-xs font-medium bg-sapphire hover:bg-sapphire/85 text-crust transition-colors"
                >
                  + New Agent
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="text-[10px] text-overlay0 px-1.5 mb-1 flex items-center justify-between">
                <span>{agents.length} agent{agents.length !== 1 ? 's' : ''} {filter !== 'all' ? `(${filter})` : ''}</span>
                <span className="text-overlay0/50">Right-click for actions</span>
              </div>
              {agents.map(agent => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  selected={agent.id === selectedAgentId}
                  onClick={() => selectAgent(agent.id)}
                  onContextMenu={(e) => handleCardContextMenu(e, agent.id)}
                />
              ))}
            </>
          )}
        </div>

        {/* Right: Detail view */}
        <div className="flex-1 flex flex-col min-h-0">
          {selectedAgent ? (
            <AgentDetail agent={selectedAgent} />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center">
                <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-surface0/30 flex items-center justify-center">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" className="text-overlay0">
                    <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
                    <polyline points="8 14 12 10 16 14" />
                  </svg>
                </div>
                <p className="text-sm text-subtext1 font-medium mb-1">Select an agent</p>
                <p className="text-[11px] text-overlay0">Click an agent card or right-click for actions</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Context menu */}
      {contextMenu && contextMenuAgent && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          agent={contextMenuAgent}
          onClose={() => setContextMenu(null)}
        />
      )}

      {showNewDialog && <NewAgentDialog onClose={() => setShowNewDialog(false)} />}
    </div>
  )
}
