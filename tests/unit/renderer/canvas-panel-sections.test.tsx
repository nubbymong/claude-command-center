// @vitest-environment jsdom
//
// The redesigned review panel (item C, phase 3): reviews are grouped under
// NEEDS YOU / WITH THE AGENT / CLOSED section headers, a round waiting on the
// user folds by default ONLY once its addressed notes have been seen (the
// seen-barrier must not be starved), and the panel offers a hide control.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import CanvasNotesPanel from '../../../src/renderer/components/CanvasNotesPanel'
import type { Annotation, CanvasReviewState, CanvasVersion, Review } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@excalidraw/excalidraw', () => ({ exportToBlob: vi.fn() }))

const { useCanvasReviewStore } = await import('../../../src/renderer/stores/canvasReviewStore')

const SID = 'session-1'
const VERSION: CanvasVersion = { id: 'v1', mode: 'design', createdAt: '2026-08-24T10:00:00Z', source: { mode: 'design', entry: 'index.html' } } as CanvasVersion

const review = (id: string, annotationIds: string[], over: Partial<Review> = {}): Review => ({
  id,
  canvas: { canvasId: 'canvas-1', versionId: 'v1' } as Review['canvas'],
  versionId: 'v1',
  annotationIds,
  status: 'submitted',
  createdAt: '2026-08-24T09:00:00Z',
  submittedAt: '2026-08-24T09:05:00Z',
  ...over,
})
const note = (id: string, reviewId: string, over: Partial<Annotation>): Annotation => ({
  id,
  reviewId,
  scope: 'general',
  note: `note ${id}`,
  versionId: 'v1',
  state: 'open',
  ...over,
})

/** One round in each of the TWO sections the settled machine leaves: R1 and R2
 *  are with the agent (one addressed, one open — both live rounds), R3 is
 *  SETTLED. There is no third section: nothing on this panel waits on the user,
 *  because the user's word is a decision on the VERSION. */
const STATE: CanvasReviewState = {
  canvasId: 'canvas-1',
  sessionId: SID,
  reviews: [
    review('R1', ['a1']),
    review('R2', ['a2']),
    review('R3', ['a3'], { status: 'resolved', settled: { at: '2026-08-24T09:30:00Z', by: 'decision', versionId: 'v2' } }),
  ],
  annotations: [
    note('a1', 'R1', { state: 'addressed' }),
    note('a2', 'R2', { state: 'open' }),
    note('a3', 'R3', { state: 'stale', closedBy: 'decision', closedFrom: 'addressed', settledBy: { versionId: 'v2' } }),
  ],
}

let container: HTMLDivElement
let root: Root
let current: CanvasReviewState = STATE

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  pty: { ...((globalThis as any).window?.electronAPI?.pty ?? {}), write: vi.fn() },
  canvas: { ...((globalThis as any).window?.electronAPI?.canvas ?? {}), reviewGetState: vi.fn(async () => current) },
}

async function render(props: { onHide?: () => void } = {}): Promise<void> {
  await act(async () => {
    root.render(
      <CanvasNotesPanel sessionId={SID} version={VERSION} getGlassApi={() => null} onReturnToTerminal={() => {}} isActive onHide={props.onHide} />,
    )
  })
}

function seed(state: CanvasReviewState): void {
  current = state
  useCanvasReviewStore.setState((s) => ({ bySessionId: { ...s.bySessionId, [SID]: { ...s.bySessionId[SID], ...state } } }))
}

const header = (reviewId: string): HTMLButtonElement =>
  container.querySelector(`[data-testid="review-group"][data-review="${reviewId}"] button`) as HTMLButtonElement

beforeEach(() => {
  useCanvasReviewStore.getState().reset()
  current = STATE
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('section headers', () => {
  it('groups the rounds under WITH THE AGENT / SETTLED, and offers no NEEDS-YOU section', async () => {
    seed(STATE)
    await render()
    const agent = container.querySelector('[data-testid="review-section-agent"]')
    const closed = container.querySelector('[data-testid="review-section-closed"]')
    expect(agent?.textContent).toContain('WITH THE AGENT')
    expect(closed?.textContent).toContain('SETTLED')
    expect(container.querySelector('[data-testid="review-section-you"]')).toBeNull()
    // Counts: two live rounds, one settled.
    expect(agent?.textContent).toContain('2')
    expect(closed?.textContent).toContain('1')
  })

  it('orders the sections with-agent, then settled', async () => {
    seed(STATE)
    await render()
    const order = Array.from(container.querySelectorAll('[data-testid^="review-section-"]')).map((el) =>
      el.getAttribute('data-testid'),
    )
    expect(order).toEqual(['review-section-agent', 'review-section-closed'])
  })
})

describe('collapse defaults', () => {
  it('keeps a LIVE round expanded — its addressed rows have to render for the user to read them', async () => {
    seed(STATE)
    await render()
    expect(header('R1').getAttribute('aria-expanded')).toBe('true')
    expect(header('R2').getAttribute('aria-expanded')).toBe('true')
  })

  it('folds a SETTLED round by default — history, not something to read past', async () => {
    seed(STATE)
    await render()
    expect(header('R3').getAttribute('aria-expanded')).toBe('false')
  })

  it('keeps a live round expanded even once every note on it has been seen', async () => {
    // The old fold was seen-aware, because an addressed round was work owed by
    // the user. It is not any more, so the round stays open until it settles.
    seed({
      ...STATE,
      reviews: [review('R1', ['a1'])],
      annotations: [note('a1', 'R1', { state: 'addressed', userSawAddressed: true })],
    })
    await render()
    expect(header('R1').getAttribute('aria-expanded')).toBe('true')
  })
})

describe('hide control', () => {
  it('shows a hide button only when the pane wired onHide, and it calls back', async () => {
    seed(STATE)
    await render({})
    expect(container.querySelector('[data-testid="canvas-panel-hide"]')).toBeNull()

    const onHide = vi.fn()
    await render({ onHide })
    const btn = container.querySelector('[data-testid="canvas-panel-hide"]') as HTMLButtonElement
    expect(btn).not.toBeNull()
    await act(async () => btn.click())
    expect(onHide).toHaveBeenCalledTimes(1)
  })
})
