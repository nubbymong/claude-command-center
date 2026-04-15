import { create } from 'zustand'
import type { CloudAgent, CloudAgentStatus } from '../types/electron'

type FilterType = 'all' | 'running' | 'completed' | 'failed'

interface CloudAgentState {
  agents: CloudAgent[]
  selectedAgentId: string | null
  filter: FilterType
  searchQuery: string

  hydrate: (agents: CloudAgent[]) => void
  dispatch: (params: { name: string; description: string; projectPath: string; configId?: string; legacyVersion?: { enabled: boolean; version: string } }) => Promise<void>
  cancel: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  retry: (id: string) => Promise<void>
  clearCompleted: () => Promise<void>
  selectAgent: (id: string | null) => void
  setFilter: (filter: FilterType) => void
  setSearchQuery: (query: string) => void

  handleStatusChanged: (agent: CloudAgent) => void
  handleOutputChunk: (data: { id: string; chunk: string }) => void

  getFilteredAgents: () => CloudAgent[]
  getCounts: () => { all: number; running: number; completed: number; failed: number }
}

let saveTimeout: ReturnType<typeof setTimeout> | null = null

function saveConfigDebounced(agents: CloudAgent[]): void {
  if (saveTimeout) clearTimeout(saveTimeout)
  saveTimeout = setTimeout(() => {
    window.electronAPI.config.save('cloudAgents', agents)
  }, 2000)
}

function saveConfigNow(agents: CloudAgent[]): void {
  if (saveTimeout) clearTimeout(saveTimeout)
  window.electronAPI.config.save('cloudAgents', agents)
}

export const useCloudAgentStore = create<CloudAgentState>((set, get) => ({
  agents: [],
  selectedAgentId: null,
  filter: 'all',
  searchQuery: '',

  hydrate: (agents: CloudAgent[]) => {
    set({ agents: agents || [] })
  },

  dispatch: async (params) => {
    try {
      const agent = await window.electronAPI.cloudAgent.dispatch(params)
      // Don't add agent here — handleStatusChanged listener already added it
      // from the broadcastStatus() call in the main process. Just select it.
      set({ selectedAgentId: agent.id })
    } catch (err: any) {
      console.error('[cloudAgentStore] dispatch failed:', err)
    }
  },

  cancel: async (id: string) => {
    await window.electronAPI.cloudAgent.cancel(id)
  },

  remove: async (id: string) => {
    await window.electronAPI.cloudAgent.remove(id)
    set(state => {
      const agents = state.agents.filter(a => a.id !== id)
      const selectedAgentId = state.selectedAgentId === id ? null : state.selectedAgentId
      saveConfigNow(agents)
      return { agents, selectedAgentId }
    })
  },

  retry: async (id: string) => {
    const newAgent = await window.electronAPI.cloudAgent.retry(id)
    if (newAgent) {
      // Don't add — handleStatusChanged listener already added it from broadcast
      set({ selectedAgentId: newAgent.id })
    }
  },

  clearCompleted: async () => {
    await window.electronAPI.cloudAgent.clearCompleted()
    set(state => {
      const agents = state.agents.filter(a => a.status === 'running' || a.status === 'pending')
      const selectedAgentId = agents.find(a => a.id === state.selectedAgentId)
        ? state.selectedAgentId
        : null
      return { agents, selectedAgentId }
    })
  },

  selectAgent: (id: string | null) => set({ selectedAgentId: id }),
  setFilter: (filter: FilterType) => set({ filter }),
  setSearchQuery: (query: string) => set({ searchQuery: query }),

  handleStatusChanged: (agent: CloudAgent) => {
    set(state => {
      const agents = [...state.agents]
      const idx = agents.findIndex(a => a.id === agent.id)
      if (idx >= 0) {
        agents[idx] = { ...agents[idx], ...agent }
      } else {
        agents.unshift(agent)
      }
      saveConfigNow(agents)
      return { agents }
    })
  },

  handleOutputChunk: (data: { id: string; chunk: string }) => {
    set(state => {
      const agents = [...state.agents]
      const idx = agents.findIndex(a => a.id === data.id)
      if (idx >= 0) {
        agents[idx] = { ...agents[idx], output: agents[idx].output + data.chunk }
        saveConfigDebounced(agents)
        return { agents }
      }
      return state
    })
  },

  getFilteredAgents: () => {
    const { agents, filter, searchQuery } = get()
    let filtered = agents

    if (filter === 'running') {
      filtered = filtered.filter(a => a.status === 'running' || a.status === 'pending')
    } else if (filter === 'completed') {
      filtered = filtered.filter(a => a.status === 'completed')
    } else if (filter === 'failed') {
      filtered = filtered.filter(a => a.status === 'failed' || a.status === 'cancelled')
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      filtered = filtered.filter(a =>
        a.name.toLowerCase().includes(q) || a.description.toLowerCase().includes(q)
      )
    }

    // Sort: running first, then by newest
    return filtered.sort((a, b) => {
      const aRunning = a.status === 'running' || a.status === 'pending' ? 1 : 0
      const bRunning = b.status === 'running' || b.status === 'pending' ? 1 : 0
      if (aRunning !== bRunning) return bRunning - aRunning
      return b.createdAt - a.createdAt
    })
  },

  getCounts: () => {
    const { agents } = get()
    return {
      all: agents.length,
      running: agents.filter(a => a.status === 'running' || a.status === 'pending').length,
      completed: agents.filter(a => a.status === 'completed').length,
      failed: agents.filter(a => a.status === 'failed' || a.status === 'cancelled').length,
    }
  },
}))

// Set up IPC listeners once globally — never tear down.
// Previously tied to CloudAgentsPage mount/unmount, which meant status updates
// were missed while the user was on a different page.
let listenerSetup = false
export function setupCloudAgentListener(): void {
  if (listenerSetup) return
  listenerSetup = true

  window.electronAPI.cloudAgent.onStatusChanged((agent) => {
    useCloudAgentStore.getState().handleStatusChanged(agent)
  })

  window.electronAPI.cloudAgent.onOutputChunk((data) => {
    useCloudAgentStore.getState().handleOutputChunk(data)
  })
}
