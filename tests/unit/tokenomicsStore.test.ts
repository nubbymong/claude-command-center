/**
 * Tests for the new worker-backed tokenomics renderer store.
 * Mocks window.electronAPI.tokenomics per the test harness pattern.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Mock electronAPI.tokenomics ──────────────────────────────────────────────
const progressCbs: any[] = []
const completeCbs: any[] = []
const statusCbs: any[] = []

const tk = {
  indexStatus: vi.fn(async () => ({
    firstIndexComplete: true,
    indexing: false,
    filesDone: 1,
    filesTotal: 1,
    eventsTotal: 5,
    lastIndexAt: 1,
  })),
  summary: vi.fn(async () => ({
    kpis: { lifeToDateCostUsd: 5, last7dCostUsd: 1, prev7dCostUsd: 2, cacheEfficiencyPct: 0, cacheSavingsUsd: 0 },
    dailySeries: [],
    modelSplit: [],
    cacheSplit: { inputUsd: 0, outputUsd: 0, cacheReadUsd: 0, cacheCreateUsd: 0 },
    costByConfig: [],
    heatmap: [],
  })),
  sessions: vi.fn(async (q: any) =>
    q?.cursor
      ? { rows: [{ sessionId: 's2' }], nextCursor: null }
      : { rows: [{ sessionId: 's1' }], nextCursor: { lastTs: 10, sessionId: 's1' } }
  ),
  sessionDetail: vi.fn(async (id: string) => ({ sessionId: id, byModel: [] })),
  onIndexStatus: vi.fn((cb: any) => { statusCbs.push(cb); return () => {} }),
  onIndexProgress: vi.fn((_cb: any) => () => {}),
  onIndexComplete: vi.fn((cb: any) => { completeCbs.push(cb); return () => {} }),
}

// Install on globalThis.window — augment so DOM tests aren't disrupted
const existingWindow = (globalThis as any).window
if (existingWindow) {
  existingWindow.electronAPI = { ...(existingWindow.electronAPI ?? {}), tokenomics: tk }
} else {
  ;(globalThis as any).window = { electronAPI: { tokenomics: tk } }
}

// ── Import store AFTER mock is installed ─────────────────────────────────────
import { useTokenomicsStore } from '../../src/renderer/stores/tokenomicsStore'

// ── Helpers ──────────────────────────────────────────────────────────────────
function resetStore() {
  useTokenomicsStore.setState({
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
  })
}

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('tokenomicsStore', () => {
  beforeEach(() => {
    resetStore()
    vi.clearAllMocks()
    progressCbs.length = 0
    completeCbs.length = 0
    statusCbs.length = 0
  })

  // ── init ──────────────────────────────────────────────────────────────────
  describe('init()', () => {
    it('fetches indexStatus and populates it', async () => {
      await useTokenomicsStore.getState().init()
      const s = useTokenomicsStore.getState()
      expect(s.indexStatus).not.toBeNull()
      expect(s.indexStatus!.firstIndexComplete).toBe(true)
      expect(s.indexStatus!.eventsTotal).toBe(5)
    })

    it('calls refresh() when firstIndexComplete=true → populates summary + sessions', async () => {
      await useTokenomicsStore.getState().init()
      const s = useTokenomicsStore.getState()
      expect(s.summary).not.toBeNull()
      expect(s.summary!.kpis.lifeToDateCostUsd).toBe(5)
      expect(s.sessions).toHaveLength(1)
      expect(s.sessions[0].sessionId).toBe('s1')
    })

    it('does NOT call refresh() when firstIndexComplete=false', async () => {
      tk.indexStatus.mockResolvedValueOnce({
        firstIndexComplete: false,
        indexing: true,
        filesDone: 0,
        filesTotal: 10,
        eventsTotal: 0,
        lastIndexAt: null,
      })
      await useTokenomicsStore.getState().init()
      const s = useTokenomicsStore.getState()
      expect(s.summary).toBeNull()
      expect(s.sessions).toHaveLength(0)
    })

    it('subscribes to onIndexProgress and onIndexComplete', async () => {
      await useTokenomicsStore.getState().init()
      expect(tk.onIndexProgress).toHaveBeenCalledTimes(1)
      expect(tk.onIndexComplete).toHaveBeenCalledTimes(1)
    })

    it('mirrors a pushed fatal index error into store error state', async () => {
      await useTokenomicsStore.getState().init()
      expect(tk.onIndexStatus).toHaveBeenCalledTimes(1)
      statusCbs.at(-1)!({
        firstIndexComplete: false, indexing: false, filesDone: 0, filesTotal: 0,
        eventsTotal: 0, lastIndexAt: null, error: 'db open failed',
      })
      const s = useTokenomicsStore.getState()
      expect(s.error).toBe('db open failed')
      expect(s.indexStatus?.error).toBe('db open failed')
    })

    it('mirrors error from the INITIAL indexStatus fetch', async () => {
      tk.indexStatus.mockResolvedValueOnce({
        firstIndexComplete: false, indexing: false, filesDone: 0, filesTotal: 0,
        eventsTotal: 0, lastIndexAt: null, error: 'boot fail',
      } as any)
      await useTokenomicsStore.getState().init()
      expect(useTokenomicsStore.getState().error).toBe('boot fail')
    })

    it('refreshIndexStatus re-fetches and clears a stale error on healthy status', async () => {
      useTokenomicsStore.setState({ error: 'old failure' })
      await useTokenomicsStore.getState().refreshIndexStatus()
      const s = useTokenomicsStore.getState()
      expect(s.error).toBeNull()
      expect(s.indexStatus?.firstIndexComplete).toBe(true)
    })

    it('stores unsub fns in _unsubs', async () => {
      await useTokenomicsStore.getState().init()
      expect(useTokenomicsStore.getState()._unsubs.length).toBeGreaterThanOrEqual(2)
    })
  })

  // ── onIndexComplete callback ──────────────────────────────────────────────
  describe('onIndexComplete callback', () => {
    it('sets indexJustCompleted=true when firstIndex=true AND triggers refresh()', async () => {
      await useTokenomicsStore.getState().init()
      vi.clearAllMocks()
      // Invoke the registered callback
      completeCbs[completeCbs.length - 1]({ firstIndex: true, eventsTotal: 10 })
      await Promise.resolve() // flush microtasks
      // Allow the async refresh chain to settle
      await new Promise(r => setTimeout(r, 0))
      const s = useTokenomicsStore.getState()
      expect(s.indexJustCompleted).toBe(true)
      expect(tk.summary).toHaveBeenCalled()
    })

    it('does NOT set indexJustCompleted when firstIndex=false', async () => {
      await useTokenomicsStore.getState().init()
      completeCbs[completeCbs.length - 1]({ firstIndex: false, eventsTotal: 10 })
      await new Promise(r => setTimeout(r, 0))
      expect(useTokenomicsStore.getState().indexJustCompleted).toBe(false)
    })

    it('sets indexing=false and firstIndexComplete=true on the indexStatus', async () => {
      tk.indexStatus.mockResolvedValueOnce({
        firstIndexComplete: false,
        indexing: true,
        filesDone: 5,
        filesTotal: 5,
        eventsTotal: 0,
        lastIndexAt: null,
      })
      await useTokenomicsStore.getState().init()
      completeCbs[completeCbs.length - 1]({ firstIndex: false, drained: true, eventsTotal: 42 })
      await new Promise(r => setTimeout(r, 0))
      const s = useTokenomicsStore.getState()
      expect(s.indexStatus!.indexing).toBe(false)
      expect(s.indexStatus!.firstIndexComplete).toBe(true)
    })

    it('leaves the page indexing when the sweep finished WITHOUT draining', async () => {
      // A sweep finishing is not the index finishing: with a per-tick byte
      // budget a multi-GB rollout needs tens of sweeps. Treating the message
      // itself as completion swapped an honest spinner for a confidently wrong
      // total, over a fraction of the user's actual spend.
      tk.indexStatus.mockResolvedValueOnce({
        firstIndexComplete: false,
        indexing: true,
        filesDone: 5,
        filesTotal: 5,
        eventsTotal: 0,
        lastIndexAt: null,
      })
      await useTokenomicsStore.getState().init()
      completeCbs[completeCbs.length - 1]({ firstIndex: false, drained: false, eventsTotal: 3 })
      await new Promise(r => setTimeout(r, 0))
      const s = useTokenomicsStore.getState()
      expect(s.indexStatus!.indexing).toBe(true)
      expect(s.indexStatus!.firstIndexComplete).toBe(false)
    })
  })

  // ── clearIndexBadge ───────────────────────────────────────────────────────
  describe('clearIndexBadge()', () => {
    it('sets indexJustCompleted to false', async () => {
      useTokenomicsStore.setState({ indexJustCompleted: true })
      useTokenomicsStore.getState().clearIndexBadge()
      expect(useTokenomicsStore.getState().indexJustCompleted).toBe(false)
    })
  })

  // ── setConfig ─────────────────────────────────────────────────────────────
  describe('setConfig()', () => {
    it('updates filter.configId and calls summary/sessions with that configId', async () => {
      await useTokenomicsStore.getState().setConfig('cfg-abc')
      expect(useTokenomicsStore.getState().filter.configId).toBe('cfg-abc')
      expect(tk.summary).toHaveBeenCalledWith(expect.objectContaining({ configId: 'cfg-abc' }))
      expect(tk.sessions).toHaveBeenCalledWith(expect.objectContaining({ configId: 'cfg-abc' }))
    })

    it('passes configId=null for "External / no config" filter', async () => {
      await useTokenomicsStore.getState().setConfig(null)
      expect(useTokenomicsStore.getState().filter.configId).toBeNull()
      expect(tk.summary).toHaveBeenCalledWith(expect.objectContaining({ configId: null }))
    })

    it('passes configId=undefined to widen to all configs', async () => {
      await useTokenomicsStore.getState().setConfig(undefined)
      expect(useTokenomicsStore.getState().filter.configId).toBeUndefined()
    })
  })

  // ── setRange ──────────────────────────────────────────────────────────────
  describe('setRange()', () => {
    it('updates filter.range', async () => {
      await useTokenomicsStore.getState().setRange('7d')
      expect(useTokenomicsStore.getState().filter.range).toBe('7d')
    })

    it('passes a from timestamp when range is 7d', async () => {
      const before = Date.now() - 7 * 86_400_000
      await useTokenomicsStore.getState().setRange('7d')
      const call = tk.summary.mock.calls[0]?.[0]
      expect(call.from).toBeGreaterThanOrEqual(before - 5000)
      expect(call.from).toBeLessThanOrEqual(Date.now())
    })

    it('passes no from when range is all', async () => {
      await useTokenomicsStore.getState().setRange('all')
      const call = tk.summary.mock.calls[0]?.[0]
      expect(call.from).toBeUndefined()
    })
  })

  // ── setSearch ─────────────────────────────────────────────────────────────
  describe('setSearch()', () => {
    it('updates filter.search and triggers refresh()', async () => {
      await useTokenomicsStore.getState().setSearch('hello')
      expect(useTokenomicsStore.getState().filter.search).toBe('hello')
      expect(tk.sessions).toHaveBeenCalledWith(expect.objectContaining({ search: 'hello' }))
    })
  })

  // ── loadMore ──────────────────────────────────────────────────────────────
  describe('loadMore()', () => {
    it('is a no-op when nextCursor is null', async () => {
      useTokenomicsStore.setState({ nextCursor: null })
      await useTokenomicsStore.getState().loadMore()
      expect(tk.sessions).not.toHaveBeenCalled()
    })

    it('appends rows and updates nextCursor when cursor exists', async () => {
      useTokenomicsStore.setState({
        sessions: [{ sessionId: 's1' } as any],
        nextCursor: { lastTs: 10, sessionId: 's1' },
        filter: { range: 'all' },
      })
      await useTokenomicsStore.getState().loadMore()
      const s = useTokenomicsStore.getState()
      expect(s.sessions).toHaveLength(2)
      expect(s.sessions[1].sessionId).toBe('s2')
      expect(s.nextCursor).toBeNull()
    })

    it('passes the cursor to sessions query', async () => {
      const cursor = { lastTs: 10, sessionId: 's1' }
      useTokenomicsStore.setState({
        sessions: [],
        nextCursor: cursor,
        filter: { range: 'all' },
      })
      await useTokenomicsStore.getState().loadMore()
      expect(tk.sessions).toHaveBeenCalledWith(expect.objectContaining({ cursor }))
    })
  })

  // ── selectSession / clearSelected ─────────────────────────────────────────
  describe('selectSession() / clearSelected()', () => {
    it('fetches detail and sets selected', async () => {
      await useTokenomicsStore.getState().selectSession('my-session')
      const s = useTokenomicsStore.getState()
      expect(s.selected).not.toBeNull()
      expect(s.selected!.sessionId).toBe('my-session')
    })

    it('clearSelected() sets selected to null', async () => {
      useTokenomicsStore.setState({ selected: { sessionId: 'x', byModel: [] } as any })
      useTokenomicsStore.getState().clearSelected()
      expect(useTokenomicsStore.getState().selected).toBeNull()
    })
  })

  // ── rejection handling (no unhandled rejection, no stuck spinner) ─────────
  describe('rejection handling', () => {
    it('refresh() catches a worker reject, clears loading flags, sets error', async () => {
      tk.summary.mockRejectedValueOnce(new Error('tokenomics service not running'))
      useTokenomicsStore.setState({ filter: { range: 'all' } })
      await useTokenomicsStore.getState().refresh()
      const s = useTokenomicsStore.getState()
      // Spinner cleared (TokenomicsPage gates on loadingSummary && !summary).
      expect(s.loadingSummary).toBe(false)
      expect(s.loadingSessions).toBe(false)
      expect(s.error).toBe('tokenomics service not running')
    })

    it('refresh() clears a prior error on a subsequent success', async () => {
      useTokenomicsStore.setState({ error: 'old error' })
      await useTokenomicsStore.getState().refresh()
      expect(useTokenomicsStore.getState().error).toBeNull()
      expect(useTokenomicsStore.getState().summary).not.toBeNull()
    })

    it('init() catches an indexStatus reject and records the error without throwing', async () => {
      tk.indexStatus.mockRejectedValueOnce(new Error('boom'))
      await expect(useTokenomicsStore.getState().init()).resolves.toBeUndefined()
      expect(useTokenomicsStore.getState().error).toBe('boom')
    })

    it('selectSession() catches a reject and sets error instead of rejecting', async () => {
      tk.sessionDetail.mockRejectedValueOnce(new Error('detail timeout'))
      await expect(useTokenomicsStore.getState().selectSession('x')).resolves.toBeUndefined()
      expect(useTokenomicsStore.getState().error).toBe('detail timeout')
    })
  })

  // ── dispose ───────────────────────────────────────────────────────────────
  describe('dispose()', () => {
    it('calls all unsub fns and empties _unsubs', async () => {
      const unsub1 = vi.fn()
      const unsub2 = vi.fn()
      useTokenomicsStore.setState({ _unsubs: [unsub1, unsub2] })
      useTokenomicsStore.getState().dispose()
      expect(unsub1).toHaveBeenCalledTimes(1)
      expect(unsub2).toHaveBeenCalledTimes(1)
      expect(useTokenomicsStore.getState()._unsubs).toHaveLength(0)
    })
  })
})
