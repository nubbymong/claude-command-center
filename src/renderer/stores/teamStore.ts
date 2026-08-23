import { create } from 'zustand'
import type { TeamTemplate, TeamRun, TeamRunStatus } from '../types/electron'
import { trackUsage } from './tipsStore'

/**
 * Outcome of a persisting mutation. `ok:false` means main REFUSED or FAILED the
 * disk write (#371 BLOCKER-1) — the change is not on disk, so the store must not
 * pretend it is. Callers show `error` and keep the user's work where it is.
 */
export interface TeamMutationResult {
  ok: boolean
  error?: string
}

interface TeamState {
  teams: TeamTemplate[]
  runs: TeamRun[]
  selectedTeamId: string | null
  selectedRunId: string | null
  showBuilder: boolean
  editingTeam: TeamTemplate | null
  /** Why the last save/delete did not land, in words a user can act on. */
  error: string | null

  hydrate: (teams: TeamTemplate[], runs: TeamRun[]) => void
  loadTeams: () => Promise<void>
  loadRuns: () => Promise<void>
  saveTeam: (team: TeamTemplate) => Promise<TeamMutationResult>
  deleteTeam: (id: string) => Promise<TeamMutationResult>
  clearError: () => void
  runTeam: (teamId: string, projectPath?: string) => Promise<void>
  cancelRun: (runId: string) => Promise<void>
  selectTeam: (id: string | null) => void
  selectRun: (id: string | null) => void
  openBuilder: (team?: TeamTemplate) => void
  closeBuilder: () => void

  handleRunStatusChanged: (run: TeamRun) => void
}

export const useTeamStore = create<TeamState>((set, get) => ({
  teams: [],
  runs: [],
  selectedTeamId: null,
  selectedRunId: null,
  showBuilder: false,
  editingTeam: null,
  error: null,

  hydrate: (teams, runs) => {
    set({ teams: teams || [], runs: runs || [] })
  },

  loadTeams: async () => {
    const teams = await window.electronAPI.team.list()
    set({ teams })
  },

  loadRuns: async () => {
    const runs = await window.electronAPI.team.listRuns()
    set({ runs })
  },

  // #371 BLOCKER-1. Main answers `{ ok:false }` when the write was refused or
  // failed, and rolls its own in-memory library back, so the ONLY correct
  // renderer behaviour is to leave local state alone too — otherwise the team
  // sits on screen until the next restart makes it disappear. The builder also
  // stays open (showBuilder untouched) so the user's work is not thrown away.
  saveTeam: async (team) => {
    set({ error: null })
    const result = await window.electronAPI.team.save(team)
    if (!result.ok) {
      const error = result.error || 'Your team could not be saved to disk.'
      set({ error })
      return { ok: false, error }
    }
    const saved = result.team
    set(state => {
      const idx = state.teams.findIndex(t => t.id === saved.id)
      const teams = [...state.teams]
      if (idx >= 0) {
        teams[idx] = saved
      } else {
        teams.unshift(saved)
      }
      return { teams, showBuilder: false, editingTeam: null }
    })
    return { ok: true }
  },

  deleteTeam: async (id) => {
    set({ error: null })
    const result = await window.electronAPI.team.delete(id)
    if (!result.ok) {
      const error = result.error || 'Your team could not be deleted from disk.'
      set({ error })
      return { ok: false, error }
    }
    set(state => ({
      teams: state.teams.filter(t => t.id !== id),
      selectedTeamId: state.selectedTeamId === id ? null : state.selectedTeamId,
    }))
    return { ok: true }
  },

  clearError: () => set({ error: null }),

  runTeam: async (teamId, projectPath) => {
    const run = await window.electronAPI.team.run(teamId, projectPath)
    if (run) {
      // Recorded on a run that actually STARTED, not on save: the tip this
      // retires says "you can run several agents as a team", and building one
      // you never ran is not that. Nothing recorded this before, so the tip kept
      // suggesting teams to people already using them.
      trackUsage('agents.agent-teams')
      set(state => ({
        runs: [run, ...state.runs],
        selectedRunId: run.id,
      }))
    }
  },

  cancelRun: async (runId) => {
    await window.electronAPI.team.cancelRun(runId)
  },

  selectTeam: (id) => set({ selectedTeamId: id, selectedRunId: null }),
  selectRun: (id) => set({ selectedRunId: id }),

  openBuilder: (team) => set({ showBuilder: true, editingTeam: team || null }),
  closeBuilder: () => set({ showBuilder: false, editingTeam: null }),

  handleRunStatusChanged: (run) => {
    set(state => {
      const runs = [...state.runs]
      const idx = runs.findIndex(r => r.id === run.id)
      if (idx >= 0) {
        runs[idx] = run
      } else {
        runs.unshift(run)
      }
      return { runs }
    })
  },
}))

// Set up IPC listener — called once from TeamsPanel
let listenerSetup = false
export function setupTeamListener(): () => void {
  if (listenerSetup) return () => {}
  listenerSetup = true

  const unsub = window.electronAPI.team.onRunStatusChanged((run) => {
    useTeamStore.getState().handleRunStatusChanged(run)
  })

  return () => {
    unsub()
    listenerSetup = false
  }
}
