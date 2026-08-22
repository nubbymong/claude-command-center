import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock config-manager
const mockReadConfig = vi.fn()
const mockWriteConfig = vi.fn(() => true)
/** #371: names the keys whose file EXISTS and cannot be read. The two files are
 *  independent, so one failing must not latch the other. */
const cfg = { readFails: new Set<string>() }
vi.mock('../../src/main/config-manager', () => ({
  readConfig: (...args: any[]) => mockReadConfig(...args),
  readConfigChecked: (key: string) => {
    if (cfg.readFails.has(key)) return { value: null, outcome: 'failed' }
    const v = mockReadConfig(key)
    return v == null ? { value: null, outcome: 'absent' } : { value: v, outcome: 'ok' }
  },
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
  waitForBatch,
  _resetTeamLatchesForTest,
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
    cfg.readFails.clear()
    _resetTeamLatchesForTest()
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
      expect(saved.ok).toBe(true)
      expect(saved.team!.id).toBe('team-new')
      expect(listTeams()).toHaveLength(1)
      expect(mockWriteConfig).toHaveBeenCalledWith('agentTeams', expect.any(Array))
    })

    it('updates existing team', () => {
      saveTeam(makeTeam({ id: 'team-1', name: 'Original' }))
      const updated = saveTeam(makeTeam({ id: 'team-1', name: 'Updated' }))
      expect(updated.team!.name).toBe('Updated')
      expect(listTeams()).toHaveLength(1)
    })

    it('generates ID if missing', () => {
      const team = makeTeam({ id: '' })
      const saved = saveTeam(team)
      expect(saved.team!.id).toMatch(/^team-/)
    })

    it('sets timestamps', () => {
      const before = Date.now()
      const saved = saveTeam(makeTeam({ id: 'team-ts', createdAt: 0, updatedAt: 0 }))
      expect(saved.team!.updatedAt).toBeGreaterThanOrEqual(before)
    })
  })

  describe('deleteTeam', () => {
    it('removes team from list', () => {
      saveTeam(makeTeam({ id: 'team-a' }))
      saveTeam(makeTeam({ id: 'team-b' }))
      expect(deleteTeam('team-a')).toEqual({ ok: true, deleted: true })
      expect(listTeams()).toHaveLength(1)
      expect(listTeams()[0].id).toBe('team-b')
    })

    it('returns false for unknown id', () => {
      expect(deleteTeam('nonexistent')).toEqual({ ok: true, deleted: false })
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

  describe('waitForBatch (timer lifecycle)', () => {
    afterEach(() => { vi.useRealTimers() })

    const oneStepRun = (stepStatus: 'running' | 'completed' | 'failed' | 'cancelled') =>
      makeRun({ status: 'running', steps: [{ stepId: 'ts-1', agentId: 'ca-a1', status: stepStatus, label: 'X' }] })

    it('clears its interval and timeout when the batch completes (no leak)', async () => {
      vi.useFakeTimers()
      const run = oneStepRun('running')
      const p = waitForBatch(run, ['ts-1'])
      run.steps[0].status = 'completed'
      await vi.advanceTimersByTimeAsync(500)
      await p
      expect(vi.getTimerCount()).toBe(0)
    })

    it('clears its timers when the run is cancelled mid-wait', async () => {
      vi.useFakeTimers()
      const run = oneStepRun('running')
      const p = waitForBatch(run, ['ts-1'])
      run.status = 'cancelled'
      await vi.advanceTimersByTimeAsync(500)
      await p
      expect(vi.getTimerCount()).toBe(0)
    })

    it('arms no timers when the batch is already terminal', async () => {
      vi.useFakeTimers()
      const run = oneStepRun('completed')
      await waitForBatch(run, ['ts-1'])
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  /**
   * #371 — a failed read of agent-teams.json is not an empty team library.
   *
   * This is the highest-value one of the five: the library is user-authored
   * work, and the very next `saveTeam()` used to write a ONE-element array over
   * the whole thing.
   */
  describe('a read failure is not an absence', () => {
    it('refuses to save the team library over a file it could not read, and SAYS SO', () => {
      cfg.readFails.add('agentTeams')
      initTeamManager(() => mockWindow)
      expect(listTeams()).toHaveLength(0) // the empty library the failure produced

      // Review BLOCKER-1: this used to return the team as though it had saved,
      // so the editor closed and the work was gone on the next restart.
      const res = saveTeam(makeTeam({ id: 'team-new' }))
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(/could not be read/i)
      expect(mockWriteConfig).not.toHaveBeenCalledWith('agentTeams', expect.anything())
      // …and the in-memory library is rolled back, so the screen keeps matching
      // the disk rather than showing a team that does not exist.
      expect(listTeams()).toHaveLength(0)
    })

    it('after a failed load there is nothing to delete, so a delete never reaches disk', () => {
      // Stated as it actually is rather than as a latch assertion: a failed
      // load leaves the library EMPTY, so `deleteTeam` finds nothing and
      // returns before it would ever persist. The refusal path is unreachable
      // from here — the write-failure test below is the one that exercises the
      // reporting.
      cfg.readFails.add('agentTeams')
      mockReadConfig.mockImplementation(() => null)
      initTeamManager(() => mockWindow)
      expect(deleteTeam('team-test1')).toEqual({ ok: true, deleted: false })
      expect(mockWriteConfig).not.toHaveBeenCalledWith('agentTeams', expect.anything())
    })

    it('a delete whose WRITE fails is reported, and the row stays', () => {
      const a = makeTeam({ id: 'team-a' })
      mockReadConfig.mockImplementation((key: string) => (key === 'agentTeams' ? [a] : null))
      initTeamManager(() => mockWindow)

      mockWriteConfig.mockReturnValueOnce(false)
      const res = deleteTeam('team-a')
      expect(res.ok).toBe(false)
      expect(res.error).toBeTruthy()
      // Rolled back: the UI must not show the row gone when disk still has it.
      expect(listTeams().map((t) => t.id)).toEqual(['team-a'])
    })

    it('a save whose WRITE fails is reported, and the team is not added', () => {
      initTeamManager(() => mockWindow)
      mockWriteConfig.mockReturnValueOnce(false)
      expect(saveTeam(makeTeam({ id: 'team-x' })).ok).toBe(false)
      expect(listTeams()).toHaveLength(0)
    })

    it('one file failing does not latch the other', () => {
      cfg.readFails.add('agentTeams')
      mockReadConfig.mockImplementation((key: string) =>
        key === 'agentTeamRuns' ? [makeRun({ status: 'running' })] : null,
      )
      initTeamManager(() => mockWindow)

      // The boot sweep marks the stuck run failed and persists it — runs read fine.
      expect(mockWriteConfig).toHaveBeenCalledWith('agentTeamRuns', expect.any(Array))
      // …while the unreadable team library is left alone.
      expect(mockWriteConfig).not.toHaveBeenCalledWith('agentTeams', expect.anything())
    })

    it('an ABSENT file still saves — a fresh install must be able to save its first team', () => {
      initTeamManager(() => mockWindow)
      saveTeam(makeTeam())
      expect(mockWriteConfig).toHaveBeenCalledWith('agentTeams', expect.any(Array))
    })

    /**
     * Review MAJOR-1. `initTeamManager` runs ONCE, at boot, so the first cut's
     * "a later successful load clears the latch" had no production path: one
     * transient lock at startup disabled team persistence for the whole
     * process. The old test proved recovery by calling `initTeamManager` a
     * second time — a seam the app never reaches.
     *
     * This drives the real one: init once, the lock lifts, and the NEXT SAVE
     * recovers by itself.
     */
    it('recovers on the next save, with no second load — the production path', () => {
      const existing = makeTeam({ id: 'team-existing', name: 'Built last week' })
      mockReadConfig.mockImplementation((key: string) => (key === 'agentTeams' ? [existing] : null))
      cfg.readFails.add('agentTeams')
      initTeamManager(() => mockWindow)
      expect(listTeams()).toHaveLength(0)

      // The AV scanner lets go. Nothing re-initialises; the user just saves.
      cfg.readFails.clear()
      const res = saveTeam(makeTeam({ id: 'team-new', name: 'Built now' }))

      expect(res.ok).toBe(true)
      // The library that was on disk is BACK, and the new team is with it —
      // the whole point of folding the recovered file in before writing.
      const written = mockWriteConfig.mock.calls.filter((c: any[]) => c[0] === 'agentTeams').at(-1)![1] as any[]
      expect(written.map((t) => t.id).sort()).toEqual(['team-existing', 'team-new'])
      expect(listTeams().map((t) => t.id).sort()).toEqual(['team-existing', 'team-new'])
    })

    it('keeps refusing while the file is STILL unreadable', () => {
      cfg.readFails.add('agentTeams')
      initTeamManager(() => mockWindow)
      for (let i = 0; i < 3; i++) expect(saveTeam(makeTeam({ id: `t-${i}` })).ok).toBe(false)
      expect(mockWriteConfig).not.toHaveBeenCalledWith('agentTeams', expect.anything())
    })
  })
})
