import React, { useEffect, useMemo } from 'react'
import { useTeamStore, setupTeamListener } from '../stores/teamStore'
import TeamBuilder from './TeamBuilder'
import TeamRunView from './TeamRunView'
import type { TeamTemplate, TeamRun, TeamRunStatus } from '../types/electron'

const STATUS_COLORS: Record<TeamRunStatus, string> = {
  pending: '#F9E2AF',
  running: '#89B4FA',
  completed: '#A6E3A1',
  failed: '#F38BA8',
  cancelled: '#F38BA8',
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  if (isToday) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export default function TeamsPanel() {
  const teams = useTeamStore(s => s.teams)
  const runs = useTeamStore(s => s.runs)
  const selectedTeamId = useTeamStore(s => s.selectedTeamId)
  const selectedRunId = useTeamStore(s => s.selectedRunId)
  const selectTeam = useTeamStore(s => s.selectTeam)
  const selectRun = useTeamStore(s => s.selectRun)
  const openBuilder = useTeamStore(s => s.openBuilder)
  const closeBuilder = useTeamStore(s => s.closeBuilder)
  const showBuilder = useTeamStore(s => s.showBuilder)
  const deleteTeam = useTeamStore(s => s.deleteTeam)
  const runTeam = useTeamStore(s => s.runTeam)

  useEffect(() => {
    const cleanup = setupTeamListener()
    return cleanup
  }, [])

  const selectedTeam = teams.find(t => t.id === selectedTeamId) || null
  const selectedRun = runs.find(r => r.id === selectedRunId) || null

  // Runs for the selected team
  const teamRuns = useMemo(() => {
    if (!selectedTeamId) return []
    return runs.filter(r => r.teamId === selectedTeamId).sort((a, b) => b.createdAt - a.createdAt)
  }, [runs, selectedTeamId])

  // Last run status per team
  const lastRunStatus = useMemo(() => {
    const map: Record<string, TeamRunStatus> = {}
    for (const team of teams) {
      const lastRun = runs.find(r => r.teamId === team.id)
      if (lastRun) map[team.id] = lastRun.status
    }
    return map
  }, [teams, runs])

  return (
    <div className="flex-1 flex overflow-hidden">
      {/* Left: Team list */}
      <div className="w-[40%] border-r border-surface0/40 flex flex-col">
        {/* Header */}
        <div className="px-3 py-3 border-b border-surface0/40">
          <div className="flex items-center justify-between mb-2">
            <div className="text-[11px] text-subtext0 font-semibold">Teams</div>
            <button
              onClick={() => openBuilder()}
              className="text-[11px] text-sapphire hover:text-sapphire/80 transition-colors font-medium"
            >
              + New Team
            </button>
          </div>
        </div>

        {/* Team cards */}
        <div className="flex-1 overflow-y-auto p-3 space-y-1.5">
          {teams.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center py-16 text-center">
              <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-surface0/30 flex items-center justify-center">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-overlay0">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <p className="text-sm text-subtext1 font-medium mb-1">No teams yet</p>
              <p className="text-xs text-overlay0 mb-4 max-w-[200px]">
                Create a team to chain multiple agents into a pipeline
              </p>
              <button
                onClick={() => openBuilder()}
                className="px-4 py-2 rounded-lg text-xs font-medium bg-sapphire hover:bg-sapphire/85 text-crust transition-colors"
              >
                + New Team
              </button>
            </div>
          ) : (
            teams.map(team => (
              <TeamCard
                key={team.id}
                team={team}
                selected={team.id === selectedTeamId}
                lastStatus={lastRunStatus[team.id]}
                onClick={() => selectTeam(team.id)}
              />
            ))
          )}
        </div>

        {/* Run history for selected team */}
        {selectedTeam && teamRuns.length > 0 && (
          <div className="border-t border-surface0/40 max-h-[30%] overflow-y-auto">
            <div className="px-3 py-2">
              <div className="text-[10px] text-subtext0 uppercase tracking-wider font-semibold mb-1.5">Run History</div>
              <div className="space-y-1">
                {teamRuns.map(run => (
                  <button
                    key={run.id}
                    onClick={() => selectRun(run.id)}
                    className={`w-full text-left flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors text-xs ${
                      run.id === selectedRunId
                        ? 'bg-surface0/60 text-text'
                        : 'text-overlay1 hover:bg-surface0/30 hover:text-text'
                    }`}
                  >
                    <span
                      className={`w-2 h-2 rounded-full shrink-0 ${run.status === 'running' ? 'animate-pulse' : ''}`}
                      style={{ backgroundColor: STATUS_COLORS[run.status] }}
                    />
                    <span className="truncate flex-1">{formatTimestamp(run.createdAt)}</span>
                    <span className="text-[10px]" style={{ color: STATUS_COLORS[run.status] }}>
                      {run.steps.filter(s => s.status === 'completed').length}/{run.steps.length}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Right: Detail/run view */}
      <div className="flex-1 flex flex-col min-h-0">
        {selectedRun ? (
          <TeamRunView run={selectedRun} />
        ) : selectedTeam ? (
          <TeamDetail
            team={selectedTeam}
            onEdit={() => openBuilder(selectedTeam)}
            onDelete={() => deleteTeam(selectedTeam.id)}
            onRun={() => runTeam(selectedTeam.id)}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="w-14 h-14 mx-auto mb-4 rounded-2xl bg-surface0/30 flex items-center justify-center">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" className="text-overlay0">
                  <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                  <circle cx="9" cy="7" r="4" />
                  <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                  <path d="M16 3.13a4 4 0 0 1 0 7.75" />
                </svg>
              </div>
              <p className="text-sm text-subtext1 font-medium mb-1">Select a team</p>
              <p className="text-[11px] text-overlay0">Click a team card to view details or start a run</p>
            </div>
          </div>
        )}
      </div>

      {showBuilder && <TeamBuilder onClose={closeBuilder} />}
    </div>
  )
}

function TeamCard({ team, selected, lastStatus, onClick }: {
  team: TeamTemplate; selected: boolean; lastStatus?: TeamRunStatus; onClick: () => void
}) {
  const projectName = team.projectPath?.split(/[/\\]/).filter(Boolean).pop() || 'No project'
  const isRunning = lastStatus === 'running'

  return (
    <button
      onClick={onClick}
      className={`w-full text-left rounded-xl p-3 transition-all duration-150 border group ${
        selected
          ? 'bg-surface0/60 border-sapphire/30'
          : 'bg-mantle/30 border-transparent hover:bg-surface0/30 hover:border-surface0/60'
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        {lastStatus && (
          <span
            className={`w-2.5 h-2.5 rounded-full shrink-0 ${isRunning ? 'animate-pulse' : ''}`}
            style={{ backgroundColor: STATUS_COLORS[lastStatus] }}
          />
        )}
        <span className="text-sm font-medium text-text truncate flex-1">{team.name}</span>
        <span className="text-[10px] text-overlay0 shrink-0">{team.steps.length} steps</span>
      </div>
      {team.description && (
        <div className={`text-[11px] text-overlay1 truncate mb-1 ${lastStatus ? 'pl-[18px]' : ''}`}>{team.description}</div>
      )}
      <div className={`flex items-center gap-1.5 text-[10px] text-overlay0 ${lastStatus ? 'pl-[18px]' : ''}`}>
        <span className="truncate max-w-[150px]">{projectName}</span>
        <span>{String.fromCodePoint(0x00B7)}</span>
        <span>{team.steps.map(s => s.mode === 'parallel' ? '||' : String.fromCodePoint(0x2192)).join(' ')}</span>
      </div>
    </button>
  )
}

function TeamDetail({ team, onEdit, onDelete, onRun }: {
  team: TeamTemplate; onEdit: () => void; onDelete: () => void; onRun: () => void
}) {
  return (
    <div className="flex-1 flex flex-col min-h-0 p-4">
      {/* Header */}
      <div className="mb-4">
        <div className="flex items-center gap-2.5 mb-1">
          <h2 className="text-lg font-semibold text-text flex-1">{team.name}</h2>
          <div className="flex gap-1.5 shrink-0">
            <button
              onClick={onRun}
              className="px-3 py-1.5 rounded-lg text-xs font-medium bg-green/15 text-green hover:bg-green/25 transition-colors border border-green/25"
            >
              {String.fromCodePoint(0x25B6)} Run
            </button>
            <button
              onClick={onEdit}
              className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-sapphire/10 text-sapphire hover:bg-sapphire/20 transition-colors border border-sapphire/20"
            >
              Edit
            </button>
            <button
              onClick={onDelete}
              className="px-2.5 py-1.5 rounded-lg text-xs font-medium bg-surface0/50 text-overlay1 hover:bg-red/10 hover:text-red transition-colors border border-surface0/60"
            >
              Delete
            </button>
          </div>
        </div>
        {team.description && (
          <p className="text-xs text-overlay1 mt-1">{team.description}</p>
        )}
      </div>

      {/* Pipeline visualization */}
      <div className="mb-4">
        <div className="text-[10px] text-subtext0 uppercase tracking-wider font-semibold mb-2">Pipeline</div>
        <div className="space-y-1">
          {team.steps.map((step, idx) => (
            <div key={step.id}>
              {idx > 0 && (
                <div className="flex items-center justify-center py-0.5">
                  {step.mode === 'parallel' ? (
                    <span className="text-[10px] text-lavender">|| parallel</span>
                  ) : (
                    <svg width="10" height="12" viewBox="0 0 10 12" className="text-overlay0">
                      <line x1="5" y1="0" x2="5" y2="8" stroke="currentColor" strokeWidth="1.5" />
                      <polyline points="2,6 5,10 8,6" fill="none" stroke="currentColor" strokeWidth="1.5" />
                    </svg>
                  )}
                </div>
              )}
              <div className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border ${
                step.mode === 'parallel' ? 'border-lavender/20 bg-lavender/5' : 'border-surface0/40 bg-surface0/20'
              }`}>
                <span className="text-[10px] text-overlay0 w-4 text-center font-mono">{idx + 1}</span>
                <span className="text-xs text-text flex-1">{step.label}</span>
                <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                  step.mode === 'parallel' ? 'text-lavender bg-lavender/10' : 'text-overlay0 bg-surface0/30'
                }`}>
                  {step.mode}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Meta */}
      <div className="grid grid-cols-2 gap-2.5">
        <div className="bg-crust/60 rounded-lg px-3 py-2 border border-surface0/30">
          <div className="text-[10px] text-subtext0 mb-0.5">Project</div>
          <div className="text-xs text-text truncate" title={team.projectPath}>
            {team.projectPath || '(none)'}
          </div>
        </div>
        <div className="bg-crust/60 rounded-lg px-3 py-2 border border-surface0/30">
          <div className="text-[10px] text-subtext0 mb-0.5">Steps</div>
          <div className="text-xs text-text">{team.steps.length}</div>
        </div>
      </div>
    </div>
  )
}
