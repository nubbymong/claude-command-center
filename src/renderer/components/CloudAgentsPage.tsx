import React, { useState, useEffect, useRef, useMemo } from 'react'
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

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return `${h}h ${m % 60}m`
}

function formatCost(cost?: number): string {
  if (cost == null) return ''
  return `$${cost.toFixed(2)}`
}

function getElapsed(agent: CloudAgent): string {
  if (agent.duration) return formatDuration(agent.duration)
  if (agent.status === 'running' || agent.status === 'pending') {
    return formatDuration(Date.now() - agent.createdAt)
  }
  return ''
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

function AgentCard({ agent, selected, onClick }: {
  agent: CloudAgent; selected: boolean; onClick: () => void
}) {
  const color = STATUS_COLORS[agent.status]
  const isRunning = agent.status === 'running' || agent.status === 'pending'
  const [elapsed, setElapsed] = useState(getElapsed(agent))

  // Update elapsed time for running agents
  useEffect(() => {
    if (!isRunning) {
      setElapsed(getElapsed(agent))
      return
    }
    const interval = setInterval(() => setElapsed(getElapsed(agent)), 1000)
    return () => clearInterval(interval)
  }, [agent.status, agent.createdAt, agent.duration])

  // Get short project name from path
  const projectName = agent.projectPath.split(/[/\\]/).filter(Boolean).pop() || agent.projectPath

  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-lg p-3 transition-all duration-150 border ${
        selected
          ? 'bg-surface0 border-blue/40'
          : 'bg-mantle border-transparent hover:bg-surface0/50 hover:border-surface1'
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        <span
          className={`w-2.5 h-2.5 rounded-full shrink-0 ${isRunning ? 'animate-pulse' : ''}`}
          style={{ backgroundColor: color, boxShadow: isRunning ? `0 0 8px 2px ${color}60` : undefined }}
        />
        <span className="text-sm font-medium text-text truncate flex-1">{agent.name}</span>
      </div>
      <div className="flex items-center gap-2 pl-4.5 text-[11px] text-overlay0">
        <span className="capitalize">{agent.status}</span>
        {elapsed && (
          <>
            <span>{'·'}</span>
            <span>{elapsed}</span>
          </>
        )}
        {agent.cost != null && (
          <>
            <span>{'·'}</span>
            <span>{formatCost(agent.cost)}</span>
          </>
        )}
      </div>
      <div className="mt-1 pl-4.5 text-[10px] text-overlay0 truncate">{projectName}</div>
    </button>
  )
}

function OutputTab({ output }: { output: string }) {
  const preRef = useRef<HTMLPreElement>(null)
  const [autoScroll, setAutoScroll] = useState(true)

  useEffect(() => {
    if (autoScroll && preRef.current) {
      preRef.current.scrollTop = preRef.current.scrollHeight
    }
  }, [output, autoScroll])

  const handleScroll = () => {
    if (!preRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = preRef.current
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50)
  }

  return (
    <pre
      ref={preRef}
      onScroll={handleScroll}
      className="flex-1 bg-crust rounded-lg p-4 text-xs text-text font-mono overflow-auto whitespace-pre-wrap break-words"
    >
      {output || <span className="text-overlay0">No output yet...</span>}
    </pre>
  )
}

function SummaryTab({ agent }: { agent: CloudAgent }) {
  return (
    <div className="flex-1 overflow-auto space-y-4 p-1">
      <div>
        <div className="text-xs text-subtext0 mb-1">Description</div>
        <div className="text-sm text-text bg-crust rounded-lg p-3 whitespace-pre-wrap">{agent.description}</div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-xs text-subtext0 mb-1">Project Path</div>
          <div className="text-xs text-text bg-crust rounded px-2 py-1.5 truncate">{agent.projectPath}</div>
        </div>
        <div>
          <div className="text-xs text-subtext0 mb-1">Status</div>
          <div className="text-xs text-text bg-crust rounded px-2 py-1.5 capitalize flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full" style={{ backgroundColor: STATUS_COLORS[agent.status] }} />
            {agent.status}
          </div>
        </div>
        <div>
          <div className="text-xs text-subtext0 mb-1">Created</div>
          <div className="text-xs text-text bg-crust rounded px-2 py-1.5">{new Date(agent.createdAt).toLocaleString()}</div>
        </div>
        <div>
          <div className="text-xs text-subtext0 mb-1">Duration</div>
          <div className="text-xs text-text bg-crust rounded px-2 py-1.5">{getElapsed(agent) || '...'}</div>
        </div>
      </div>
      {agent.cost != null && (
        <div>
          <div className="text-xs text-subtext0 mb-1">Cost</div>
          <div className="text-xs text-text bg-crust rounded px-2 py-1.5">{formatCost(agent.cost)}</div>
        </div>
      )}
      {agent.tokenUsage && (
        <div>
          <div className="text-xs text-subtext0 mb-1">Token Usage</div>
          <div className="text-xs text-text bg-crust rounded px-2 py-1.5">
            {agent.tokenUsage.inputTokens.toLocaleString()} input / {agent.tokenUsage.outputTokens.toLocaleString()} output
          </div>
        </div>
      )}
      {agent.error && (
        <div>
          <div className="text-xs text-red mb-1">Error</div>
          <div className="text-xs text-red bg-red/10 rounded px-2 py-1.5">{agent.error}</div>
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
          <h2 className="text-lg font-semibold text-text truncate">{agent.name}</h2>
        </div>
        <div className="text-xs text-overlay0 pl-5">
          Status: <span className="capitalize" style={{ color: STATUS_COLORS[agent.status] }}>{agent.status}</span>
          {getElapsed(agent) && ` · ${getElapsed(agent)}`}
          {agent.projectPath && ` · ${agent.projectPath.split(/[/\\]/).filter(Boolean).pop()}`}
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
      {tab === 'output' ? <OutputTab output={agent.output} /> : <SummaryTab agent={agent} />}

      {/* Action buttons */}
      <div className="flex gap-2 mt-3">
        {isRunning && (
          <button
            onClick={() => cancel(agent.id)}
            className="px-3 py-1.5 rounded text-xs font-medium bg-red/10 text-red hover:bg-red/20 transition-colors"
          >
            Cancel
          </button>
        )}
        {!isRunning && (
          <button
            onClick={() => retry(agent.id)}
            className="px-3 py-1.5 rounded text-xs font-medium bg-blue/10 text-blue hover:bg-blue/20 transition-colors"
          >
            Retry
          </button>
        )}
        {!isRunning && (
          <button
            onClick={() => remove(agent.id)}
            className="px-3 py-1.5 rounded text-xs font-medium bg-surface1 text-overlay1 hover:bg-surface2 hover:text-text transition-colors"
          >
            Remove
          </button>
        )}
      </div>
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

  // Compute filtered agents and counts in useMemo to avoid infinite re-renders
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

  return (
    <div className="flex-1 flex flex-col bg-base overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-5 pb-3">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-xl font-bold text-text">Cloud Agents</h1>
          <div className="flex items-center gap-2">
            {counts.running > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-medium text-crust" style={{ backgroundColor: '#89B4FA' }}>
                Running: {counts.running}
              </span>
            )}
            {counts.completed > 0 && (
              <span className="px-2 py-0.5 rounded-full text-[10px] font-medium text-crust" style={{ backgroundColor: '#A6E3A1' }}>
                Done: {counts.completed}
              </span>
            )}
            <button
              onClick={() => setShowNewDialog(true)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue hover:bg-blue/80 text-crust transition-colors flex items-center gap-1"
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
            <StatBadge label="Completed" count={counts.completed} color="#A6E3A1" active={filter === 'completed'} onClick={() => setFilter('completed')} />
            <StatBadge label="Failed" count={counts.failed} color="#F38BA8" active={filter === 'failed'} onClick={() => setFilter('failed')} />
          </div>
          <div className="flex-1" />
          <div className="relative">
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search..."
              className="bg-surface0 border border-surface1 rounded px-3 py-1 text-xs text-text placeholder:text-overlay0 outline-none focus:border-blue w-40"
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
          {counts.completed + counts.failed > 0 && (
            <button
              onClick={() => clearCompleted()}
              className="text-[10px] text-overlay0 hover:text-text transition-colors"
              title="Clear completed & failed"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Split panel */}
      <div className="flex-1 flex overflow-hidden border-t border-surface0">
        {/* Left panel: Task list */}
        <div className="w-[40%] border-r border-surface0 overflow-y-auto p-3 space-y-1.5">
          {agents.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center py-16 text-center">
              <div className="text-4xl mb-3 text-overlay0">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" className="mx-auto text-overlay0">
                  <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z" />
                </svg>
              </div>
              <p className="text-sm text-overlay1 mb-1">No agents yet</p>
              <p className="text-xs text-overlay0 mb-4">Dispatch a cloud agent to run headless Claude tasks</p>
              <button
                onClick={() => setShowNewDialog(true)}
                className="px-4 py-2 rounded-lg text-xs font-medium bg-blue hover:bg-blue/80 text-crust transition-colors"
              >
                + New Agent
              </button>
            </div>
          ) : (
            agents.map(agent => (
              <AgentCard
                key={agent.id}
                agent={agent}
                selected={agent.id === selectedAgentId}
                onClick={() => selectAgent(agent.id)}
              />
            ))
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
                <p className="text-sm">Select an agent to view details</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* New Agent Dialog */}
      {showNewDialog && <NewAgentDialog onClose={() => setShowNewDialog(false)} />}
    </div>
  )
}
