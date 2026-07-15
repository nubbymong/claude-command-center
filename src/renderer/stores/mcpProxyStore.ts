import { create } from 'zustand'
import type { McpUpstream, McpUpstreamView } from '../../shared/types'

/** Fields the UI supplies to create an upstream (id is minted main-side). */
export type McpUpstreamDraft = Omit<McpUpstream, 'id'>

interface McpProxyState {
  upstreams: McpUpstreamView[]
  loading: boolean
  error: string | null

  load: () => Promise<void>
  add: (draft: McpUpstreamDraft) => Promise<boolean>
  update: (id: string, patch: Partial<McpUpstreamDraft>) => Promise<void>
  remove: (id: string) => Promise<void>
  start: (id: string) => Promise<void>
  stop: (id: string) => Promise<void>
  restart: (id: string) => Promise<void>
  handleChanged: (upstreams: McpUpstreamView[]) => void
}

export const useMcpProxyStore = create<McpProxyState>((set, get) => ({
  upstreams: [],
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true })
    try {
      const upstreams = await window.electronAPI.mcpProxy.list()
      set({ upstreams, loading: false, error: null })
    } catch (err: any) {
      set({ loading: false, error: err?.message || 'Failed to load upstreams' })
    }
  },

  add: async (draft) => {
    const res = await window.electronAPI.mcpProxy.add(draft)
    if (res.ok && res.upstreams) {
      set({ upstreams: res.upstreams, error: null })
      return true
    }
    set({ error: res.error || 'Failed to add upstream' })
    return false
  },

  update: async (id, patch) => {
    const res = await window.electronAPI.mcpProxy.update(id, patch)
    if (res.ok && res.upstreams) set({ upstreams: res.upstreams, error: null })
    else set({ error: res.error || 'Failed to update upstream' })
  },

  remove: async (id) => {
    const res = await window.electronAPI.mcpProxy.remove(id)
    if (res.upstreams) set({ upstreams: res.upstreams })
  },

  start: async (id) => {
    const res = await window.electronAPI.mcpProxy.start(id)
    if (res.upstreams) set({ upstreams: res.upstreams })
    if (!res.ok && res.error) set({ error: res.error })
  },

  stop: async (id) => {
    const res = await window.electronAPI.mcpProxy.stop(id)
    if (res.upstreams) set({ upstreams: res.upstreams })
  },

  restart: async (id) => {
    const res = await window.electronAPI.mcpProxy.restart(id)
    if (res.upstreams) set({ upstreams: res.upstreams })
    if (!res.ok && res.error) set({ error: res.error })
  },

  // Push updates from the main process (async connect/close/tool-list changes).
  handleChanged: (upstreams) => set({ upstreams }),
}))

// Idempotent global listener (mirrors conductorMcpStore).
let proxyListenerUnsub: (() => void) | null = null

export function setupMcpProxyListener(): () => void {
  if (proxyListenerUnsub) return proxyListenerUnsub
  proxyListenerUnsub = window.electronAPI.mcpProxy.onChanged((upstreams) => {
    useMcpProxyStore.getState().handleChanged(upstreams)
  })
  return proxyListenerUnsub
}
