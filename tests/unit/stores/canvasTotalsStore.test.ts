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
    expect(t).toEqual({ loaded: true, canvases: 3, openReviews: 3, withOpenReviews: 2, unknown: 0, onActive: 2 })
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
    expect(totalsFromEntries([])).toEqual({ loaded: true, canvases: 0, openReviews: 0, withOpenReviews: 0, unknown: 0, onActive: 0 })
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
