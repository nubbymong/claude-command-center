// @vitest-environment jsdom
//
// The panel's SHAPE after the M2 rework: history folded at the top, the live
// round below it, and nothing else competing for the reader.
//
// What this replaces matters. The panel used to sort every round into
// NEEDS YOU / WITH THE AGENT / CLOSED section headers, each with a count — three
// headings and three numbers describing at most two rounds. The settled machine
// removed the first section (nothing on this panel waits on the user; their word
// is a decision on the VERSION), and the rework removed the other two: settled
// rounds fold into one History row, and the live round is simply the card.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import CanvasNotesPanel from '../../../src/renderer/components/CanvasNotesPanel'
import { paneSketchProps } from './canvas-panel-harness'
import type { Annotation, CanvasReviewState, CanvasVersion, Review } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@excalidraw/excalidraw', () => ({ exportToBlob: vi.fn() }))

const { useCanvasReviewStore } = await import('../../../src/renderer/stores/canvasReviewStore')

const SID = 'session-1'
const CID = 'canvas-1'
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

/** Two live rounds (a user Reopen can legitimately make a second) and one
 *  settled. */
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
      <CanvasNotesPanel sessionId={SID} version={VERSION} getGlassApi={() => null} onReturnToTerminal={() => {}} {...paneSketchProps()} canvasId={CID} isActive onHide={props.onHide} />,
    )
  })
}

function seed(state: CanvasReviewState): void {
  current = state
  useCanvasReviewStore.setState((s) => ({ bySessionId: { ...s.bySessionId, [SID]: { ...s.bySessionId[SID], ...state } } }))
}

const card = (reviewId: string): HTMLElement | null =>
  container.querySelector(`[data-testid="review-group"][data-review="${reviewId}"]`)

const header = (reviewId: string): HTMLButtonElement => card(reviewId)!.querySelector('button') as HTMLButtonElement

const q = (id: string): HTMLElement | null => container.querySelector(`[data-testid="${id}"]`)

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

describe('history is folded, at the top', () => {
  it('shows one History row for the settled rounds and no section headings', async () => {
    seed(STATE)
    await render()
    const folded = q('canvas-history-folded')
    expect(folded).not.toBeNull()
    expect(folded!.textContent).toContain('History')
    expect(folded!.textContent).toContain('1 earlier round')
    expect(folded!.textContent).toContain('settled')
    expect(folded!.getAttribute('aria-expanded')).toBe('false')
    // The three headings and their three counts are gone.
    expect(q('review-section-agent')).toBeNull()
    expect(q('review-section-closed')).toBeNull()
    expect(q('review-section-you')).toBeNull()
    // And the settled round is not drawn until History is opened.
    expect(card('R3')).toBeNull()
  })

  it('sits ABOVE the live round — the past folds, the work does not', async () => {
    seed(STATE)
    await render()
    const folded = q('canvas-history-folded')!
    const live = card('R1')!
    expect(folded.compareDocumentPosition(live) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('expands to the settled rounds', async () => {
    seed(STATE)
    await render()
    await act(async () => (q('canvas-history-folded') as HTMLElement).click())
    expect(card('R3')).not.toBeNull()
    expect(q('canvas-history-folded')!.getAttribute('aria-expanded')).toBe('true')
  })

  it('offers no History row at all when nothing has settled', async () => {
    seed({ ...STATE, reviews: [review('R1', ['a1'])], annotations: [note('a1', 'R1', { state: 'open' })] })
    await render()
    expect(q('canvas-history-folded')).toBeNull()
  })
})

describe('the live round', () => {
  it('is drawn expanded, with an OPEN pill and no count', async () => {
    seed(STATE)
    await render()
    expect(header('R1').getAttribute('aria-expanded')).toBe('true')
    expect(header('R2').getAttribute('aria-expanded')).toBe('true')
    const pills = container.querySelectorAll('[data-testid="round-open-pill"]')
    expect(pills).toHaveLength(2)
    expect(pills[0].textContent).toBe('OPEN')
    // "N for you" / "1 pending" are gone: a live round says OPEN and nothing else.
    expect(container.textContent).not.toContain('for you')
    expect(container.textContent).not.toContain('pending')
    expect(container.textContent).not.toContain('with the agent')
  })

  it('stays expanded once every note on it has been seen', async () => {
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
    expect(q('canvas-panel-hide')).toBeNull()

    const onHide = vi.fn()
    await render({ onHide })
    const btn = q('canvas-panel-hide') as HTMLButtonElement
    expect(btn).not.toBeNull()
    // The ONE dismiss control, so it carries an accessible name rather than a
    // bare glyph.
    expect(btn.getAttribute('aria-label')).toBe('Hide the review panel')
    await act(async () => btn.click())
    expect(onHide).toHaveBeenCalledTimes(1)
  })
})

describe('the anchor chip is a WARNING, not a status', () => {
  it('shows nothing on a plain live note anchored to the displayed version', async () => {
    // Only the two cases the user has to be warned about are drawn: a box the
    // PAGE claims, and one that needs re-pointing. A badge on every ordinary row
    // teaches the eye to skip the chip column — which is exactly where the
    // page-reported warning lives (adversarial review, 2026-08-14).
    seed({
      ...STATE,
      reviews: [review('R1', ['a1'])],
      annotations: [
        note('a1', 'R1', {
          state: 'open',
          scope: 'element',
          versionId: 'v1',
          focus: {
            targets: [{ kind: 'ux-id', id: 'save' }],
            bboxPage: { x: 1, y: 2, width: 3, height: 4 },
            label: 'button "Save"',
            versionId: 'v1',
          },
        }),
      ],
    })
    await render()
    const row = container.querySelector('[data-testid="round-note"]')!
    expect(row.textContent).toContain('note a1')
    // The note's own state still reads, and its target is still attributed.
    expect(row.querySelector('[data-testid="note-state-chip"]')!.textContent).toBe('open')
    expect(row.textContent).toContain('button "Save"')
    // …and nothing claims anything about where it is.
    expect(row.textContent).not.toContain('on this version')
    expect(row.textContent).not.toContain('general')
    expect(row.textContent).not.toContain('re-anchored')
    expect(row.textContent).not.toContain('needs re-pointing')
  })
})
