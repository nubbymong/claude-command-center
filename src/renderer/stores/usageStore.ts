import { create } from 'zustand'

interface UsageSummary {
  totalCost: number
  totalInputTokens: number
  totalOutputTokens: number
  byModel: Record<string, { cost: number; inputTokens: number; outputTokens: number }>
  byHour: { hour: string; cost: number }[]
}

interface UsageState {
  summary: UsageSummary | null
  loading: boolean
  lastRefresh: number

  refresh: () => Promise<void>
  refreshSessionUsage: (sessionId: string) => Promise<{ cost: number; inputTokens: number; outputTokens: number }>
}

export const useUsageStore = create<UsageState>((set) => ({
  summary: null,
  loading: false,
  lastRefresh: 0,

  refresh: async () => {
    set({ loading: true })
    try {
      const summary = await window.electronAPI.usage.getTotalUsage() as UsageSummary
      set({ summary, loading: false, lastRefresh: Date.now() })
    } catch {
      set({ loading: false })
    }
  },

  refreshSessionUsage: async (sessionId: string) => {
    return await window.electronAPI.usage.getSessionUsage(sessionId) as {
      cost: number
      inputTokens: number
      outputTokens: number
    }
  }
}))
