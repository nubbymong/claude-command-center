import { create } from 'zustand'
import type { MemoryFile, MemoryProject, SchemaWarning, MemoryScanResult } from '../../shared/types'

interface MemoryState {
  // Data
  projects: MemoryProject[]
  memories: MemoryFile[]
  warnings: SchemaWarning[]
  totalSize: number
  scannedAt: number

  // UI state
  loading: boolean
  error: string | null
  selectedProject: string | null // projectDir or null for all
  selectedMemoryId: string | null
  searchQuery: string
  collapsedGroups: Set<string>
  selectedContent: string | null // content of selected memory

  // Drilldown filter/sort state
  scopeFilter: 'all' | 'active30d' | 'stale'
  typeFilter: string | null
  sortBy: 'modified' | 'size' | 'name'
  sortDir: 'asc' | 'desc'

  // Recent sessions cache: projectDir → rows
  recentSessions: Record<string, Array<{ sessionId: string; lastActive: number }>>

  // Actions
  scan: () => Promise<void>
  selectProject: (dir: string | null) => void
  selectMemory: (id: string | null) => Promise<void>
  setSearch: (query: string) => void
  toggleGroup: (type: string) => void
  deleteMemory: (id: string) => Promise<void>
  writeFrontmatter: (id: string, frontmatter: { name?: string; description?: string; type?: string }) => Promise<void>
  dismissWarnings: () => void
  setScopeFilter: (f: 'all' | 'active30d' | 'stale') => void
  setTypeFilter: (t: string | null) => void
  setSort: (k: 'modified' | 'size' | 'name') => void
}

export const useMemoryStore = create<MemoryState>((set, get) => ({
  projects: [],
  memories: [],
  warnings: [],
  totalSize: 0,
  scannedAt: 0,

  loading: false,
  error: null,
  selectedProject: null,
  selectedMemoryId: null,
  searchQuery: '',
  collapsedGroups: new Set(),
  selectedContent: null,

  scopeFilter: 'all',
  typeFilter: null,
  sortBy: 'modified',
  sortDir: 'desc',
  recentSessions: {},

  scan: async () => {
    set({ loading: true, error: null })
    try {
      const result: MemoryScanResult = await window.electronAPI.memory.scan()
      set({
        projects: result.projects,
        memories: result.memories,
        warnings: result.warnings,
        totalSize: result.totalSize,
        scannedAt: result.scannedAt,
        loading: false,
        recentSessions: {},
      })
    } catch (err) {
      set({ loading: false, error: String(err) })
    }
  },

  selectProject: (dir) => {
    set({ selectedProject: dir, selectedMemoryId: null, selectedContent: null, typeFilter: null })
    if (dir !== null && !get().recentSessions[dir]) {
      void window.electronAPI.memory.recentSessions(dir)
        .then((rows) => set({ recentSessions: { ...get().recentSessions, [dir]: rows } }))
        .catch(() => set({ recentSessions: { ...get().recentSessions, [dir]: [] } }))
    }
  },

  selectMemory: async (id) => {
    if (!id) {
      set({ selectedMemoryId: null, selectedContent: null })
      return
    }
    const mem = get().memories.find(m => m.id === id)
    if (!mem) return
    set({ selectedMemoryId: id, selectedContent: null })
    try {
      const content = await window.electronAPI.memory.read(mem.path)
      // Only update if still selected (user may have clicked elsewhere)
      if (get().selectedMemoryId === id) {
        set({ selectedContent: content })
      }
    } catch {
      set({ selectedContent: '(Failed to read file)' })
    }
  },

  setSearch: (query) => set({ searchQuery: query }),

  toggleGroup: (type) => {
    const groups = new Set(get().collapsedGroups)
    if (groups.has(type)) groups.delete(type)
    else groups.add(type)
    set({ collapsedGroups: groups })
  },

  deleteMemory: async (id) => {
    const mem = get().memories.find(m => m.id === id)
    if (!mem) return
    try {
      await window.electronAPI.memory.delete(mem.path)
      // Remove from local state and re-scan
      set({ selectedMemoryId: null, selectedContent: null })
      get().scan()
    } catch (err) {
      console.error('[memoryStore] Delete failed:', err)
    }
  },

  writeFrontmatter: async (id, frontmatter) => {
    const mem = get().memories.find(m => m.id === id)
    if (!mem) return
    try {
      await window.electronAPI.memory.writeFrontmatter(mem.path, frontmatter)
      get().scan() // Re-scan to pick up changes
    } catch (err) {
      console.error('[memoryStore] Write frontmatter failed:', err)
    }
  },

  dismissWarnings: () => set({ warnings: [] }),

  setScopeFilter: (f) => set({ scopeFilter: f }),

  setTypeFilter: (t) => set({ typeFilter: t }),

  setSort: (k) => {
    const { sortBy, sortDir } = get()
    if (k === sortBy) {
      set({ sortDir: sortDir === 'desc' ? 'asc' : 'desc' })
    } else {
      set({ sortBy: k, sortDir: 'desc' })
    }
  },
}))
