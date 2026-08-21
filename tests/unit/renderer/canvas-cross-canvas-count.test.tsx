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

const review = (id: string, status: Review['status']): Review => ({
  id, canvas: { canvasId: 'c1', versionId: 'v1' } as Review['canvas'], versionId: 'v1', annotationIds: [], status, createdAt: '2026-08-20T10:00:00.000Z',
})
const entry = (over: Partial<CanvasLibraryEntry>): CanvasLibraryEntry => ({
  canvasId: over.canvasId ?? 'c', versionCount: 1, createdAt: '2026-08-21T00:00:00Z', lastRenderedAt: '2026-08-21T00:00:00Z', ...over,
})
function seedMirror(reviews: Review[]) {
  useCanvasReviewStore.setState({
    bySessionId: {
      s1: {
        loaded: true, canvasId: 'c1', reviews, annotations: [],
        focus: null, focusChain: [], focusChainIndex: 0, marqueeArmed: false,
        editingAnnotationId: null, resolution: null, panelHighlight: null, helpDismissed: false,
      },
    },
  })
}
function seedTotals(t: { canvases: number; openReviews: number; onActive: number; unknown?: number }) {
  useCanvasTotalsStore.setState({ bySessionId: { s1: { loaded: true, withOpenReviews: 0, unknown: 0, ...t } } })
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
const pill = () => container.querySelector('[data-testid="canvas-open-reviews-count"]') as HTMLElement | null
const flush = async () => { await act(async () => { await new Promise((r) => setTimeout(r, 10)) }) }

describe('the pill spans canvases', () => {
  it('shows the TOTAL across the session, not this canvas alone', async () => {
    seedMirror([review('R1', 'submitted')])                     // 1 here
    seedTotals({ canvases: 3, openReviews: 4, onActive: 1 })   // 3 elsewhere
    render()
    expect(pill()?.textContent).toBe('4')
    expect(pill()?.getAttribute('data-elsewhere')).toBe('3')
    expect(pill()?.title).toContain('4 reviews still open across 3 canvases')
    expect(pill()?.title).toContain('1 on this one, 3 elsewhere')
  })
  it('shows from ONE when that one is on a canvas you are not looking at', async () => {
    seedMirror([])                                               // nothing here
    seedTotals({ canvases: 2, openReviews: 1, onActive: 0 })    // one elsewhere
    render()
    expect(pill()?.textContent).toBe('1')
  })
  it('keeps the old rule on this canvas alone: one here and nothing elsewhere stays quiet; two shows', async () => {
    seedMirror([review('R1', 'submitted')])
    seedTotals({ canvases: 1, openReviews: 1, onActive: 1 })
    render()
    expect(pill()).toBeNull()
    act(() => { seedMirror([review('R1', 'submitted'), review('R2', 'submitted')]); seedTotals({ canvases: 1, openReviews: 2, onActive: 2 }) })
    expect(pill()?.textContent).toBe('2')
  })
  it('the live mirror wins for this canvas when it is fresher than the sweep -- UP', async () => {
    // Sweep says 1 in total; the mirror already knows a second review was sent here.
    seedMirror([review('R1', 'submitted'), review('R2', 'submitted')])
    seedTotals({ canvases: 1, openReviews: 1, onActive: 1 })
    render()
    expect(pill()?.textContent).toBe('2')
  })
  it('the live mirror wins for this canvas when it is fresher than the sweep -- DOWN (a close here drops the pill before the sweep catches up)', async () => {
    // Sweep still says 3 here + 1 elsewhere; the mirror knows all three here were just closed.
    seedMirror([review('R1', 'resolved'), review('R2', 'resolved'), review('R3', 'resolved')])
    seedTotals({ canvases: 2, openReviews: 4, onActive: 3 })
    render()
    expect(pill()?.textContent).toBe('1')          // only the one elsewhere
    expect(pill()?.getAttribute('data-elsewhere')).toBe('1')
    // And with nothing elsewhere either, the pill goes away entirely.
    act(() => { seedTotals({ canvases: 1, openReviews: 3, onActive: 3 }) })
    expect(pill()).toBeNull()
  })
  it('says when canvases could not be read instead of calling them clear', async () => {
    seedMirror([])
    seedTotals({ canvases: 3, openReviews: 2, onActive: 0, unknown: 1 })
    render()
    expect(pill()?.title).toContain('1 canvas could not be read')
  })
  it('hydrates the sweep on first mount, once', async () => {
    listAll.mockResolvedValue([entry({ canvasId: 'a', ownedByThisSession: true, openReviewCount: 2 }), entry({ canvasId: 'b', ownedByThisSession: true, openReviewCount: 1 })])
    render()
    await flush()
    expect(listAll).toHaveBeenCalledTimes(1)
    expect(listAll.mock.calls[0][0]).toMatchObject({ sessionId: 's1' })
    expect(pill()?.textContent).toBe('3')
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
