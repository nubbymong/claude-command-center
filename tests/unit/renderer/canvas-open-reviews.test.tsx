// @vitest-environment jsdom
/**
 * "What is still owed on this canvas", in the two places it belongs.
 *
 * The count is derived from `Review.status === 'submitted'`, which is not an
 * approximation of "open" -- it IS the store's definition (a review only becomes
 * 'resolved' once no member note is still open or addressed). A count over NOTES
 * would mean two things at once, because an 'open' note waits on the agent and an
 * 'addressed' one waits on the user, and they share one list.
 *
 * The button shows the numeral only from TWO. A review closes only when every
 * note in it has a verdict, so a permanent "1" would stop meaning anything.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { Review, Annotation } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { useCanvasReviewStore, openReviewsOf, openSubmittedNotesOf } =
  await import('../../../src/renderer/stores/canvasReviewStore')
const { useCanvasStore } = await import('../../../src/renderer/stores/canvasStore')
const { useExcalidrawStore } = await import('../../../src/renderer/stores/excalidrawStore')
const { default: AgentCanvasButton } = await import('../../../src/renderer/components/AgentCanvasButton')

const review = (id: string, status: Review['status'], annotationIds: string[] = []): Review => ({
  id,
  canvas: { canvasId: 'c1', versionId: 'v1' } as Review['canvas'],
  versionId: 'v1',
  annotationIds,
  status,
  createdAt: '2026-08-20T10:00:00.000Z',
})

const note = (id: string, reviewId: string, state: Annotation['state']): Annotation => ({
  id,
  reviewId,
  scope: 'general',
  note: 'x',
  versionId: 'v1',
  state,
})

function seed(reviews: Review[], annotations: Annotation[] = [], loaded = true) {
  useCanvasReviewStore.setState({
    bySessionId: {
      s1: {
        loaded, canvasId: 'c1', reviews, annotations,
        focus: null, focusChain: [], focusChainIndex: 0, marqueeArmed: false,
        editingAnnotationId: null, resolution: null, panelHighlight: null, helpDismissed: false,
      },
    },
  })
}

describe('openReviewsOf', () => {
  it('counts submitted reviews and nothing else', () => {
    const s = {
      loaded: true, canvasId: 'c1',
      reviews: [review('R1', 'resolved'), review('R2', 'submitted'), review('R3', 'submitted'), review('R4', 'draft')],
      annotations: [],
      focus: null, focusChain: [], focusChainIndex: 0, marqueeArmed: false,
      editingAnnotationId: null, resolution: null, panelHighlight: null, helpDismissed: false,
    }
    expect(openReviewsOf(s).map((r) => r.id)).toEqual(['R2', 'R3'])
  })

  it('counts a review ONCE however many notes it holds -- unlike the note list', () => {
    const notes = [note('a1', 'R2', 'open'), note('a2', 'R2', 'addressed'), note('a3', 'R2', 'open')]
    const s = {
      loaded: true, canvasId: 'c1',
      reviews: [review('R2', 'submitted', ['a1', 'a2', 'a3'])],
      annotations: notes,
      focus: null, focusChain: [], focusChainIndex: 0, marqueeArmed: false,
      editingAnnotationId: null, resolution: null, panelHighlight: null, helpDismissed: false,
    }
    expect(openReviewsOf(s)).toHaveLength(1)
    // The note list is 3, and mixes "waiting on the agent" with "waiting on you".
    expect(openSubmittedNotesOf(s)).toHaveLength(3)
  })
})

describe('AgentCanvasButton -- the queue pill (#364, pick B)', () => {
  let container: HTMLDivElement
  let root: Root
  const reviewGetState = vi.fn(() => Promise.resolve(null))
  const getState = vi.fn(() => Promise.resolve(null))
  const listAll = vi.fn(() => Promise.resolve([]))

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    useCanvasStore.setState({ bySessionId: {} })
    useExcalidrawStore.setState({ bySessionId: {} } as never)
    reviewGetState.mockClear()
    getState.mockClear()
    listAll.mockClear()
    ;(globalThis as any).window.electronAPI = { canvas: { reviewGetState, getState, listAll } }
  })

  afterEach(() => {
    act(() => { root.unmount() })
    container.remove()
  })

  /** The live canvas mirror, loaded, with or without a ready-marked round. */
  function seedCanvas(awaiting: boolean) {
    useCanvasStore.setState({
      bySessionId: {
        s1: {
          canvasId: 'c1', versions: [], activeVersionId: null,
          interactionMode: 'browse', emptyView: 'intro', unseenRender: false, loaded: true,
          ...(awaiting ? { awaitingReview: { versionId: 'v1', at: '2026-08-23T10:00:00Z' } } : {}),
        },
      },
    })
  }

  const render = () => act(() => { root.render(<AgentCanvasButton sessionId="s1" />) })
  const pill = () => container.querySelector('[data-testid="canvas-queue-count"]')

  it('a round waiting on the AGENT counts for nothing: open notes, no pill', () => {
    seedCanvas(false)
    seed([review('R1', 'submitted', ['a1'])], [note('a1', 'R1', 'open')])
    render()
    expect(pill()).toBeNull()
    expect(container.querySelector('[data-testid="reserved-label-current"]')!.textContent).not.toContain('Review needed')
  })

  it('C1: an addressed round is NOT debt — only an open version awaiting review counts', () => {
    // The pre-C1 behavior ("every addressed note wants a verdict") is the
    // phantom "Review needed - 1" the owner reported. A submit now carries
    // the verdict, so an addressed round owes the user nothing.
    seedCanvas(false)
    seed([review('R1', 'submitted', ['a1'])], [note('a1', 'R1', 'addressed')])
    render()
    expect(pill()).toBeNull()
    expect(container.querySelector('[data-testid="reserved-label-current"]')!.textContent).not.toContain('Review needed')
  })

  it('a ready-marked render and a verdict round on ONE canvas still count 1 (#470)', () => {
    seedCanvas(true)
    seed([review('R1', 'submitted', ['a1'])], [note('a1', 'R1', 'addressed')])
    render()
    expect(pill()?.textContent).toBe('1')
  })

  it('shows nothing when every review is resolved and nothing is ready-marked', () => {
    seedCanvas(false)
    seed([review('R1', 'resolved'), review('R2', 'resolved')])
    render()
    expect(pill()).toBeNull()
  })

  it('never counts a draft review -- that is the one you are still writing', () => {
    seedCanvas(false)
    seed([review('R1', 'draft', ['a1']), review('R2', 'draft')], [note('a1', 'R1', 'open')])
    render()
    expect(pill()).toBeNull()
  })

  it('hydrates the review mirror itself, so the count is not silently zero', () => {
    // No entry for s1 at all: the notes panel has never mounted this run.
    useCanvasReviewStore.setState({ bySessionId: {} })
    render()
    expect(reviewGetState).toHaveBeenCalledWith({ sessionId: 's1' })
  })

  it('does not re-fetch a mirror that is already loaded', () => {
    seedCanvas(false)
    seed([review('R1', 'submitted')])
    render()
    expect(reviewGetState).not.toHaveBeenCalled()
    expect(getState).not.toHaveBeenCalled()
  })

  it('the attention dot is gone for good', () => {
    seedCanvas(true)
    seed([review('R1', 'submitted', ['a1'])], [note('a1', 'R1', 'addressed')])
    useCanvasStore.setState((s) => ({
      bySessionId: { ...s.bySessionId, s1: { ...s.bySessionId.s1, unseenRender: true } },
    }))
    render()
    expect(container.querySelector('[data-testid="canvas-attention-dot"]')).toBeNull()
  })
})
