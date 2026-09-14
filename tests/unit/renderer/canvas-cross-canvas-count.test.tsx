// @vitest-environment jsdom
/**
 * The Canvas button's pill spans canvases (item 29, the deferred half of the
 * 2026-08-20 dimensions pass). The pane's own count is honest about the canvas
 * on screen and blind to the rest; from the terminal "the rest" is exactly what
 * you cannot see, so the pill carries the session-wide total, shows from ONE
 * when any of it is elsewhere, and the tooltip splits it.
 *
 * Also: the two push listeners (canvas:changed, canvas:reviewChanged) refresh
 * the total, because those are the moments it can move.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { Review, CanvasLibraryEntry } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { useCanvasReviewStore, setupCanvasReviewListener } = await import('../../../src/renderer/stores/canvasReviewStore')
const { useCanvasStore, setupCanvasListener } = await import('../../../src/renderer/stores/canvasStore')
const { useCanvasTotalsStore } = await import('../../../src/renderer/stores/canvasTotalsStore')
const { useExcalidrawStore } = await import('../../../src/renderer/stores/excalidrawStore')
const { default: AgentCanvasButton } = await import('../../../src/renderer/components/AgentCanvasButton')

const api = (window as any).electronAPI.canvas
const listAll = api.listAll as ReturnType<typeof vi.fn>

const review = (id: string, status: Review['status'], annotationIds: string[] = []): Review => ({
  id, canvas: { canvasId: 'c1', versionId: 'v1' } as Review['canvas'], versionId: 'v1', annotationIds, status, createdAt: '2026-08-20T10:00:00.000Z',
})
/** A round waiting on YOU: submitted, its one note addressed. */
const owedRound = (id: string, noteId: string) => ({
  review: review(id, 'submitted' as const, [noteId]),
  note: { id: noteId, reviewId: id, scope: 'general' as const, note: 'x', versionId: 'v1', state: 'addressed' as const },
})
const entry = (over: Partial<CanvasLibraryEntry>): CanvasLibraryEntry => ({
  canvasId: over.canvasId ?? 'c', versionCount: 1, createdAt: '2026-08-21T00:00:00Z', lastRenderedAt: '2026-08-21T00:00:00Z', ...over,
})
function seedMirror(rounds: Array<ReturnType<typeof owedRound>>, extraReviews: Review[] = []) {
  useCanvasReviewStore.setState({
    bySessionId: {
      s1: {
        loaded: true, canvasId: 'c1', reviews: [...rounds.map((r) => r.review), ...extraReviews], annotations: rounds.map((r) => r.note),
        focus: null, focusChain: [], focusChainIndex: 0, marqueeArmed: false,
        editingAnnotationId: null, resolution: null, panelHighlight: null,
      },
    },
  })
}
function seedCanvasLive(awaiting = false) {
  useCanvasStore.setState({
    bySessionId: {
      s1: {
        canvasId: 'c1', versions: [], activeVersionId: null,
        interactionMode: 'browse', emptyView: 'intro', unseenRender: false, loaded: true,
        ...(awaiting ? { awaitingReview: { versionId: 'v1', at: '2026-08-26T10:00:00Z' } } : {}),
      },
    },
  })
}
function seedTotals(t: { queue: number; queueOnActive: number; unknown?: number }) {
  useCanvasTotalsStore.setState({
    bySessionId: {
      s1: {
        loaded: true, canvases: 1, openReviews: 0, withOpenReviews: 0, unknown: 0, onActive: 0,
        queueRows: [], ...t,
      },
    },
  })
}

let container: HTMLDivElement
let root: Root
beforeEach(() => {
  useCanvasReviewStore.setState({ bySessionId: {} })
  useCanvasTotalsStore.getState().reset()
  useCanvasStore.setState({ bySessionId: {} })
  useExcalidrawStore.setState({ bySessionId: {} })
  listAll.mockReset(); listAll.mockResolvedValue([])
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => { root.unmount() })
  container.remove()
})
const render = () => act(() => { root.render(React.createElement(AgentCanvasButton, { sessionId: 's1' })) })
const pill = () => container.querySelector('[data-testid="canvas-queue-count"]') as HTMLElement | null
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 10)) }) }

