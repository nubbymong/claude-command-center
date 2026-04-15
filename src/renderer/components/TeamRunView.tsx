import React, { useState, useEffect } from 'react'
import { useTeamStore } from '../stores/teamStore'
import { useCloudAgentStore } from '../stores/cloudAgentStore'
import type { TeamRun, TeamRunStep, TeamRunStatus } from '../types/electron'

const STATUS_COLORS: Record<TeamRunStatus, string> = {
  pending: '#F9E2AF',
  running: '#89B4FA',
  completed: '#A6E3A1',
  failed: '#F38BA8',
  cancelled: '#F38BA8',
}

const STATUS_LABELS: Record<TeamRunStatus, string> = {
  pending: 'Pending',
  running: 'Running',
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

function getRunElapsed(run: TeamRun): string {
  if (run.duration) return formatDuration(run.duration)
  if (run.status === 'running') return formatDuration(Date.now() - run.createdAt)
  return ''
}

export default function TeamRunView({ run }: { run: TeamRun }) {
  const cancelRun = useTeamStore(s => s.cancelRun)
  const agents = useCloudAgentStore(s => s.agents)
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(getRunElapsed(run))
  const isRunning = run.status === 'running'

  useEffect(() => {
    if (!isRunning) {
      setElapsed(getRunElapsed(run))
      return
    }
    const iv = setInterval(() => setElapsed(getRunElapsed(run)), 1000)
    return () => clearInterval(iv)
  }, [run.status, run.createdAt, run.duration])

  const completedSteps = run.steps.filter(s => s.status === 'completed').length
  const totalSteps = run.steps.length

  // Find agent output for selected step
  const selectedStep = run.steps.find(s => s.stepId === selectedStepId)
  const selectedAgent = selectedStep?.agentId ? agents.find(a => a.id === selectedStep.agentId) : null

  return (
    <div className="flex-1 flex flex-col min-h-0 p-4">
      {/* Header */}
      <div className="mb-3">
        <div className="flex items-center gap-2.5 mb-1">
          <span
            className={`w-3 h-3 rounded-full shrink-0 ${isRunning ? 'animate-pulse' : ''}`}
            style={{ backgroundColor: STATUS_COLORS[run.status] }}
          />
          <h2 className="text-lg font-semibold text-text truncate flex-1">{run.teamName}</h2>
          {isRunning && (
            <button
              onClick={() => cancelRun(run.id)}
              className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-red/10 text-red hover:bg-red/20 transition-colors border border-red/20"
            >
              Cancel Run
            </button>
          )}
        </div>
        <div className="text-xs text-overlay0 pl-[22px] flex items-center gap-1.5">
          <span style={{ color: STATUS_COLORS[run.status] }}>{STATUS_LABELS[run.status]}</span>
          {elapsed && (
            <><span>{String.fromCodePoint(0x00B7)}</span><span className="tabular-nums">{elapsed}</span></>
          )}
          <span>{String.fromCodePoint(0x00B7)}</span>
          <span>{completedSteps}/{totalSteps} steps</span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="mb-4 mx-1">
        <div className="h-1.5 rounded-full bg-surface0/60 overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${totalSteps > 0 ? (completedSteps / totalSteps) * 100 : 0}%`,
              backgroundColor: run.status === 'failed' ? '#F38BA8' : '#A6E3A1',
            }}
          />
        </div>
      </div>

      {/* Pipeline steps visualization */}
      <div className="mb-4">
        <div className="text-[10px] text-subtext0 uppercase tracking-wider font-semibold mb-2 px-1">Pipeline Steps</div>
        <div className="space-y-1">
          {run.steps.map((step, idx) => (
            <StepIndicator
              key={step.stepId}
              step={step}
              index={idx}
              selected={step.stepId === selectedStepId}
              onClick={() => setSelectedStepId(step.stepId === selectedStepId ? null : step.stepId)}
            />
          ))}
        </div>
      </div>

      {/* Selected step output */}
      {selectedStep && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="text-[10px] text-subtext0 uppercase tracking-wider font-semibold mb-2 px-1">
            Output: {selectedStep.label}
          </div>
          <pre className="flex-1 bg-crust/60 rounded-xl p-4 text-xs text-text font-mono overflow-auto whitespace-pre-wrap break-words border border-surface0/30">
            {selectedAgent?.output ? (
              selectedAgent.output
            ) : selectedStep.status === 'running' ? (
              <span className="text-overlay0 flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full bg-sapphire animate-pulse" />
                Step is running...
              </span>
            ) : selectedStep.status === 'pending' ? (
              <span className="text-overlay0">Waiting to start...</span>
            ) : (
              <span className="text-overlay0">No output captured</span>
            )}
          </pre>
        </div>
      )}

      {/* Aggregate stats when no step selected */}
      {!selectedStep && (
        <div className="flex-1 overflow-auto">
          <div className="text-[10px] text-subtext0 uppercase tracking-wider font-semibold mb-2 px-1">Run Details</div>
          <div className="grid grid-cols-2 gap-2.5">
            <InfoCell label="Status">
              <div className="flex items-center gap-1.5">
                <span className={`w-2 h-2 rounded-full ${isRunning ? 'animate-pulse' : ''}`} style={{ backgroundColor: STATUS_COLORS[run.status] }} />
                <span>{STATUS_LABELS[run.status]}</span>
              </div>
            </InfoCell>
            <InfoCell label="Duration">
              <span className="tabular-nums">{elapsed || '-'}</span>
            </InfoCell>
            <InfoCell label="Steps">
              {completedSteps}/{totalSteps} completed
            </InfoCell>
            <InfoCell label="Project">
              <span className="truncate" title={run.projectPath}>
                {run.projectPath.split(/[/\\]/).filter(Boolean).pop() || run.projectPath}
              </span>
            </InfoCell>
            <InfoCell label="Run ID">
              <span className="font-mono text-[10px]">{run.id}</span>
            </InfoCell>
            <InfoCell label="Started">
              {new Date(run.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </InfoCell>
          </div>
          {run.error && (
            <div className="mt-3">
              <div className="text-[10px] text-red uppercase tracking-wider font-semibold mb-1.5">Error</div>
              <div className="text-xs text-red bg-red/8 rounded-xl px-3.5 py-2.5 font-mono border border-red/15">{run.error}</div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StepIndicator({ step, index, selected, onClick }: {
  step: TeamRunStep; index: number; selected: boolean; onClick: () => void
}) {
  const isRunning = step.status === 'running'
  const color = STATUS_COLORS[step.status]

  return (
    <button
      onClick={onClick}
      className={`w-full text-left flex items-center gap-2.5 px-3 py-2 rounded-lg transition-colors border ${
        selected
          ? 'bg-surface0/60 border-sapphire/30'
          : 'bg-mantle/30 border-transparent hover:bg-surface0/30'
      }`}
    >
      <span
        className={`w-2.5 h-2.5 rounded-full shrink-0 ${isRunning ? 'animate-pulse' : ''}`}
        style={{ backgroundColor: color, boxShadow: isRunning ? `0 0 6px 1px ${color}60` : undefined }}
      />
      <span className="text-[10px] text-overlay0 w-4 shrink-0 font-mono">{index + 1}</span>
      <span className="text-xs text-text truncate flex-1">{step.label}</span>
      <span className="text-[10px] shrink-0" style={{ color }}>{STATUS_LABELS[step.status]}</span>
      {step.completedAt && step.startedAt && (
        <span className="text-[10px] text-overlay0 tabular-nums shrink-0">
          {formatDuration(step.completedAt - step.startedAt)}
        </span>
      )}
    </button>
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
