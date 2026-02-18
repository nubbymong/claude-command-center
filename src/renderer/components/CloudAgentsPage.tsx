import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useCloudAgentStore, setupCloudAgentListener } from '../stores/cloudAgentStore'
import type { CloudAgent, CloudAgentStatus } from '../types/electron'
import NewAgentDialog from './NewAgentDialog'

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
      icon: '\u25A0', // square stop
      action: () => { cancel(agent.id); onClose() },
      danger: true,
    })
  }

  if (!isRunning) {
    menuItems.push({
      label: 'Retry',
      icon: '\u21BB', // refresh
      action: () => { retry(agent.id); onClose() },
    })
  }

  menuItems.push({
    label: 'Copy Output',
    icon: '\u2398', // clipboard
    action: () => {
      navigator.clipboard.writeText(agent.output || '(no output)')
      onClose()
    },
    disabled: !agent.output,
  })

  menuItems.push({
    label: 'Copy Description',
    icon: '\u270E', // pencil
    action: () => {
      navigator.clipboard.writeText(agent.description)
      onClose()
    },
  })

  if (!isRunning) {
    menuItems.push({
      label: 'Remove',
      icon: '\u2715', // x
      action: () => { remove(agent.id); onClose() },
      danger: true,
    })
  }

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-surface0 border border-surface1 rounded-lg shadow-xl py-1 min-w-[180px]"
      style={{ left: x, top: y }}
    >
      {menuItems.map((item, i) => (
        <button
          key={i}
          onClick={item.action}
          disabled={item.disabled}
          className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 transition-colors ${
            item.disabled
              ? 'text-overlay0 cursor-not-allowed'
              : item.danger
              ? 'text-red hover:bg-red/10'
              : 'text-text hover:bg-surface1'
          }`}
        >
          <span className="w-4 text-center">{item.icon}</span>
          {item.label}
        </button>
      ))}
    </div>
  )
}

// --- Sub-components ---

function StatBadge({ label, count, color, active, onClick }: {
  label: string; count: number; color: string; active: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
        active ? 'text-crust' : 'text-overlay1 hover:text-text'
      }`}
      style={active ? { backgroundColor: color } : { backgroundColor: 'transparent', border: `1px solid ${color}40` }}
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
      className={`w-full text-left rounded-lg p-3 transition-all duration-150 border group ${
        selected
          ? 'bg-surface0 border-blue/40'
          : 'bg-mantle border-transparent hover:bg-surface0/50 hover:border-surface1'
      }`}
    >
      {/* Row 1: Status dot + name + elapsed badge */}
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

      {/* Row 2: Description snippet */}
      <div className="pl-4.5 text-[11px] text-overlay1 truncate mb-1">{agent.description}</div>

      {/* Row 3: Status + project + output size + cost */}
      <div className="flex items-center gap-1.5 pl-4.5 text-[10px] text-overlay0">
        <span className="capitalize" style={{ color }}>{STATUS_LABELS[agent.status]}</span>
        <span>{'·'}</span>
        <span className="truncate max-w-[120px]">{projectName}</span>
        {outputSize > 0 && (
          <>
            <span>{'·'}</span>
            <span>{formatBytes(outputSize)}</span>
          </>
        )}
        {agent.cost != null && (
          <>
            <span>{'·'}</span>
            <span>{formatCost(agent.cost)}</span>
          </>
        )}
      </div>

      {/* Running progress bar */}
      {isRunning && (
        <div className="mt-2 ml-4.5 h-[2px] rounded-full bg-surface1 overflow-hidden">
          <div className="h-full rounded-full animate-pulse" style={{ backgroundColor: color, width: '60%', animation: 'pulse 2s ease-in-out infinite' }} />
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
      {/* Output toolbar */}
      <div className="flex items-center gap-2 mb-2 px-1">
        <span className="text-[10px] text-overlay0 flex-1">
          {outputSize > 0 ? formatBytes(outputSize) : ''}
          {isRunning && outputSize === 0 && (
            <span className="inline-flex items-center gap-1">
              <span className="animate-pulse">Waiting for output</span>
              <span className="inline-block w-1 h-1 rounded-full bg-blue animate-ping" />
            </span>
          )}
        </span>
        {outputSize > 0 && (
          <button
            onClick={handleCopy}
            className="text-[10px] text-overlay0 hover:text-text transition-colors px-1.5 py-0.5 rounded hover:bg-surface0"
            title="Copy output to clipboard"
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
            className="text-[10px] text-blue hover:text-blue/80 transition-colors px-1.5 py-0.5 rounded hover:bg-surface0"
          >
            Scroll to bottom
          </button>
        )}
      </div>

      {/* Output content */}
      <pre
        ref={preRef}
        onScroll={handleScroll}
        className="flex-1 bg-crust rounded-lg p-4 text-xs text-text font-mono overflow-auto whitespace-pre-wrap break-words"
      >
        {agent.output ? (
          agent.output
        ) : isRunning ? (
          <span className="text-overlay0 flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-blue animate-pulse" />
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
        <div className="text-xs text-subtext0 mb-1">Description / Prompt</div>
        <div className="text-sm text-text bg-crust rounded-lg p-3 whitespace-pre-wrap">{agent.description}</div>
      </div>

      {/* Status grid */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-xs text-subtext0 mb-1">Status</div>
          <div className="text-xs text-text bg-crust rounded px-2 py-1.5 capitalize flex items-center gap-1.5">
            <span className={`w-2 h-2 rounded-full ${isRunning ? 'animate-pulse' : ''}`} style={{ backgroundColor: STATUS_COLORS[agent.status] }} />
            {STATUS_LABELS[agent.status]}
          </div>
        </div>
        <div>
          <div className="text-xs text-subtext0 mb-1">Duration</div>
          <div className="text-xs text-text bg-crust rounded px-2 py-1.5 tabular-nums">{getElapsed(agent) || (isRunning ? 'Just started...' : '-')}</div>
        </div>
        <div>
          <div className="text-xs text-subtext0 mb-1">Project Path</div>
          <div className="text-xs text-text bg-crust rounded px-2 py-1.5 truncate" title={agent.projectPath}>{agent.projectPath}</div>
        </div>
        <div>
          <div className="text-xs text-subtext0 mb-1">Created</div>
          <div className="text-xs text-text bg-crust rounded px-2 py-1.5">{formatTimestamp(agent.createdAt)}</div>
        </div>
        <div>
          <div className="text-xs text-subtext0 mb-1">Output Size</div>
          <div className="text-xs text-text bg-crust rounded px-2 py-1.5">{agent.output ? formatBytes(agent.output.length) : '-'}</div>
        </div>
        <div>
          <div className="text-xs text-subtext0 mb-1">Agent ID</div>
          <div className="text-xs text-text bg-crust rounded px-2 py-1.5 font-mono text-[10px]">{agent.id}</div>
        </div>
      </div>

      {/* Cost & Tokens */}
      {(agent.cost != null || agent.tokenUsage) && (
        <div>
          <div className="text-xs text-subtext0 mb-1">Usage</div>
          <div className="flex gap-3">
            {agent.cost != null && (
              <div className="text-xs text-text bg-crust rounded px-2 py-1.5">
                Cost: <span className="text-green font-medium">{formatCost(agent.cost)}</span>
              </div>
            )}
            {agent.tokenUsage && (
              <div className="text-xs text-text bg-crust rounded px-2 py-1.5">
                {agent.tokenUsage.inputTokens.toLocaleString()} in / {agent.tokenUsage.outputTokens.toLocaleString()} out
              </div>
            )}
          </div>
        </div>
      )}

      {/* Error */}
      {agent.error && (
        <div>
          <div className="text-xs text-red mb-1">Error</div>
          <div className="text-xs text-red bg-red/10 rounded-lg px-3 py-2 font-mono">{agent.error}</div>
        </div>
      )}
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
        <div className="flex items-center gap-2 mb-1">
          <span
            className={`w-3 h-3 rounded-full shrink-0 ${isRunning ? 'animate-pulse' : ''}`}
            style={{ backgroundColor: STATUS_COLORS[agent.status], boxShadow: isRunning ? `0 0 8px 2px ${STATUS_COLORS[agent.status]}60` : undefined }}
          />
          <h2 className="text-lg font-semibold text-text truncate flex-1">{agent.name}</h2>
          {/* Inline action buttons */}
          <div className="flex gap-1.5 shrink-0">
            {isRunning && (
              <button
                onClick={() => cancel(agent.id)}
                className="px-2.5 py-1 rounded text-[11px] font-medium bg-red/10 text-red hover:bg-red/20 transition-colors"
                title="Stop this agent"
              >
                Stop
              </button>
            )}
            {!isRunning && (
              <>
                <button
                  onClick={() => retry(agent.id)}
                  className="px-2.5 py-1 rounded text-[11px] font-medium bg-blue/10 text-blue hover:bg-blue/20 transition-colors"
                  title="Retry with same prompt"
                >
                  Retry
                </button>
                <button
                  onClick={() => remove(agent.id)}
                  className="px-2.5 py-1 rounded text-[11px] font-medium bg-surface1 text-overlay1 hover:bg-surface2 hover:text-text transition-colors"
                  title="Remove this agent"
                >
                  Remove
                </button>
              </>
            )}
          </div>
        </div>
        <div className="text-xs text-overlay0 pl-5 flex items-center gap-1.5">
          <span style={{ color: STATUS_COLORS[agent.status] }}>{STATUS_LABELS[agent.status]}</span>
          {getElapsed(agent) && (
            <><span>{'·'}</span><span className="tabular-nums">{getElapsed(agent)}</span></>
          )}
          {agent.projectPath && (
            <><span>{'·'}</span><span className="truncate max-w-[200px]" title={agent.projectPath}>{agent.projectPath.split(/[/\\]/).filter(Boolean).pop()}</span></>
          )}
          {agent.cost != null && (
            <><span>{'·'}</span><span className="text-green">{formatCost(agent.cost)}</span></>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 mb-3">
        <button
          onClick={() => setTab('output')}
          className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
            tab === 'output' ? 'bg-blue text-crust' : 'text-overlay1 hover:text-text hover:bg-surface0'
          }`}
        >
          Output
          {agent.output && <span className="ml-1 opacity-60">({formatBytes(agent.output.length)})</span>}
        </button>
        <button
          onClick={() => setTab('summary')}
          className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
            tab === 'summary' ? 'bg-blue text-crust' : 'text-overlay1 hover:text-text hover:bg-surface0'
          }`}
        >
          Summary
        </button>
      </div>

      {/* Tab content */}
      {tab === 'output' ? <OutputTab agent={agent} /> : <SummaryTab agent={agent} />}
    </div>
  )
}

// --- Main Page ---

export default function CloudAgentsPage() {
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

  // Setup IPC listeners on first mount
  useEffect(() => {
    const cleanup = setupCloudAgentListener()
    return cleanup
  }, [])

  // Keyboard shortcuts
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

  return (
    <div className="flex-1 flex flex-col bg-base overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-5 pb-3">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-text">Cloud Agents</h1>
            {counts.running > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-medium text-crust flex items-center gap-1" style={{ backgroundColor: '#89B4FA' }}>
                <span className="w-1.5 h-1.5 rounded-full bg-crust animate-pulse" />
                {counts.running} running
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {counts.completed + counts.failed > 0 && (
              <button
                onClick={() => clearCompleted()}
                className="text-[10px] text-overlay0 hover:text-text transition-colors px-2 py-1 rounded hover:bg-surface0"
                title="Clear completed & failed agents"
              >
                Clear done
              </button>
            )}
            <button
              onClick={() => setShowNewDialog(true)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue hover:bg-blue/80 text-crust transition-colors flex items-center gap-1.5"
            >
              <svg width="12" height="12" viewBox="0 0 12 12"><line x1="6" y1="1" x2="6" y2="11" stroke="currentColor" strokeWidth="1.5"/><line x1="1" y1="6" x2="11" y2="6" stroke="currentColor" strokeWidth="1.5"/></svg>
              New Agent
            </button>
          </div>
        </div>

        {/* Filter tabs + search */}
        <div className="flex items-center gap-2">
          <div className="flex gap-1">
            <StatBadge label="All" count={counts.all} color="#CDD6F4" active={filter === 'all'} onClick={() => setFilter('all')} />
            <StatBadge label="Running" count={counts.running} color="#89B4FA" active={filter === 'running'} onClick={() => setFilter('running')} />
            <StatBadge label="Done" count={counts.completed} color="#A6E3A1" active={filter === 'completed'} onClick={() => setFilter('completed')} />
            <StatBadge label="Failed" count={counts.failed} color="#F38BA8" active={filter === 'failed'} onClick={() => setFilter('failed')} />
          </div>
          <div className="flex-1" />
          <div className="relative">
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search agents..."
              className="bg-surface0 border border-surface1 rounded px-3 py-1 text-xs text-text placeholder:text-overlay0 outline-none focus:border-blue w-44"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-overlay0 hover:text-text"
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5"><line x1="2" y1="2" x2="8" y2="8"/><line x1="8" y1="2" x2="2" y2="8"/></svg>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Split panel */}
      <div className="flex-1 flex overflow-hidden border-t border-surface0">
        {/* Left panel: Task list */}
        <div className="w-[40%] border-r border-surface0 overflow-y-auto p-3 space-y-1.5">
          {agents.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center py-16 text-center">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto text-overlay0 mb-3">
                <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
              </svg>
              <p className="text-sm text-overlay1 mb-1">
                {filter !== 'all' || searchQuery ? 'No matching agents' : 'No agents yet'}
              </p>
              <p className="text-xs text-overlay0 mb-4">
                {filter !== 'all' || searchQuery
                  ? 'Try a different filter or search term'
                  : 'Dispatch a cloud agent to run headless Claude tasks'}
              </p>
              {filter === 'all' && !searchQuery && (
                <button
                  onClick={() => setShowNewDialog(true)}
                  className="px-4 py-2 rounded-lg text-xs font-medium bg-blue hover:bg-blue/80 text-crust transition-colors"
                >
                  + New Agent
                </button>
              )}
            </div>
          ) : (
            <>
              <div className="text-[10px] text-overlay0 px-1 mb-1">
                {agents.length} agent{agents.length !== 1 ? 's' : ''} {filter !== 'all' ? `(${filter})` : ''}
                <span className="float-right">Right-click for actions</span>
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

        {/* Right panel: Detail view */}
        <div className="flex-1 flex flex-col min-h-0">
          {selectedAgent ? (
            <AgentDetail agent={selectedAgent} />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center text-overlay0">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" className="mx-auto mb-2 text-overlay0">
                  <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
                  <polyline points="8 14 12 10 16 14" />
                </svg>
                <p className="text-sm mb-1">Select an agent to view details</p>
                <p className="text-[10px] text-overlay0">Or right-click for quick actions</p>
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

      {/* New Agent Dialog */}
      {showNewDialog && <NewAgentDialog onClose={() => setShowNewDialog(false)} />}
    </div>
  )
}
