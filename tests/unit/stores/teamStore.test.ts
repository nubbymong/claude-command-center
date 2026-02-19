import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useTeamStore } from '../../../src/renderer/stores/teamStore'
import type { TeamTemplate, TeamRun, TeamRunStatus } from '../../../src/renderer/types/electron'

function makeTeam(overrides: Partial<TeamTemplate> = {}): TeamTemplate {
  return {
    id: 'team-' + Math.random().toString(36).slice(2, 8),
    name: 'Test Pipeline',
    description: 'Test description',
    steps: [
      { id: 'ts-1', templateId: 'builtin-code-reviewer', label: 'Code Review', mode: 'sequential' },
    ],
    projectPath: '/dev/project',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

function makeRun(overrides: Partial<TeamRun> = {}): TeamRun {
  return {
    id: 'tr-' + Math.random().toString(36).slice(2, 8),
    teamId: 'team-test1',
    teamName: 'Test Pipeline',
    status: 'running' as TeamRunStatus,
    steps: [
      { stepId: 'ts-1', agentId: 'ca-a1', status: 'running' as TeamRunStatus, label: 'Step 1' },
    ],
    projectPath: '/dev/project',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

describe('teamStore', () => {
  beforeEach(() => {
    useTeamStore.setState({
      teams: [],
      runs: [],
      selectedTeamId: null,
      selectedRunId: null,
      showBuilder: false,
      editingTeam: null,
    })
  })

  describe('hydrate', () => {
    it('sets teams and runs', () => {
      const teams = [makeTeam({ id: 't1' }), makeTeam({ id: 't2' })]
      const runs = [makeRun({ id: 'r1' })]
      useTeamStore.getState().hydrate(teams, runs)
      expect(useTeamStore.getState().teams).toHaveLength(2)
      expect(useTeamStore.getState().runs).toHaveLength(1)
    })

    it('handles null gracefully', () => {
      useTeamStore.getState().hydrate(null as any, null as any)
      expect(useTeamStore.getState().teams).toEqual([])
      expect(useTeamStore.getState().runs).toEqual([])
    })
  })

  describe('saveTeam', () => {
    it('adds new team to store', async () => {
      const team = makeTeam({ id: 'team-new' })
      await useTeamStore.getState().saveTeam(team)
      expect(useTeamStore.getState().teams).toHaveLength(1)
      expect(useTeamStore.getState().showBuilder).toBe(false)
    })

    it('updates existing team in place', async () => {
      useTeamStore.setState({ teams: [makeTeam({ id: 'team-exist', name: 'Old' })] })
      await useTeamStore.getState().saveTeam(makeTeam({ id: 'team-exist', name: 'New' }))
      const teams = useTeamStore.getState().teams
      expect(teams).toHaveLength(1)
      // The saved version comes from the mock which returns the input back
      expect(teams[0].id).toBe('team-exist')
    })

    it('closes builder after save', async () => {
      useTeamStore.setState({ showBuilder: true, editingTeam: makeTeam() })
      await useTeamStore.getState().saveTeam(makeTeam())
      expect(useTeamStore.getState().showBuilder).toBe(false)
      expect(useTeamStore.getState().editingTeam).toBeNull()
    })
  })

  describe('deleteTeam', () => {
    it('removes team from store', async () => {
      useTeamStore.setState({
        teams: [makeTeam({ id: 't1' }), makeTeam({ id: 't2' })],
      })
      await useTeamStore.getState().deleteTeam('t1')
      expect(useTeamStore.getState().teams).toHaveLength(1)
      expect(useTeamStore.getState().teams[0].id).toBe('t2')
    })

    it('clears selectedTeamId if deleted team was selected', async () => {
      useTeamStore.setState({
        teams: [makeTeam({ id: 't1' })],
        selectedTeamId: 't1',
      })
      await useTeamStore.getState().deleteTeam('t1')
      expect(useTeamStore.getState().selectedTeamId).toBeNull()
    })

    it('preserves selectedTeamId if different team deleted', async () => {
      useTeamStore.setState({
        teams: [makeTeam({ id: 't1' }), makeTeam({ id: 't2' })],
        selectedTeamId: 't2',
      })
      await useTeamStore.getState().deleteTeam('t1')
      expect(useTeamStore.getState().selectedTeamId).toBe('t2')
    })
  })

  describe('runTeam', () => {
    it('adds new run to store and selects it', async () => {
      await useTeamStore.getState().runTeam('team-1')
      const state = useTeamStore.getState()
      expect(state.runs).toHaveLength(1)
      expect(state.selectedRunId).toBe('tr-mock123')
    })

    it('does not add run if API returns null', async () => {
      const { team } = (window as any).electronAPI
      team.run.mockResolvedValueOnce(null)
      await useTeamStore.getState().runTeam('nonexistent')
      expect(useTeamStore.getState().runs).toHaveLength(0)
    })
  })

  describe('cancelRun', () => {
    it('calls electronAPI', async () => {
      await useTeamStore.getState().cancelRun('tr-1')
      expect((window as any).electronAPI.team.cancelRun).toHaveBeenCalledWith('tr-1')
    })
  })

  describe('selectTeam / selectRun', () => {
    it('sets selectedTeamId and clears selectedRunId', () => {
      useTeamStore.setState({ selectedRunId: 'r1' })
      useTeamStore.getState().selectTeam('t1')
      expect(useTeamStore.getState().selectedTeamId).toBe('t1')
      expect(useTeamStore.getState().selectedRunId).toBeNull()
    })

    it('sets selectedRunId', () => {
      useTeamStore.getState().selectRun('r1')
      expect(useTeamStore.getState().selectedRunId).toBe('r1')
    })
  })

  describe('openBuilder / closeBuilder', () => {
    it('opens builder without editing team', () => {
      useTeamStore.getState().openBuilder()
      expect(useTeamStore.getState().showBuilder).toBe(true)
      expect(useTeamStore.getState().editingTeam).toBeNull()
    })

    it('opens builder with editing team', () => {
      const team = makeTeam({ id: 't-edit' })
      useTeamStore.getState().openBuilder(team)
      expect(useTeamStore.getState().showBuilder).toBe(true)
      expect(useTeamStore.getState().editingTeam?.id).toBe('t-edit')
    })

    it('closes builder and clears editing team', () => {
      useTeamStore.setState({ showBuilder: true, editingTeam: makeTeam() })
      useTeamStore.getState().closeBuilder()
      expect(useTeamStore.getState().showBuilder).toBe(false)
      expect(useTeamStore.getState().editingTeam).toBeNull()
    })
  })

  describe('handleRunStatusChanged', () => {
    it('updates existing run in place', () => {
      useTeamStore.setState({
        runs: [makeRun({ id: 'r1', status: 'running' })],
      })
      useTeamStore.getState().handleRunStatusChanged(
        makeRun({ id: 'r1', status: 'completed', duration: 5000 })
      )
      const run = useTeamStore.getState().runs[0]
      expect(run.status).toBe('completed')
      expect(run.duration).toBe(5000)
    })

    it('adds new run if not found', () => {
      useTeamStore.getState().handleRunStatusChanged(
        makeRun({ id: 'r-new', status: 'running' })
      )
      expect(useTeamStore.getState().runs).toHaveLength(1)
      expect(useTeamStore.getState().runs[0].id).toBe('r-new')
    })
  })

  describe('loadTeams / loadRuns', () => {
    it('loadTeams fetches from API', async () => {
      const mockTeams = [makeTeam({ id: 't-api' })]
      ;(window as any).electronAPI.team.list.mockResolvedValueOnce(mockTeams)
      await useTeamStore.getState().loadTeams()
      expect(useTeamStore.getState().teams).toEqual(mockTeams)
    })

    it('loadRuns fetches from API', async () => {
      const mockRuns = [makeRun({ id: 'r-api' })]
      ;(window as any).electronAPI.team.listRuns.mockResolvedValueOnce(mockRuns)
      await useTeamStore.getState().loadRuns()
      expect(useTeamStore.getState().runs).toEqual(mockRuns)
    })
  })
})
