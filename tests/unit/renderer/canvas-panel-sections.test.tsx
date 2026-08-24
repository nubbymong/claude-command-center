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

const review = (id: string, annotationIds: string[]): Review => ({
  id,
  canvas: { canvasId: 'canvas-1', versionId: 'v1' } as Review['canvas'],
  versionId: 'v1',
  annotationIds,
  status: 'submitted',
  createdAt: '2026-08-24T09:00:00Z',
  submittedAt: '2026-08-24T09:05:00Z',
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

/** One round in each section: R1 needs the user (addressed, unseen), R2 is with
 *  the agent (open), R3 is closed (approved). */
const STATE: CanvasReviewState = {
  canvasId: 'canvas-1',
  sessionId: SID,
  reviews: [review('R1', ['a1']), review('R2', ['a2']), review('R3', ['a3'])],
  annotations: [
    note('a1', 'R1', { state: 'addressed' }),
    note('a2', 'R2', { state: 'open' }),
    note('a3', 'R3', { state: 'approved', closedBy: 'user', closedFrom: 'addressed' }),
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
  it('groups the rounds under NEEDS YOU / WITH THE AGENT / CLOSED', async () => {
    seed(STATE)
    await render()
    const you = container.querySelector('[data-testid="review-section-you"]')
    const agent = container.querySelector('[data-testid="review-section-agent"]')
    const closed = container.querySelector('[data-testid="review-section-closed"]')
    expect(you?.textContent).toContain('NEEDS YOU')
    expect(agent?.textContent).toContain('WITH THE AGENT')
    expect(closed?.textContent).toContain('CLOSED')
    // Counts: one round each.
    expect(you?.textContent).toContain('1')
    expect(agent?.textContent).toContain('1')
    expect(closed?.textContent).toContain('1')
  })

  it('orders the sections needs-you, then with-agent, then closed', async () => {
    seed(STATE)
    await render()
    const order = Array.from(container.querySelectorAll('[data-testid^="review-section-"]')).map((el) =>
      el.getAttribute('data-testid'),
    )
    expect(order).toEqual(['review-section-you', 'review-section-agent', 'review-section-closed'])
  })
})

describe('seen-aware collapse', () => {
  it('keeps an UNSEEN needs-you round expanded (the seen-barrier depends on it rendering)', async () => {
    seed(STATE)
    await render()
    expect(header('R1').getAttribute('aria-expanded')).toBe('true')
  })

  it('folds a needs-you round once every addressed note in it has been seen', async () => {
    seed({
      ...STATE,
      reviews: [review('R1', ['a1'])],
      annotations: [note('a1', 'R1', { state: 'addressed', userSawAddressed: true })],
    })
    await render()
    expect(header('R1').getAttribute('aria-expanded')).toBe('false')
  })

  it('folds a closed round by default, and leaves an agent round open', async () => {
    seed(STATE)
    await render()
    expect(header('R3').getAttribute('aria-expanded')).toBe('false') // closed
    expect(header('R2').getAttribute('aria-expanded')).toBe('true') // with the agent
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
