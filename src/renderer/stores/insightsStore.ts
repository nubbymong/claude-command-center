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
  /**
   * A cross-account roll-up is in flight. While true, the per-account runs it
   * fans out are catalogue updates ONLY: they must not take over the header
   * status or yank the selected report as each one finishes. `batchActive` is set
   * optimistically at dispatch (the runAll promise doesn't settle for minutes);
   * `batchRunId` fills in from the aggregate's first status event.
   */
  batchActive: boolean
  batchRunId: string | null

  startInsights: (profileId?: string) => Promise<void>
  startCrossAccount: (profileIds?: string[]) => Promise<void>
  loadCatalogue: () => Promise<void>
  selectRun: (runId: string) => void
  handleStatusChanged: (run: InsightsRun) => void
}

/** Absent `kind` means a single-account run (every run predating cross-account). */
function isAggregate(run: InsightsRun): boolean {
  return run.kind === 'aggregate'
}

function isLive(run: InsightsRun): boolean {
  return run.status === 'running' || run.status === 'extracting_kpis'
}

export const useInsightsStore = create<InsightsState>((set, get) => ({
  status: 'idle',
  statusMessage: null,
  currentRunId: null,
  catalogue: null,
  selectedRunId: null,
  error: null,
  batchActive: false,
  batchRunId: null,

  startInsights: async (profileId?: string) => {
    try {
      set({ status: 'running', error: null })
      const runId = await window.electronAPI.insights.run(profileId ? { profileId } : undefined)
      set({ currentRunId: runId })
    } catch (err: any) {
      set({ status: 'failed', error: err.message || 'Failed to start insights' })
    }
  },

  startCrossAccount: async (profileIds?: string[]) => {
    try {
      set({
        status: 'running',
        statusMessage: 'Starting the cross-account report...',
        error: null,
        batchActive: true,
        batchRunId: null,
      })
      // Resolves only when the whole fan-out plus synthesis is done (minutes), so
      // progress arrives via insights:statusChanged, not from this await.
      const runId = await window.electronAPI.insights.runAll(
        profileIds && profileIds.length > 0 ? { profileIds } : undefined
      )
      set({ currentRunId: runId })
    } catch (err: any) {
      // Rejects only on refusal (too few accounts, or a roll-up already running)
      // — a failed member run doesn't reject.
      set({
        status: 'failed',
        statusMessage: null,
        error: err.message || 'Failed to start the cross-account report',
        batchActive: false,
        batchRunId: null,
      })
    }
  },

  loadCatalogue: async () => {
    try {
      const catalogue = await window.electronAPI.insights.getCatalogue()

      const running = await window.electronAPI.insights.isRunning()
      // Clear a stale mid-run status if a run ended while we weren't listening,
      // but do NOT persistently mark a historical failure here: that would redden
      // the Insights nav dot on every boot for a past failure (the Sentinel
      // calibration lesson — a dot means "needs attention now", not "once failed").
      // Failures are surfaced on the page itself (banner/picker, from the
      // catalogue); a LIVE failure still flashes via handleStatusChanged.
      let status = get().status
      if (running) status = 'running'
      else if (status === 'running' || status === 'extracting_kpis') status = 'idle'
      // A roll-up left in flight by a reload is recovered from the catalogue, so
      // its member runs keep being treated as members instead of hijacking the
      // header. cleanupStuckRuns() has already failed anything an app restart
      // interrupted, so a live entry here really is live.
      const liveAggregate = catalogue.runs.find((r) => isAggregate(r) && isLive(r)) ?? null
      set({
        catalogue,
        status: liveAggregate ? (liveAggregate.status as InsightsStatus) : status,
        statusMessage: liveAggregate ? liveAggregate.statusMessage || null : get().statusMessage,
        batchActive: !!liveAggregate || get().batchActive,
        batchRunId: liveAggregate?.id ?? get().batchRunId,
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
      const newState: Partial<InsightsState> = {}

      // Update catalogue in-place — always, for every kind of run.
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

      // A member of an in-flight roll-up: catalogue only. Letting it through
      // would overwrite the batch's own progress line with a single account's,
      // and its completion would pull the selected report away mid-batch.
      const isBatchMember = state.batchActive && !isAggregate(run)
      if (isBatchMember) return newState

      newState.status = run.status as InsightsStatus
      newState.statusMessage = run.statusMessage || null
      newState.currentRunId = run.id
      if (run.error) newState.error = run.error

      if (isAggregate(run)) {
        newState.batchActive = isLive(run)
        newState.batchRunId = isLive(run) ? run.id : null
      }

      // Auto-select completed run
      if (run.status === 'complete') {
        newState.selectedRunId = run.id
      }

      return newState
    })
  },
}))

// Set up the insights IPC listener once globally — never tear down. Mirrors the
// cloudAgent/github guard so a React StrictMode double-invoke or a remount never
// installs duplicate listeners. App-level setup (see App.tsx) keeps both
// InsightsPage and the Sidebar nav status dot live during a run (Unit 3 W2).
let listenerSetup = false
export function setupInsightsListener(): void {
  if (listenerSetup) return
  listenerSetup = true

  window.electronAPI.insights.onStatusChanged((run) => {
    useInsightsStore.getState().handleStatusChanged(run)
  })

  // Load catalogue on setup
  useInsightsStore.getState().loadCatalogue()
}
