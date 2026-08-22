/**
 * #371 BLOCKER-1 — a refused/failed disk write must not be reported as success.
 *
 * `team:save` and `team:delete` used to answer the saved team / a bare boolean,
 * and the store mutated regardless. A write the main process REFUSED (the teams
 * file could not be read, so it was left alone) or that simply failed therefore
 * showed as a saved pipeline that was gone on the next restart — or as a deleted
 * one that came back. Main now answers `{ ok:false, error }` and rolls its own
 * in-memory library back; the store must do the same and keep local state.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useTeamStore } from '../../../src/renderer/stores/teamStore'
import type { TeamTemplate } from '../../../src/renderer/types/electron'

function makeTeam(overrides: Partial<TeamTemplate> = {}): TeamTemplate {
  return {
    id: 'team-t1',
    name: 'Test Pipeline',
    description: 'Test description',
    steps: [{ id: 'ts-1', templateId: 'builtin-code-reviewer', label: 'Code Review', mode: 'sequential' }],
    projectPath: '/dev/project',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

const api = () => (window as any).electronAPI.team

describe('teamStore persistence failures (#371 BLOCKER-1)', () => {
  beforeEach(() => {
    useTeamStore.setState({
      teams: [],
      runs: [],
      selectedTeamId: null,
      selectedRunId: null,
      showBuilder: false,
      editingTeam: null,
      error: null,
    })
  })

  describe('saveTeam', () => {
    it('leaves the team OUT of the store when the write is refused', async () => {
      api().save.mockResolvedValueOnce({ ok: false, error: 'teams file unreadable' })
      const result = await useTeamStore.getState().saveTeam(makeTeam({ id: 'team-new' }))

      expect(result.ok).toBe(false)
      // The pipeline is NOT on disk, so it must not be on screen either.
      expect(useTeamStore.getState().teams).toHaveLength(0)
    })

    it('sets the store error to what main reported', async () => {
      api().save.mockResolvedValueOnce({ ok: false, error: 'teams file unreadable' })
      const result = await useTeamStore.getState().saveTeam(makeTeam())

      expect(result.error).toBe('teams file unreadable')
      expect(useTeamStore.getState().error).toBe('teams file unreadable')
    })

    it('falls back to a plain-English error when main sends none', async () => {
      api().save.mockResolvedValueOnce({ ok: false })
      const result = await useTeamStore.getState().saveTeam(makeTeam())

      expect(result.ok).toBe(false)
      expect(result.error).toBeTruthy()
      expect(useTeamStore.getState().error).toBeTruthy()
    })

    it('leaves an EXISTING team at its old value when the update is refused', async () => {
      useTeamStore.setState({ teams: [makeTeam({ id: 'team-t1', name: 'Old name' })] })
      api().save.mockResolvedValueOnce({ ok: false, error: 'disk full' })

      await useTeamStore.getState().saveTeam(makeTeam({ id: 'team-t1', name: 'New name' }))

      expect(useTeamStore.getState().teams).toHaveLength(1)
      expect(useTeamStore.getState().teams[0].name).toBe('Old name')
    })

    it('keeps the builder OPEN on failure so the work is not discarded', async () => {
      useTeamStore.setState({ showBuilder: true, editingTeam: makeTeam() })
      api().save.mockResolvedValueOnce({ ok: false, error: 'nope' })

      await useTeamStore.getState().saveTeam(makeTeam())

      expect(useTeamStore.getState().showBuilder).toBe(true)
      expect(useTeamStore.getState().editingTeam).not.toBeNull()
    })

    it('commits the team main returned and clears the error on success', async () => {
      useTeamStore.setState({ error: 'stale failure from a previous attempt' })
      api().save.mockResolvedValueOnce({ ok: true, team: makeTeam({ id: 'team-saved', name: 'Persisted' }) })

      const result = await useTeamStore.getState().saveTeam(makeTeam({ id: 'team-saved' }))

      expect(result.ok).toBe(true)
      expect(useTeamStore.getState().teams.map(t => t.id)).toEqual(['team-saved'])
      expect(useTeamStore.getState().teams[0].name).toBe('Persisted')
      expect(useTeamStore.getState().error).toBeNull()
      expect(useTeamStore.getState().showBuilder).toBe(false)
    })
  })

  describe('deleteTeam', () => {
    it('leaves the row IN the store when the delete is refused', async () => {
      useTeamStore.setState({ teams: [makeTeam({ id: 't1' }), makeTeam({ id: 't2' })] })
      api().delete.mockResolvedValueOnce({ ok: false, error: 'teams file unreadable' })

      const result = await useTeamStore.getState().deleteTeam('t1')

      expect(result.ok).toBe(false)
      expect(useTeamStore.getState().teams.map(t => t.id)).toEqual(['t1', 't2'])
      expect(useTeamStore.getState().error).toBe('teams file unreadable')
    })

    it('keeps the selection on a refused delete', async () => {
      useTeamStore.setState({ teams: [makeTeam({ id: 't1' })], selectedTeamId: 't1' })
      api().delete.mockResolvedValueOnce({ ok: false, error: 'nope' })

      await useTeamStore.getState().deleteTeam('t1')

      expect(useTeamStore.getState().selectedTeamId).toBe('t1')
    })

    it('removes the row and clears the error on success', async () => {
      useTeamStore.setState({
        teams: [makeTeam({ id: 't1' }), makeTeam({ id: 't2' })],
        selectedTeamId: 't1',
        error: 'stale failure from a previous attempt',
      })
      api().delete.mockResolvedValueOnce({ ok: true, deleted: true })

      const result = await useTeamStore.getState().deleteTeam('t1')

      expect(result.ok).toBe(true)
      expect(useTeamStore.getState().teams.map(t => t.id)).toEqual(['t2'])
      expect(useTeamStore.getState().selectedTeamId).toBeNull()
      expect(useTeamStore.getState().error).toBeNull()
    })
  })

  describe('clearError', () => {
    it('retires a failure message the user has read', async () => {
      api().save.mockResolvedValueOnce({ ok: false, error: 'boom' })
      await useTeamStore.getState().saveTeam(makeTeam())
      expect(useTeamStore.getState().error).toBe('boom')

      useTeamStore.getState().clearError()

      expect(useTeamStore.getState().error).toBeNull()
    })
  })
})
