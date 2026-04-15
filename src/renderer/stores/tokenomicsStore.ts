import { create } from 'zustand'
import type {
  TokenomicsData,
  TokenomicsSyncProgress,
  TokenomicsSessionRecord,
  TokenomicsDailyAggregate,
} from '../../shared/types'

interface TokenomicsState {
  data: TokenomicsData | null
  loading: boolean
  seeding: boolean
  syncing: boolean
  progress: TokenomicsSyncProgress | null
  error: string | null

  loadData: () => Promise<void>
  startSeed: () => Promise<void>
  startSync: () => Promise<void>
  handleProgress: (progress: TokenomicsSyncProgress) => void

  // Derived
  getTodayCost: () => number
  getWeekCost: () => number
  getAllTimeCost: () => number
  getDailyAggregates: (days: number) => TokenomicsDailyAggregate[]
  getModelBreakdown: () => Array<{ model: string; costUsd: number; inputTokens: number; outputTokens: number }>
  getSortedSessions: (sortBy: string, sortDir: 'asc' | 'desc') => TokenomicsSessionRecord[]
}

export const useTokenomicsStore = create<TokenomicsState>((set, get) => ({
  data: null,
  loading: false,
  seeding: false,
  syncing: false,
  progress: null,
  error: null,

  loadData: async () => {
    set({ loading: true, error: null })
    try {
      const data = await window.electronAPI.tokenomics.getData()
      set({ data, loading: false })

      // Auto-seed if not complete
      if (!data.seedComplete) {
        get().startSeed()
      } else {
        // Auto-sync on subsequent loads
        get().startSync()
      }
    } catch (err: any) {
      set({ loading: false, error: err.message || 'Failed to load tokenomics data' })
    }
  },

  startSeed: async () => {
    set({ seeding: true, error: null })
    try {
      const data = await window.electronAPI.tokenomics.seed()
      set({ data, seeding: false, progress: null })
    } catch (err: any) {
      set({ seeding: false, error: err.message || 'Seed failed' })
    }
  },

  startSync: async () => {
    set({ syncing: true })
    try {
      const data = await window.electronAPI.tokenomics.sync()
      set({ data, syncing: false })
    } catch (err: any) {
      set({ syncing: false, error: err.message || 'Sync failed' })
    }
  },

  handleProgress: (progress: TokenomicsSyncProgress) => {
    set({ progress })
  },

  getTodayCost: () => {
    const { data } = get()
    if (!data) return 0
    const today = new Date().toISOString().slice(0, 10)
    return data.dailyAggregates[today]?.totalCostUsd || 0
  },

  getWeekCost: () => {
    const { data } = get()
    if (!data) return 0
    const now = new Date()
    let total = 0
    for (let i = 0; i < 7; i++) {
      const d = new Date(now)
      d.setDate(d.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      total += data.dailyAggregates[key]?.totalCostUsd || 0
    }
    return total
  },

  getAllTimeCost: () => {
    const { data } = get()
    return data?.totalCostUsd || 0
  },

  getDailyAggregates: (days: number) => {
    const { data } = get()
    if (!data) return []
    const result: TokenomicsDailyAggregate[] = []
    const now = new Date()
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(d.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      result.push(data.dailyAggregates[key] || {
        date: key,
        totalCostUsd: 0,
        totalTokens: 0,
        messageCount: 0,
        sessionCount: 0,
        byModel: {},
      })
    }
    return result
  },

  getModelBreakdown: () => {
    const { data } = get()
    if (!data) return []
    const models: Record<string, { costUsd: number; inputTokens: number; outputTokens: number }> = {}
    for (const agg of Object.values(data.dailyAggregates)) {
      for (const [model, stats] of Object.entries(agg.byModel)) {
        if (!models[model]) models[model] = { costUsd: 0, inputTokens: 0, outputTokens: 0 }
        models[model].costUsd += stats.costUsd
        models[model].inputTokens += stats.inputTokens
        models[model].outputTokens += stats.outputTokens
      }
    }
    return Object.entries(models)
      .map(([model, stats]) => ({ model, ...stats }))
      .sort((a, b) => b.costUsd - a.costUsd)
  },

  getSortedSessions: (sortBy: string, sortDir: 'asc' | 'desc') => {
    const { data } = get()
    if (!data) return []
    const sessions = Object.values(data.sessions)
    const dir = sortDir === 'asc' ? 1 : -1
    return sessions.sort((a, b) => {
      switch (sortBy) {
        case 'cost': return (a.totalCostUsd - b.totalCostUsd) * dir
        case 'inputTokens': return (a.totalInputTokens - b.totalInputTokens) * dir
        case 'outputTokens': return (a.totalOutputTokens - b.totalOutputTokens) * dir
        case 'date': return (a.firstTimestamp.localeCompare(b.firstTimestamp)) * dir
        case 'model': return (a.model.localeCompare(b.model)) * dir
        case 'project': return (a.projectDir.localeCompare(b.projectDir)) * dir
        default: return (a.totalCostUsd - b.totalCostUsd) * dir
      }
    })
  },
}))

// Global IPC listener — same pattern as setupCloudAgentListener
let listenerSetup = false
export function setupTokenomicsListener(): void {
  if (listenerSetup) return
  listenerSetup = true

  window.electronAPI.tokenomics.onProgress((progress) => {
    useTokenomicsStore.getState().handleProgress(progress)
  })
}
