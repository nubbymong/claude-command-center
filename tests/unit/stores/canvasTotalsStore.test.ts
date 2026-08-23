/**
 * canvasTotalsStore -- the number that spans canvases (item 29): open reviews
 * summed over every canvas the session owns, read from `canvas:listAll`, which
 * already joins per-canvas counts onto the asking session's own entries.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { CanvasLibraryEntry } from '../../../src/shared/canvas'

vi.mock('../../../src/renderer/stores/sessionStore', () => ({
  useSessionStore: { getState: () => ({ sessions: [{ id: 's1' }, { id: 's2' }] }) },
}))

const { useCanvasTotalsStore, totalsFromEntries } = await import('../../../src/renderer/stores/canvasTotalsStore')
const listAll = (window as any).electronAPI.canvas.listAll as ReturnType<typeof vi.fn>

const entry = (over: Partial<CanvasLibraryEntry>): CanvasLibraryEntry => ({
  canvasId: over.canvasId ?? 'c', versionCount: 1, createdAt: '2026-08-21T00:00:00Z', lastRenderedAt: '2026-08-21T00:00:00Z', ...over,
})

beforeEach(() => {
  useCanvasTotalsStore.getState().reset()
  listAll.mockReset()
  listAll.mockResolvedValue([])
})

describe('totalsFromEntries', () => {
  it('counts only the canvases this session owns (or is showing), and sums their open reviews', () => {
    const t = totalsFromEntries([
      entry({ canvasId: 'a', ownedByThisSession: true, isActiveForThisSession: true, openReviewCount: 2 }),
      entry({ canvasId: 'b', ownedByThisSession: true, openReviewCount: 0 }),
      entry({ canvasId: 'c', ownedByThisSession: true, openReviewCount: 1 }),
      entry({ canvasId: 'x', openReviewCount: 7 }),                       // someone else's
      entry({ canvasId: 'y', ownedByOpenSession: true, openReviewCount: 3 }), // another open tile's
    ])
    expect(t).toEqual({ loaded: true, canvases: 3, openReviews: 3, withOpenReviews: 2, unknown: 0, onActive: 2, queue: 0, queueOnActive: 0, queueRows: [] })
  })
  it('keeps "could not tell" apart from "nothing owed": an undefined count is unknown, never zero', () => {
    const t = totalsFromEntries([
      entry({ canvasId: 'a', ownedByThisSession: true, isActiveForThisSession: true, openReviewCount: 1 }),
      entry({ canvasId: 'b', ownedByThisSession: true }), // store unreadable -> count left undefined by main
    ])
    expect(t.canvases).toBe(2)
    expect(t.openReviews).toBe(1)
    expect(t.unknown).toBe(1)
  })
  it('a canvas the session is SHOWING but does not own still counts (the pane is on it)', () => {
    const t = totalsFromEntries([entry({ canvasId: 'a', isActiveForThisSession: true, openReviewCount: 4 })])
    expect(t).toMatchObject({ canvases: 1, openReviews: 4, onActive: 4 })
  })
  it('empty listing -> loaded, all zeros', () => {
    expect(totalsFromEntries([])).toEqual({ loaded: true, canvases: 0, openReviews: 0, withOpenReviews: 0, unknown: 0, onActive: 0, queue: 0, queueOnActive: 0, queueRows: [] })
  })
})

describe('the queue (#364): review-needed + verdict-owed, one derivation', () => {
  it('counts a ready-marked canvas once and a verdict canvas per round, and rows them newest first', () => {
    const t = totalsFromEntries([
      entry({ canvasId: 'a', title: 'Tips', ownedByThisSession: true, isActiveForThisSession: true, openReviewCount: 1, awaitingReview: true, awaitingReviewAt: '2026-08-23T10:00:00Z' }),
      entry({ canvasId: 'b', title: 'Sidebar', ownedByThisSession: true, openReviewCount: 1, verdictRounds: 2, lastRenderedAt: '2026-08-23T11:00:00Z' }),
      entry({ canvasId: 'c', ownedByThisSession: true, openReviewCount: 0, verdictRounds: 0 }),
    ])
    expect(t.queue).toBe(3) // 1 review-needed + 2 verdict rounds
    expect(t.queueOnActive).toBe(1)
    expect(t.queueRows.map((r) => `${r.canvasId}:${r.kind}`)).toEqual(['b:verdict', 'a:review'])
    expect(t.queueRows[0]).toMatchObject({ rounds: 2, title: 'Sidebar', onActive: false })
    expect(t.queueRows[1]).toMatchObject({ kind: 'review', at: '2026-08-23T10:00:00Z', onActive: true })
  })

  it('a canvas can owe BOTH: a fresh ready round and an older verdict round', () => {
    const t = totalsFromEntries([
      entry({ canvasId: 'a', ownedByThisSession: true, isActiveForThisSession: true, openReviewCount: 1, awaitingReview: true, awaitingReviewAt: '2026-08-23T10:00:00Z', verdictRounds: 1 }),
    ])
    expect(t.queue).toBe(2)
    expect(t.queueOnActive).toBe(2)
    expect(t.queueRows).toHaveLength(2)
  })

  it("someone else's canvas never enters the queue", () => {
    const t = totalsFromEntries([entry({ canvasId: 'x', awaitingReview: true, verdictRounds: 3 })])
    expect(t.queue).toBe(0)
    expect(t.queueRows).toEqual([])
  })

  it('review-needed counts even when the review store is unreadable — it comes from the canvas record', () => {
    const t = totalsFromEntries([
      entry({ canvasId: 'a', ownedByThisSession: true, awaitingReview: true, awaitingReviewAt: '2026-08-23T10:00:00Z' }), // no counts joined
    ])
    expect(t.queue).toBe(1)
    expect(t.unknown).toBe(1)
  })

  it('rounds waiting on the AGENT do not count: openReviewCount alone moves nothing', () => {
    const t = totalsFromEntries([
      entry({ canvasId: 'a', ownedByThisSession: true, openReviewCount: 3, verdictRounds: 0 }),
    ])
    expect(t.queue).toBe(0)
  })
})

describe('refresh', () => {
  it('asks main for the listing scoped to the session, with the open tiles, and stores the fold', async () => {
    listAll.mockResolvedValue([entry({ canvasId: 'a', ownedByThisSession: true, openReviewCount: 2 })])
    await useCanvasTotalsStore.getState().refresh('s1')
    expect(listAll).toHaveBeenCalledWith({ openTileSessionIds: ['s1', 's2'], sessionId: 's1' })
    expect(useCanvasTotalsStore.getState().bySessionId['s1']).toMatchObject({ loaded: true, canvases: 1, openReviews: 2 })
  })
  it('a failed read keeps what was known rather than zeroing it', async () => {
    listAll.mockResolvedValue([entry({ canvasId: 'a', ownedByThisSession: true, openReviewCount: 2 })])
    await useCanvasTotalsStore.getState().refresh('s1')
    listAll.mockRejectedValue(new Error('boom'))
    await useCanvasTotalsStore.getState().refresh('s1')
    expect(useCanvasTotalsStore.getState().bySessionId['s1'].openReviews).toBe(2)
  })
  it('a failed FIRST read still marks the session loaded (so the button stops re-asking) with zeros', async () => {
    listAll.mockRejectedValue(new Error('boom'))
    await useCanvasTotalsStore.getState().refresh('s1')
    expect(useCanvasTotalsStore.getState().bySessionId['s1']).toMatchObject({ loaded: true, openReviews: 0 })
  })
  it('a non-array answer is treated as empty', async () => {
    listAll.mockResolvedValue(null as never)
    await useCanvasTotalsStore.getState().refresh('s1')
    expect(useCanvasTotalsStore.getState().bySessionId['s1']).toMatchObject({ loaded: true, canvases: 0 })
  })
})

describe('scheduleRefresh', () => {
  it('collapses a burst of pushes into ONE read per session', async () => {
    vi.useFakeTimers()
    try {
      const st = useCanvasTotalsStore.getState()
      st.scheduleRefresh('s1'); st.scheduleRefresh('s1'); st.scheduleRefresh('s1')
      st.scheduleRefresh('s2')
      expect(listAll).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(200)
      expect(listAll).toHaveBeenCalledTimes(2)
      expect(listAll.mock.calls.map((c) => c[0].sessionId).sort()).toEqual(['s1', 's2'])
    } finally {
      vi.useRealTimers()
    }
  })
})
