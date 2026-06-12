import { create } from 'zustand'
import type { TkSummary, TkSessionRow, TkSessionDetail, TkIndexStatus } from '../../shared/types'

export type TkRange = '7d' | '30d' | 'all'
export interface TkUiFilter { configId?: string | null; range: TkRange; model?: string; search?: string }

interface TokenomicsState {
  summary: TkSummary | null
  sessions: TkSessionRow[]
  nextCursor: { lastTs: number; sessionId: string } | null
  indexStatus: TkIndexStatus | null
  filter: TkUiFilter
  selected: TkSessionDetail | null
  loadingSummary: boolean
  loadingSessions: boolean
  indexJustCompleted: boolean
  /** Set when a read-surface IPC call rejects (worker crash/restart-backoff or
   *  the 15s query timeout). Surfaced by TokenomicsPage so a fault clears the
   *  spinner and shows a retryable error instead of spinning forever. */
  error: string | null
  _unsubs: Array<() => void>

  init: () => Promise<void>
  refresh: () => Promise<void>
  setConfig: (configId: string | null | undefined) => void
  setRange: (range: TkRange) => void
  setSearch: (search: string) => void
  loadMore: () => Promise<void>
  selectSession: (id: string) => Promise<void>
  clearSelected: () => void
  clearIndexBadge: () => void
  dispose: () => void
}

function rangeToWindow(range: TkRange, now: number): { from?: number } {
  if (range === '7d') return { from: now - 7 * 86_400_000 }
  if (range === '30d') return { from: now - 30 * 86_400_000 }
  return {}
}

export const useTokenomicsStore = create<TokenomicsState>((set, get) => ({
  summary: null,
  sessions: [],
  nextCursor: null,
  indexStatus: null,
  filter: { range: 'all' },
  selected: null,
  loadingSummary: false,
  loadingSessions: false,
  indexJustCompleted: false,
  error: null,
  _unsubs: [],

  init: async () => {
    const tk = window.electronAPI.tokenomics

    // Fetch initial index status
    let status: TkIndexStatus
    try {
      status = await tk.indexStatus()
    } catch (err) {
      console.error('[tokenomicsStore] init: indexStatus failed', err)
      set({ error: err instanceof Error ? err.message : String(err) })
      return
    }
    set({ indexStatus: status })

    // Subscribe to progress events — update filesDone/filesTotal
    const unsubProgress = tk.onIndexProgress((p) => {
      set((s) => ({
        indexStatus: s.indexStatus
          ? { ...s.indexStatus, filesDone: p.filesDone, filesTotal: p.filesTotal }
          : s.indexStatus,
      }))
    })

    // Subscribe to complete events
    const unsubComplete = tk.onIndexComplete((e) => {
      set((s) => ({
        indexStatus: s.indexStatus
          ? { ...s.indexStatus, firstIndexComplete: true, indexing: false }
          : s.indexStatus,
        indexJustCompleted: e.firstIndex ? true : s.indexJustCompleted,
      }))
      // Always refresh after an index completion
      get().refresh()
    })

    set((s) => ({ _unsubs: [...s._unsubs, unsubProgress, unsubComplete] }))

    // If the first index is already done, load data now
    if (status.firstIndexComplete) {
      await get().refresh()
    }
  },

  refresh: async () => {
    const { filter } = get()
    const tk = window.electronAPI.tokenomics

    const base = {
      ...(filter.configId !== undefined ? { configId: filter.configId } : {}),
      ...(filter.model ? { model: filter.model } : {}),
      ...rangeToWindow(filter.range, Date.now()),
    }

    set({ loadingSummary: true, loadingSessions: true, error: null })

    try {
      const [summary, page] = await Promise.all([
        tk.summary(base),
        tk.sessions({ ...base, search: filter.search, limit: 50 }),
      ])

      set({
        summary,
        sessions: page.rows,
        nextCursor: page.nextCursor,
        loadingSummary: false,
        loadingSessions: false,
      })
    } catch (err) {
      // Worker crash / restart-backoff / 15s timeout: clear the loading flags so
      // the page leaves its spinner and surfaces a retryable error instead of
      // hanging forever (and never raising an unhandled rejection).
      console.error('[tokenomicsStore] refresh failed', err)
      set({
        loadingSummary: false,
        loadingSessions: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  },

  setConfig: (configId) => {
    set((s) => ({ filter: { ...s.filter, configId } }))
    get().refresh()
  },

  setRange: (range) => {
    set((s) => ({ filter: { ...s.filter, range } }))
    get().refresh()
  },

  setSearch: (search) => {
    set((s) => ({ filter: { ...s.filter, search } }))
    get().refresh()
  },

  loadMore: async () => {
    const { nextCursor, filter } = get()
    if (!nextCursor) return

    const tk = window.electronAPI.tokenomics

    const base = {
      ...(filter.configId !== undefined ? { configId: filter.configId } : {}),
      ...(filter.model ? { model: filter.model } : {}),
      ...rangeToWindow(filter.range, Date.now()),
    }

    try {
      const page = await tk.sessions({
        ...base,
        search: filter.search,
        cursor: nextCursor,
        limit: 50,
      })

      set((s) => ({
        sessions: [...s.sessions, ...page.rows],
        nextCursor: page.nextCursor,
      }))
    } catch (err) {
      console.error('[tokenomicsStore] loadMore failed', err)
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  selectSession: async (id) => {
    try {
      const detail = await window.electronAPI.tokenomics.sessionDetail(id)
      set({ selected: detail })
    } catch (err) {
      console.error('[tokenomicsStore] selectSession failed', err)
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  clearSelected: () => set({ selected: null }),

  clearIndexBadge: () => set({ indexJustCompleted: false }),

  dispose: () => {
    const { _unsubs } = get()
    _unsubs.forEach((fn) => fn())
    set({ _unsubs: [] })
  },
}))
