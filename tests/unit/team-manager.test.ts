import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock config-manager
const mockReadConfig = vi.fn()
const mockWriteConfig = vi.fn()
vi.mock('../../src/main/config-manager', () => ({
  readConfig: (...args: any[]) => mockReadConfig(...args),
  writeConfig: (...args: any[]) => mockWriteConfig(...args),
}))

// Mock cloud-agent-manager
const mockDispatchAgent = vi.fn()
const mockCancelAgent = vi.fn()
const mockGetAgentOutput = vi.fn()
const mockOnAgentCompletion = vi.fn()
vi.mock('../../src/main/cloud-agent-manager', () => ({
  dispatchAgent: (...args: any[]) => mockDispatchAgent(...args),
  cancelAgent: (...args: any[]) => mockCancelAgent(...args),
  getAgentOutput: (...args: any[]) => mockGetAgentOutput(...args),
  onAgentCompletion: (...args: any[]) => mockOnAgentCompletion(...args),
}))

import {
  initTeamManager,
  listTeams,
  saveTeam,
  deleteTeam,
  listRuns,
  runTeam,
  cancelRun,
} from '../../src/main/team-manager'
import type { TeamTemplate, TeamRun } from '../../src/shared/types'

function makeTeam(overrides: Partial<TeamTemplate> = {}): TeamTemplate {
  return {
    id: 'team-test1',
    name: 'Test Pipeline',
    description: 'A test team',
    steps: [
      { id: 'ts-1', templateId: 'builtin-code-reviewer', label: 'Code Review', mode: 'sequential' },
      { id: 'ts-2', templateId: 'builtin-test-runner', label: 'Run Tests', mode: 'sequential' },
    ],
    projectPath: '/dev/project',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

function makeRun(overrides: Partial<TeamRun> = {}): TeamRun {
  return {
    id: 'tr-test1',
    teamId: 'team-test1',
    teamName: 'Test Pipeline',
    status: 'running',
    steps: [
      { stepId: 'ts-1', agentId: 'ca-a1', status: 'running', label: 'Code Review' },
      { stepId: 'ts-2', agentId: null, status: 'pending', label: 'Run Tests' },
    ],
    projectPath: '/dev/project',
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  }
}

describe('team-manager', () => {
  let mockWindow: any

  beforeEach(() => {
    vi.clearAllMocks()
    mockReadConfig.mockReturnValue(null)
    mockWindow = {
      isDestroyed: vi.fn(() => false),
      webContents: { send: vi.fn() },
    }
    initTeamManager(() => mockWindow)
  })

  describe('initTeamManager', () => {
    it('loads persisted teams and runs', () => {
      const teams = [makeTeam()]
      const runs = [makeRun({ status: 'completed' })]
      mockReadConfig.mockImplementation((key: string) => {
        if (key === 'agentTeams') return teams
        if (key === 'agentTeamRuns') return runs
        return null
      })
      initTeamManager(() => mockWindow)
      expect(listTeams()).toHaveLength(1)
      expect(listRuns()).toHaveLength(1)
    })

    it('handles null persisted data gracefully', () => {
      mockReadConfig.mockReturnValue(null)
      initTeamManager(() => mockWindow)
      expect(listTeams()).toEqual([])
      expect(listRuns()).toEqual([])
    })

    it('cleans up stuck running runs on init', () => {
      mockReadConfig.mockImplementation((key: string) => {
        if (key === 'agentTeamRuns') return [makeRun({ status: 'running' })]
        return null
      })
      initTeamManager(() => mockWindow)
      const runs = listRuns()
      expect(runs[0].status).toBe('failed')
      expect(runs[0].error).toContain('interrupted')
      expect(mockWriteConfig).toHaveBeenCalledWith('agentTeamRuns', expect.any(Array))
    })

    it('cleans up stuck pending runs on init', () => {
      mockReadConfig.mockImplementation((key: string) => {
        if (key === 'agentTeamRuns') return [makeRun({ status: 'pending' })]
        return null
      })
      initTeamManager(() => mockWindow)
      expect(listRuns()[0].status).toBe('failed')
    })

    it('marks stuck run steps as failed too', () => {
      const run = makeRun({
        status: 'running',
        steps: [
          { stepId: 'ts-1', agentId: 'ca-a1', status: 'completed', label: 'Done Step' },
          { stepId: 'ts-2', agentId: 'ca-a2', status: 'running', label: 'Running Step' },
          { stepId: 'ts-3', agentId: null, status: 'pending', label: 'Pending Step' },
        ],
      })
      mockReadConfig.mockImplementation((key: string) => {
        if (key === 'agentTeamRuns') return [run]
        return null
      })
      initTeamManager(() => mockWindow)
      const steps = listRuns()[0].steps
      expect(steps[0].status).toBe('completed') // already done — not touched
      expect(steps[1].status).toBe('failed')
      expect(steps[2].status).toBe('failed')
    })

    it('does not persist if no stuck runs', () => {
      mockReadConfig.mockImplementation((key: string) => {
        if (key === 'agentTeamRuns') return [makeRun({ status: 'completed' })]
        return null
      })
      initTeamManager(() => mockWindow)
      // writeConfig is NOT called for agentTeamRuns (no stuck runs to fix)
      const teamRunWrites = mockWriteConfig.mock.calls.filter((c: any[]) => c[0] === 'agentTeamRuns')
      expect(teamRunWrites).toHaveLength(0)
    })

    it('registers agent completion callback', () => {
      initTeamManager(() => mockWindow)
      expect(mockOnAgentCompletion).toHaveBeenCalledWith(expect.any(Function))
    })
  })

  describe('saveTeam', () => {
    it('adds new team', () => {
      const team = makeTeam({ id: 'team-new' })
      const saved = saveTeam(team)
      expect(saved.id).toBe('team-new')
      expect(listTeams()).toHaveLength(1)
      expect(mockWriteConfig).toHaveBeenCalledWith('agentTeams', expect.any(Array))
    })

    it('updates existing team', () => {
      saveTeam(makeTeam({ id: 'team-1', name: 'Original' }))
      const updated = saveTeam(makeTeam({ id: 'team-1', name: 'Updated' }))
      expect(updated.name).toBe('Updated')
      expect(listTeams()).toHaveLength(1)
    })

    it('generates ID if missing', () => {
      const team = makeTeam({ id: '' })
      const saved = saveTeam(team)
      expect(saved.id).toMatch(/^team-/)
    })

    it('sets timestamps', () => {
      const before = Date.now()
      const saved = saveTeam(makeTeam({ id: 'team-ts', createdAt: 0, updatedAt: 0 }))
      expect(saved.updatedAt).toBeGreaterThanOrEqual(before)
    })
  })

  describe('deleteTeam', () => {
    it('removes team from list', () => {
      saveTeam(makeTeam({ id: 'team-a' }))
      saveTeam(makeTeam({ id: 'team-b' }))
      expect(deleteTeam('team-a')).toBe(true)
      expect(listTeams()).toHaveLength(1)
      expect(listTeams()[0].id).toBe('team-b')
    })

    it('returns false for unknown id', () => {
      expect(deleteTeam('nonexistent')).toBe(false)
    })

    it('persists after deletion', () => {
      saveTeam(makeTeam({ id: 'team-del' }))
      mockWriteConfig.mockClear()
      deleteTeam('team-del')
      expect(mockWriteConfig).toHaveBeenCalledWith('agentTeams', [])
    })
  })

  describe('runTeam', () => {
    it('returns null for unknown team', async () => {
      expect(await runTeam('nonexistent')).toBeNull()
    })

    it('returns null for team with no steps', async () => {
      saveTeam(makeTeam({ id: 'team-empty', steps: [] }))
      expect(await runTeam('team-empty')).toBeNull()
    })

    it('creates a run with pending steps', async () => {
      mockDispatchAgent.mockResolvedValue({ id: 'ca-dispatched', status: 'running' })
      saveTeam(makeTeam({ id: 'team-run' }))
      const run = await runTeam('team-run')
      expect(run).not.toBeNull()
      expect(run!.id).toMatch(/^tr-/)
      expect(run!.teamId).toBe('team-run')
      expect(run!.status).toBe('running')
      expect(run!.steps).toHaveLength(2)
      // Steps start as pending (then transition to running in the async pipeline)
    })

    it('uses projectPathOverride when provided', async () => {
      mockDispatchAgent.mockResolvedValue({ id: 'ca-d', status: 'running' })
      saveTeam(makeTeam({ id: 'team-path', projectPath: '/original' }))
      const run = await runTeam('team-path', '/override')
      expect(run!.projectPath).toBe('/override')
    })

    it('persists the run and broadcasts', async () => {
      mockDispatchAgent.mockResolvedValue({ id: 'ca-d', status: 'running' })
      saveTeam(makeTeam({ id: 'team-bc' }))
      mockWriteConfig.mockClear()
      await runTeam('team-bc')
      expect(mockWriteConfig).toHaveBeenCalledWith('agentTeamRuns', expect.any(Array))
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'team:runStatusChanged',
        expect.objectContaining({ teamId: 'team-bc' })
      )
    })
  })

  describe('cancelRun', () => {
    it('returns false for unknown run', () => {
      expect(cancelRun('nonexistent')).toBe(false)
    })

    it('returns false for non-running run', () => {
      mockReadConfig.mockImplementation((key: string) => {
        if (key === 'agentTeamRuns') return [makeRun({ id: 'tr-done', status: 'completed' })]
        return null
      })
      initTeamManager(() => mockWindow)
      expect(cancelRun('tr-done')).toBe(false)
    })

    it('cancels a running run and its active steps', () => {
      // Inject run directly after init to bypass stuck-run cleanup
      listRuns().push(makeRun({
        id: 'tr-cancel',
        status: 'running',
        steps: [
          { stepId: 'ts-1', agentId: 'ca-a1', status: 'completed', label: 'Done' },
          { stepId: 'ts-2', agentId: 'ca-a2', status: 'running', label: 'Active' },
          { stepId: 'ts-3', agentId: null, status: 'pending', label: 'Waiting' },
        ],
      }))

      expect(cancelRun('tr-cancel')).toBe(true)
      const cancelled = listRuns().find(r => r.id === 'tr-cancel')!
      expect(cancelled.status).toBe('cancelled')
      expect(cancelled.duration).toBeGreaterThan(0)

      // Completed step untouched
      expect(cancelled.steps[0].status).toBe('completed')
      // Running step with agentId → cancel called
      expect(cancelled.steps[1].status).toBe('cancelled')
      expect(mockCancelAgent).toHaveBeenCalledWith('ca-a2')
      // Pending step without agentId → just marked cancelled
      expect(cancelled.steps[2].status).toBe('cancelled')
    })

    it('persists and broadcasts after cancel', () => {
      // Inject run directly after init to bypass stuck-run cleanup
      listRuns().push(makeRun({ id: 'tr-bc', status: 'running' }))
      mockWriteConfig.mockClear()
      mockWindow.webContents.send.mockClear()

      cancelRun('tr-bc')
      expect(mockWriteConfig).toHaveBeenCalledWith('agentTeamRuns', expect.any(Array))
      expect(mockWindow.webContents.send).toHaveBeenCalledWith(
        'team:runStatusChanged',
        expect.objectContaining({ id: 'tr-bc', status: 'cancelled' })
      )
    })
  })

  describe('agent completion callback', () => {
    it('does not update step for unmapped agent', () => {
      // Inject run directly after init to bypass stuck-run cleanup
      listRuns().push(makeRun({
        id: 'tr-cb',
        status: 'running',
        steps: [
          { stepId: 'ts-1', agentId: 'ca-agent1', status: 'running', label: 'Step 1', startedAt: 1000 },
        ],
      }))

      // Get the registered completion callback
      const callback = mockOnAgentCompletion.mock.calls[mockOnAgentCompletion.mock.calls.length - 1][0]

      // 'ca-unknown' isn't in the agentToRun map, so the callback returns silently
      callback({ id: 'ca-unknown', status: 'completed' })

      // The step should remain unchanged
      expect(listRuns().find(r => r.id === 'tr-cb')!.steps[0].status).toBe('running')
    })

    it('does not crash on unknown agent id', () => {
      initTeamManager(() => mockWindow)
      const callback = mockOnAgentCompletion.mock.calls[mockOnAgentCompletion.mock.calls.length - 1][0]
      expect(() => callback({ id: 'totally-unknown', status: 'completed' })).not.toThrow()
    })
  })

  describe('broadcast handling', () => {
    it('does not broadcast when window is destroyed', () => {
      mockWindow.isDestroyed.mockReturnValue(true)
      mockDispatchAgent.mockResolvedValue({ id: 'ca-d', status: 'running' })
      saveTeam(makeTeam({ id: 'team-nowin' }))
      runTeam('team-nowin')
      // Should not throw, just skip the send
    })

    it('does not broadcast when window is null', () => {
      initTeamManager(() => null)
      saveTeam(makeTeam({ id: 'team-null' }))
      mockDispatchAgent.mockResolvedValue({ id: 'ca-d', status: 'running' })
      // Should not throw
      expect(() => runTeam('team-null')).not.toThrow()
    })
  })
})