describe('the queue pill spans canvases (#364)', () => {
  it('shows the TOTAL across the session, not this canvas alone', async () => {
    // C1: the live debt is an OPEN VERSION awaiting review (awaitingReview),
    // never "rounds awaiting verdicts" — that class is extinct.
    seedCanvasLive(true)
    seedMirror([])
    seedTotals({ queue: 4, queueOnActive: 1 })       // 3 elsewhere
    render()
    expect(pill()?.textContent).toBe('4')
  })
  it('shows from ONE when that one is on a canvas you are not looking at', async () => {
    seedCanvasLive()
    seedMirror([])                                    // nothing here
    seedTotals({ queue: 1, queueOnActive: 0 })       // one elsewhere
    render()
    expect(pill()?.textContent).toBe('1')
  })
  it('shows from ONE on this canvas too — the from-two rule retired with the pulse', async () => {
    seedCanvasLive(true)
    seedMirror([])
    seedTotals({ queue: 1, queueOnActive: 1 })
    render()
    expect(pill()?.textContent).toBe('1')
  })
  it('rounds stacking on THIS canvas never push it past 1 (#470 -> C1: stacking is impossible by construction)', async () => {
    // C1: however many submitted rounds the mirror holds, the live debt is
    // the single awaitingReview slot — one open version per artifact.
    seedCanvasLive(true)
    seedMirror([owedRound('R1', 'a1'), owedRound('R2', 'a2')])
    seedTotals({ queue: 1, queueOnActive: 1 })
    render()
    expect(pill()?.textContent).toBe('1')
    // A round owed on a DIFFERENT canvas still adds — across canvases the
    // count may exceed 1.
    act(() => { seedTotals({ queue: 2, queueOnActive: 1 }) })
    expect(pill()?.textContent).toBe('2')
  })
  it('the live mirror wins for this canvas when it is fresher than the sweep -- DOWN (a verdict here drops the pill before the sweep catches up)', async () => {
    // Sweep still says 3 here + 1 elsewhere; the mirror knows all three here were just ruled on.
    seedCanvasLive()
    seedMirror([], [review('R1', 'resolved'), review('R2', 'resolved'), review('R3', 'resolved')])
    seedTotals({ queue: 4, queueOnActive: 3 })
    render()
    expect(pill()?.textContent).toBe('1')          // only the one elsewhere
    // And with nothing elsewhere either, the pill goes away entirely.
    act(() => { seedTotals({ queue: 3, queueOnActive: 3 }) })
    expect(pill()).toBeNull()
  })
  it('hydrates the sweep on first mount, once', async () => {
    listAll.mockResolvedValue([
      entry({ canvasId: 'a', ownedByThisSession: true, awaitingReview: true, awaitingReviewAt: '2026-08-23T10:00:00Z' }),
      entry({ canvasId: 'b', ownedByThisSession: true, awaitingReview: true, awaitingReviewAt: '2026-08-23T11:00:00Z', openReviewCount: 1 }),
    ])
    render()
    await flush()
    expect(listAll).toHaveBeenCalledTimes(1)
    expect(listAll.mock.calls[0][0]).toMatchObject({ sessionId: 's1' })
    expect(pill()?.textContent).toBe('2')
    act(() => { root.unmount() }); root = createRoot(container)
    render(); await flush()
    expect(listAll).toHaveBeenCalledTimes(1) // loaded -> no re-ask
  })
})

describe('the pushes keep it live', () => {
  it('canvas:changed and canvas:reviewChanged both schedule a refresh of the total', async () => {
    vi.useFakeTimers()
    try {
      let onChanged: ((e: any) => void) | null = null
      let onReviewChanged: ((e: any) => void) | null = null
      api.onChanged = vi.fn((h: (e: any) => void) => { onChanged = h; return () => {} })
      api.onReviewChanged = vi.fn((h: (e: any) => void) => { onReviewChanged = h; return () => {} })
      api.getState = vi.fn(() => Promise.resolve(null))
      api.reviewGetState = vi.fn(() => Promise.resolve(null))
      setupCanvasListener()
      setupCanvasReviewListener()
      // The listeners are armed once per module; if an earlier test armed them,
      // the handlers above are still the ones captured here only on first arm.
      expect(onChanged, 'canvas:changed listener armed').not.toBeNull()
      expect(onReviewChanged, 'canvas:reviewChanged listener armed').not.toBeNull()
      // Each push on its own reaches the sweep...
      onChanged!({ sessionId: 's1', canvasId: 'c1', activeVersionId: 'v1' })
      await vi.advanceTimersByTimeAsync(300)
      expect(listAll).toHaveBeenCalledTimes(1)
      onReviewChanged!({ sessionId: 's1', canvasId: 'c1' })
      await vi.advanceTimersByTimeAsync(300)
      expect(listAll).toHaveBeenCalledTimes(2)
      // ...and a burst of both collapses into one.
      onChanged!({ sessionId: 's1', canvasId: 'c1', activeVersionId: 'v1' })
      onReviewChanged!({ sessionId: 's1', canvasId: 'c1' })
      await vi.advanceTimersByTimeAsync(300)
      expect(listAll).toHaveBeenCalledTimes(3)
      expect(listAll.mock.calls[0][0]).toMatchObject({ sessionId: 's1' })
    } finally {
      vi.useRealTimers()
    }
  })
})
