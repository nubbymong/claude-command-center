import { create } from 'zustand'
import type { InsightsCatalogue, InsightsRun } from '../types/electron'

type InsightsStatus = 'idle' | 'running' | 'extracting_kpis' | 'complete' | 'failed'

interface InsightsState {
  status: InsightsStatus
  statusMessage: string | null
  currentRunId: string | null
  catalogue: InsightsCatalogue | null
  selectedRunId: string | null
  error: string | null

  startInsights: () => Promise<void>
  loadCatalogue: () => Promise<void>
  selectRun: (runId: string) => void
  handleStatusChanged: (run: InsightsRun) => void
}

export const useInsightsStore = create<InsightsState>((set, get) => ({
  status: 'idle',
  statusMessage: null,
  currentRunId: null,
  catalogue: null,
  selectedRunId: null,
  error: null,

  startInsights: async () => {
    try {
      set({ status: 'running', error: null })
      const runId = await window.electronAPI.insights.run()
      set({ currentRunId: runId })
    } catch (err: any) {
      set({ status: 'failed', error: err.message || 'Failed to start insights' })
    }
  },

  loadCatalogue: async () => {
    try {
      const catalogue = await window.electronAPI.insights.getCatalogue()

      const running = await window.electronAPI.insights.isRunning()
      set({
        catalogue,
        status: running ? 'running' : get().status === 'running' ? 'idle' : get().status
      })
      // Auto-select latest complete run if nothing selected
      if (!get().selectedRunId && catalogue.runs.length > 0) {
        for (let i = catalogue.runs.length - 1; i >= 0; i--) {
          if (catalogue.runs[i].status === 'complete') {
            set({ selectedRunId: catalogue.runs[i].id })
            break
          }
        }
      }
    } catch (err) {
      console.error('[insightsStore] Failed to load catalogue:', err)
    }
  },

  selectRun: (runId: string) => {
    set({ selectedRunId: runId })
  },

  handleStatusChanged: (run: InsightsRun) => {
    set((state) => {
      const newState: Partial<InsightsState> = {
        status: run.status as InsightsStatus,
        statusMessage: run.statusMessage || null,
        currentRunId: run.id,
      }

      if (run.error) newState.error = run.error

      // Update catalogue in-place
      if (state.catalogue) {
        const runs = [...state.catalogue.runs]
        const idx = runs.findIndex((r) => r.id === run.id)
        if (idx >= 0) {
          runs[idx] = run
        } else {
          runs.push(run)
        }
        newState.catalogue = { runs }
      }

      // Auto-select completed run
      if (run.status === 'complete') {
        newState.selectedRunId = run.id
      }

      return newState
    })
  },
}))

// Set up IPC listener once
let listenerSetup = false
export function setupInsightsListener(): () => void {
  if (listenerSetup) return () => {}
  listenerSetup = true

  const unsub = window.electronAPI.insights.onStatusChanged((run) => {
    useInsightsStore.getState().handleStatusChanged(run)
  })

  // Load catalogue on setup
  useInsightsStore.getState().loadCatalogue()

  return () => {
    unsub()
    listenerSetup = false
  }
}
