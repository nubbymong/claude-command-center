import { create } from 'zustand'
import type { TeamTemplate, TeamRun, TeamRunStatus } from '../types/electron'

interface TeamState {
  teams: TeamTemplate[]
  runs: TeamRun[]
  selectedTeamId: string | null
  selectedRunId: string | null
  showBuilder: boolean
  editingTeam: TeamTemplate | null

  hydrate: (teams: TeamTemplate[], runs: TeamRun[]) => void
  loadTeams: () => Promise<void>
  loadRuns: () => Promise<void>
  saveTeam: (team: TeamTemplate) => Promise<TeamTemplate>
  deleteTeam: (id: string) => Promise<void>
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

  saveTeam: async (team) => {
    const saved = await window.electronAPI.team.save(team)
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
    return saved
  },

  deleteTeam: async (id) => {
    await window.electronAPI.team.delete(id)
    set(state => ({
      teams: state.teams.filter(t => t.id !== id),
      selectedTeamId: state.selectedTeamId === id ? null : state.selectedTeamId,
    }))
  },

  runTeam: async (teamId, projectPath) => {
    const run = await window.electronAPI.team.run(teamId, projectPath)
    if (run) {
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
