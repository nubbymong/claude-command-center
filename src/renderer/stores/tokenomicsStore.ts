import { create } from 'zustand'
import type { TkSummary, TkSessionRow, TkSessionDetail, TkIndexStatus, TkAccountPresent, TkProvider, TkSummaryFilter } from '../../shared/types'

export type TkRange = '7d' | '30d' | 'all'
/** Usage track MP12: `provider` (only when both have data) and `account`
 *  (an account under its provider: "Not recorded" is '' under either). */
export interface TkUiFilter {
  configId?: string | null
  range: TkRange
  model?: string
  search?: string
  provider?: TkProvider
  account?: { provider: TkProvider; key: string }
}

/** The query a filter makes (MP12): an account's provider comes with it. */
export function tkQueryFilter(filter: TkUiFilter, now: number): TkSummaryFilter {
  const provider = filter.provider ?? filter.account?.provider
  return {
    ...(filter.configId !== undefined ? { configId: filter.configId } : {}),
    ...(filter.model ? { model: filter.model } : {}),
    ...(provider ? { provider } : {}),
    ...(filter.account ? { accountKey: filter.account.key } : {}),
    ...rangeToWindow(filter.range, now),
  }
}

interface TokenomicsState {
  summary: TkSummary | null
  /** MP12: the providers and accounts the stored usage has. */
  accounts: TkAccountPresent[]
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
  refreshIndexStatus: () => Promise<void>
  setConfig: (configId: string | null | undefined) => void
  /** MP12: one provider, or all (an account under the other is let go). */
  setProvider: (provider: TkProvider | undefined) => void
  /** MP12: one account under its provider, or all. */
  setAccount: (account: { provider: TkProvider; key: string } | undefined) => void
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
  accounts: [],
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
    set({ indexStatus: status, error: status.error ?? null })

    // Subscribe to pushed status updates — carries the worker's fatal `error`
    // (e.g. a failed DB open) so the page leaves the 'indexing' gate instead
    // of spinning forever with zero diagnostics.
    const unsubStatus = tk.onIndexStatus((st) => {
      set({ indexStatus: st, error: st.error ?? null })
    })

    // Subscribe to progress events — update filesDone/filesTotal
    const unsubProgress = tk.onIndexProgress((p) => {
      set((s) => ({
        // MP12: the one-off attribution's progress rides the progress events.
        indexStatus: s.indexStatus
          ? { ...s.indexStatus, filesDone: p.filesDone, filesTotal: p.filesTotal, accountReread: p.accountReread ?? null }
          : s.indexStatus,
      }))
    })

    // Subscribe to complete events
    const unsubComplete = tk.onIndexComplete((e) => {
      set((s) => ({
        // Only a DRAINED sweep means the numbers are whole. A sweep can finish
        // with a multi-GB rollout barely started, and taking that as completion
        // swapped the honest spinner for a confidently wrong total.
        indexStatus: s.indexStatus && e.drained
          ? { ...s.indexStatus, firstIndexComplete: true, indexing: false, filesFailed: e.filesFailed }
          : s.indexStatus
            ? { ...s.indexStatus, filesFailed: e.filesFailed }
            : s.indexStatus,
        indexJustCompleted: e.firstIndex ? true : s.indexJustCompleted,
      }))
      // Always refresh after an index completion
      get().refresh()
    })

    set((s) => ({ _unsubs: [...s._unsubs, unsubStatus, unsubProgress, unsubComplete] }))

    // If the first index is already done, load data now
    if (status.firstIndexComplete) {
      await get().refresh()
    }
  },

  refreshIndexStatus: async () => {
    // Idempotent re-fetch for the indexing-gate Retry button (no resubscribe).
    const tk = window.electronAPI.tokenomics
    try {
      const status = await tk.indexStatus()
      set({ indexStatus: status, error: status.error ?? null })
    } catch (err) {
      console.error('[tokenomicsStore] refreshIndexStatus failed', err)
      set({ error: err instanceof Error ? err.message : String(err) })
    }
  },

  refresh: async () => {
    const { filter } = get()
    const tk = window.electronAPI.tokenomics

    const base = tkQueryFilter(filter, Date.now())

    set({ loadingSummary: true, loadingSessions: true, error: null })

    try {
      const [summary, page, accounts] = await Promise.all([
        tk.summary(base),
        tk.sessions({ ...base, search: filter.search, limit: 50 }),
        // The filters' choices; an answer lost keeps the last ones.
        (tk.accounts ? tk.accounts() : Promise.resolve([] as TkAccountPresent[])).catch(() => get().accounts),
      ])

      set({
        summary,
        accounts: Array.isArray(accounts) ? accounts : [],
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

  setProvider: (provider) => {
    set((s) => ({
      filter: {
        ...s.filter,
        provider,
        account: provider && s.filter.account && s.filter.account.provider !== provider ? undefined : s.filter.account,
      },
    }))
    get().refresh()
  },

  setAccount: (account) => {
    set((s) => ({ filter: { ...s.filter, account } }))
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

    const base = tkQueryFilter(filter, Date.now())

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
