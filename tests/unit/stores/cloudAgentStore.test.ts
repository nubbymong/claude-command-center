import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCloudAgentStore } from '../../../src/renderer/stores/cloudAgentStore'
import type { CloudAgent } from '../../../src/renderer/types/electron'

function makeAgent(overrides: Partial<CloudAgent> = {}): CloudAgent {
  return {
    id: 'ca-' + Math.random().toString(36).slice(2, 8),
    name: 'Test Agent',
    description: 'Test description',
    status: 'running',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    projectPath: 'C:\\dev\\project',
    output: '',
    ...overrides,
  }
}

describe('cloudAgentStore', () => {
  beforeEach(() => {
    useCloudAgentStore.setState({
      agents: [],
      selectedAgentId: null,
      filter: 'all',
      searchQuery: '',
    })
  })

  describe('hydrate', () => {
    it('sets agents array', () => {
      const agents = [makeAgent({ id: 'a1' }), makeAgent({ id: 'a2' })]
      useCloudAgentStore.getState().hydrate(agents)
      expect(useCloudAgentStore.getState().agents).toHaveLength(2)
    })

    it('handles null/undefined gracefully', () => {
      useCloudAgentStore.getState().hydrate(null as any)
      expect(useCloudAgentStore.getState().agents).toEqual([])
    })
  })

  describe('dispatch', () => {
    it('calls electronAPI and sets selectedAgentId (does not add to store — handleStatusChanged does that)', async () => {
      await useCloudAgentStore.getState().dispatch({
        name: 'Auth Fix',
        description: 'Fix auth module',
        projectPath: 'C:\\dev',
      })
      const state = useCloudAgentStore.getState()
      // dispatch no longer adds the agent — handleStatusChanged listener does
      expect(state.agents).toHaveLength(0)
      expect(state.selectedAgentId).toBe('ca-mock123')
    })
  })

  describe('remove', () => {
    it('removes agent from store', async () => {
      useCloudAgentStore.setState({
        agents: [makeAgent({ id: 'a1' }), makeAgent({ id: 'a2' })],
      })
      await useCloudAgentStore.getState().remove('a1')
      expect(useCloudAgentStore.getState().agents).toHaveLength(1)
      expect(useCloudAgentStore.getState().agents[0].id).toBe('a2')
    })

    it('clears selectedAgentId if removed agent was selected', async () => {
      useCloudAgentStore.setState({
        agents: [makeAgent({ id: 'a1' })],
        selectedAgentId: 'a1',
      })
      await useCloudAgentStore.getState().remove('a1')
      expect(useCloudAgentStore.getState().selectedAgentId).toBeNull()
    })
  })

  describe('selectAgent / setFilter / setSearchQuery', () => {
    it('sets selectedAgentId', () => {
      useCloudAgentStore.getState().selectAgent('a1')
      expect(useCloudAgentStore.getState().selectedAgentId).toBe('a1')
    })

    it('sets filter', () => {
      useCloudAgentStore.getState().setFilter('running')
      expect(useCloudAgentStore.getState().filter).toBe('running')
    })

    it('sets search query', () => {
      useCloudAgentStore.getState().setSearchQuery('auth')
      expect(useCloudAgentStore.getState().searchQuery).toBe('auth')
    })
  })

  describe('handleStatusChanged', () => {
    it('updates existing agent in place', () => {
      useCloudAgentStore.setState({
        agents: [makeAgent({ id: 'a1', status: 'running' })],
      })
      useCloudAgentStore.getState().handleStatusChanged(
        makeAgent({ id: 'a1', status: 'completed', duration: 5000 })
      )
      expect(useCloudAgentStore.getState().agents[0].status).toBe('completed')
      expect(useCloudAgentStore.getState().agents[0].duration).toBe(5000)
    })

    it('adds new agent if not found', () => {
      useCloudAgentStore.getState().handleStatusChanged(
        makeAgent({ id: 'new', status: 'running' })
      )
      expect(useCloudAgentStore.getState().agents).toHaveLength(1)
      expect(useCloudAgentStore.getState().agents[0].id).toBe('new')
    })
  })

  describe('handleOutputChunk', () => {
    it('appends output to correct agent', () => {
      useCloudAgentStore.setState({
        agents: [makeAgent({ id: 'a1', output: 'Hello ' })],
      })
      useCloudAgentStore.getState().handleOutputChunk({ id: 'a1', chunk: 'World' })
      expect(useCloudAgentStore.getState().agents[0].output).toBe('Hello World')
    })

    it('ignores chunks for unknown agents', () => {
      useCloudAgentStore.setState({ agents: [] })
      useCloudAgentStore.getState().handleOutputChunk({ id: 'unknown', chunk: 'data' })
      expect(useCloudAgentStore.getState().agents).toHaveLength(0)
    })
  })

  describe('getFilteredAgents', () => {
    const agents = [
      makeAgent({ id: 'a1', name: 'Auth', status: 'running', createdAt: 1000 }),
      makeAgent({ id: 'a2', name: 'Tests', status: 'completed', createdAt: 2000 }),
      makeAgent({ id: 'a3', name: 'Deploy', status: 'failed', createdAt: 3000 }),
      makeAgent({ id: 'a4', name: 'Auth Fix', status: 'pending', createdAt: 4000 }),
    ]

    beforeEach(() => {
      useCloudAgentStore.setState({ agents, filter: 'all', searchQuery: '' })
    })

    it('returns all agents sorted (running first, then newest)', () => {
      const result = useCloudAgentStore.getState().getFilteredAgents()
      expect(result).toHaveLength(4)
      // Running/pending should come first
      expect(['running', 'pending']).toContain(result[0].status)
      expect(['running', 'pending']).toContain(result[1].status)
    })

    it('filters by running status', () => {
      useCloudAgentStore.setState({ filter: 'running' })
      const result = useCloudAgentStore.getState().getFilteredAgents()
      expect(result).toHaveLength(2)
      result.forEach(a => expect(['running', 'pending']).toContain(a.status))
    })

    it('filters by completed status', () => {
      useCloudAgentStore.setState({ filter: 'completed' })
      const result = useCloudAgentStore.getState().getFilteredAgents()
      expect(result).toHaveLength(1)
      expect(result[0].status).toBe('completed')
    })

    it('filters by failed status', () => {
      useCloudAgentStore.setState({ filter: 'failed' })
      const result = useCloudAgentStore.getState().getFilteredAgents()
      expect(result).toHaveLength(1)
      expect(result[0].status).toBe('failed')
    })

    it('filters by search query (name)', () => {
      useCloudAgentStore.setState({ searchQuery: 'auth' })
      const result = useCloudAgentStore.getState().getFilteredAgents()
      expect(result).toHaveLength(2)
      result.forEach(a => expect(a.name.toLowerCase()).toContain('auth'))
    })

    it('combines filter and search', () => {
      useCloudAgentStore.setState({ filter: 'running', searchQuery: 'auth' })
      const result = useCloudAgentStore.getState().getFilteredAgents()
      // 'running' filter includes running + pending; 'auth' matches a1 (Auth) and a4 (Auth Fix)
      expect(result).toHaveLength(2)
      const ids = result.map(a => a.id)
      expect(ids).toContain('a1')
      expect(ids).toContain('a4')
    })
  })

  describe('getCounts', () => {
    it('returns correct counts by status', () => {
      useCloudAgentStore.setState({
        agents: [
          makeAgent({ status: 'running' }),
          makeAgent({ status: 'pending' }),
          makeAgent({ status: 'completed' }),
          makeAgent({ status: 'completed' }),
          makeAgent({ status: 'failed' }),
          makeAgent({ status: 'cancelled' }),
        ],
      })
      const counts = useCloudAgentStore.getState().getCounts()
      expect(counts.all).toBe(6)
      expect(counts.running).toBe(2) // running + pending
      expect(counts.completed).toBe(2)
      expect(counts.failed).toBe(2) // failed + cancelled
    })

    it('returns zeros for empty store', () => {
      const counts = useCloudAgentStore.getState().getCounts()
      expect(counts).toEqual({ all: 0, running: 0, completed: 0, failed: 0 })
    })
  })
})
