/**
 * #371 BLOCKER-1 — `cloudAgent:remove` and `cloudAgent:clearCompleted` used to
 * answer a bare boolean / count that the store discarded, filtering the local
 * list unconditionally. A refused write (main could not read cloud-agents.json,
 * so it left the file alone) therefore made rows vanish from the Agent Hub and
 * reappear at the next restart. Main now rolls its own list back and answers
 * `{ ok:false, error }`; the renderer must keep its rows.
 *
 * The renderer still persists NOTHING for cloudAgents (see the note at the top
 * of cloudAgentStore.ts) — it only reads main's answer.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCloudAgentStore } from '../../../src/renderer/stores/cloudAgentStore'
import type { CloudAgent } from '../../../src/renderer/types/electron'

function makeAgent(overrides: Partial<CloudAgent> = {}): CloudAgent {
  return {
    id: 'ca-1',
    name: 'Test Agent',
    description: 'Test description',
    status: 'running',
    createdAt: 1,
    updatedAt: 1,
    projectPath: 'C:\\dev\\project',
    output: '',
    ...overrides,
  }
}

const api = () => (window as any).electronAPI.cloudAgent

describe('cloudAgentStore persistence failures (#371 BLOCKER-1)', () => {
  beforeEach(() => {
    useCloudAgentStore.setState({
      agents: [],
      selectedAgentId: null,
      filter: 'all',
      searchQuery: '',
      accountFilter: 'all',
      error: null,
    })
  })

  describe('remove', () => {
    it('leaves the agent IN the store when the write is refused', async () => {
      useCloudAgentStore.setState({ agents: [makeAgent({ id: 'a1' }), makeAgent({ id: 'a2' })] })
      api().remove.mockResolvedValueOnce({ ok: false, error: 'agents file unreadable' })

      const result = await useCloudAgentStore.getState().remove('a1')

      expect(result.ok).toBe(false)
      expect(useCloudAgentStore.getState().agents.map(a => a.id)).toEqual(['a1', 'a2'])
      expect(useCloudAgentStore.getState().error).toBe('agents file unreadable')
    })

    it('keeps the selection on a refused remove', async () => {
      useCloudAgentStore.setState({ agents: [makeAgent({ id: 'a1' })], selectedAgentId: 'a1' })
      api().remove.mockResolvedValueOnce({ ok: false, error: 'nope' })

      await useCloudAgentStore.getState().remove('a1')

      expect(useCloudAgentStore.getState().selectedAgentId).toBe('a1')
    })

    it('writes nothing itself on failure — main owns cloud-agents.json', async () => {
      const saveSpy = (window as any).electronAPI.config.save as ReturnType<typeof vi.fn>
      saveSpy.mockClear()
      useCloudAgentStore.setState({ agents: [makeAgent({ id: 'a1' })] })
      api().remove.mockResolvedValueOnce({ ok: false, error: 'nope' })

      await useCloudAgentStore.getState().remove('a1')

      expect(saveSpy).not.toHaveBeenCalled()
    })

    it('drops the row and clears the error on success', async () => {
      useCloudAgentStore.setState({
        agents: [makeAgent({ id: 'a1' }), makeAgent({ id: 'a2' })],
        selectedAgentId: 'a1',
        error: 'stale failure from a previous attempt',
      })
      api().remove.mockResolvedValueOnce({ ok: true, removed: true })

      const result = await useCloudAgentStore.getState().remove('a1')

      expect(result.ok).toBe(true)
      expect(useCloudAgentStore.getState().agents.map(a => a.id)).toEqual(['a2'])
      expect(useCloudAgentStore.getState().selectedAgentId).toBeNull()
      expect(useCloudAgentStore.getState().error).toBeNull()
    })
  })

  describe('clearCompleted', () => {
    it('leaves every finished agent IN the store when the write is refused', async () => {
      useCloudAgentStore.setState({
        agents: [
          makeAgent({ id: 'a1', status: 'completed' }),
          makeAgent({ id: 'a2', status: 'failed' }),
          makeAgent({ id: 'a3', status: 'running' }),
        ],
      })
      api().clearCompleted.mockResolvedValueOnce({ ok: false, error: 'agents file unreadable' })

      const result = await useCloudAgentStore.getState().clearCompleted()

      expect(result.ok).toBe(false)
      expect(useCloudAgentStore.getState().agents.map(a => a.id)).toEqual(['a1', 'a2', 'a3'])
      expect(useCloudAgentStore.getState().error).toBe('agents file unreadable')
    })

    it('filters the finished agents and clears the error on success', async () => {
      useCloudAgentStore.setState({
        agents: [
          makeAgent({ id: 'a1', status: 'completed' }),
          makeAgent({ id: 'a3', status: 'running' }),
        ],
        selectedAgentId: 'a1',
        error: 'stale failure from a previous attempt',
      })
      api().clearCompleted.mockResolvedValueOnce({ ok: true, removed: 1 })

      const result = await useCloudAgentStore.getState().clearCompleted()

      expect(result.ok).toBe(true)
      expect(useCloudAgentStore.getState().agents.map(a => a.id)).toEqual(['a3'])
      expect(useCloudAgentStore.getState().selectedAgentId).toBeNull()
      expect(useCloudAgentStore.getState().error).toBeNull()
    })
  })

  describe('clearError', () => {
    it('retires a failure message the user has read', async () => {
      useCloudAgentStore.setState({ agents: [makeAgent({ id: 'a1' })] })
      api().remove.mockResolvedValueOnce({ ok: false, error: 'boom' })
      await useCloudAgentStore.getState().remove('a1')
      expect(useCloudAgentStore.getState().error).toBe('boom')

      useCloudAgentStore.getState().clearError()

      expect(useCloudAgentStore.getState().error).toBeNull()
    })
  })
})
