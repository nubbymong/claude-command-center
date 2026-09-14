// @vitest-environment jsdom
//
// Collapsing a round is remembered PER CANVAS.
//
// Review ids are ordinal within their own canvas, so every canvas has an R1.
// Until this branch a session had one canvas and that was unambiguous; it can
// now switch between them, and the panel does not remount when it does. Keyed on
// the review id alone, "R1 is collapsed" followed the user from the canvas they
// left onto the one they arrived at, hiding notes they had never touched.
// (Reported by Copilot on #308.)
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { Annotation, CanvasReviewState, CanvasVersion, Review } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// The panel imports exportToBlob for submit; nothing here submits.
vi.mock('@excalidraw/excalidraw', () => ({ exportToBlob: vi.fn() }))

import { paneSketchProps } from './canvas-panel-harness'
const CanvasNotesPanel = (await import('../../../src/renderer/components/CanvasNotesPanel')).default
const { useCanvasReviewStore } = await import('../../../src/renderer/stores/canvasReviewStore')

const SID = 'session-1'
const VERSION: CanvasVersion = {
  id: 'v1',
  mode: 'design',
  createdAt: '2026-08-21T10:00:00Z',
  source: { mode: 'design', entry: 'index.html' },
} as CanvasVersion

/** Submitted rounds, each with one note the agent says it has addressed — so
 *  every round is waiting on the USER and its default is EXPANDED. */
function stateFor(canvasId: string, ...noteTexts: string[]): CanvasReviewState {
  const reviews: Review[] = []
  const annotations: Annotation[] = []
  noteTexts.forEach((text, i) => {
    const id = `R${i + 1}`
    const noteId = `a${i + 1}`
    reviews.push({
      id,
      canvas: { canvasId, versionId: 'v1' } as Review['canvas'],
      versionId: 'v1',
      annotationIds: [noteId],
      status: 'submitted',
      createdAt: `2026-08-21T09:0${i}:00Z`,
      submittedAt: `2026-08-21T09:0${i}:30Z`,
    })
    annotations.push({
      id: noteId,
      reviewId: id,
      scope: 'general',
      note: text,
      versionId: 'v1',
      state: 'addressed',
    })
  })
  return { canvasId, sessionId: SID, reviews, annotations }
}

// Two rounds on A, because "reviews grouped into rounds" is the feature this
// sits inside: with one round per canvas, a key that ignored the review id
// entirely would look correct.
const CANVAS_A = stateFor('canvas-a', 'the header is cramped', 'the sidebar is noisy')
const CANVAS_B = stateFor('canvas-b', 'the footer needs work')

let current: CanvasReviewState = CANVAS_A
/** The canvas the PANE is showing. The panel is told it explicitly now, and
 *  every composer read hangs off it agreeing with the mirror. */
let paneCanvasId = 'canvas-a'
let container: HTMLDivElement
let root: Root

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  pty: { ...((globalThis as any).window?.electronAPI?.pty ?? {}), write: vi.fn() },
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    reviewGetState: vi.fn(async () => current),
  },
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <CanvasNotesPanel sessionId={SID} version={VERSION} getGlassApi={() => null} onReturnToTerminal={() => {}} {...paneSketchProps()} canvasId={paneCanvasId} />,
    )
  })
}

/** The round header, whose aria-expanded IS the collapsed state the user sees. */
function roundHeader(reviewId = 'R1'): HTMLButtonElement {
  const group = container.querySelector(`[data-testid="review-group"][data-review="${reviewId}"]`)
  expect(group, `the ${reviewId} round`).toBeTruthy()
  const button = group!.querySelector('button')
  expect(button, 'the round header button').toBeTruthy()
  return button as HTMLButtonElement
}

/** Swap which canvas the session is on, the way the subject picker does. */
async function switchTo(next: CanvasReviewState): Promise<void> {
  current = next
  paneCanvasId = next.canvasId
  await act(async () => {
    useCanvasReviewStore.setState((s) => ({
      bySessionId: { ...s.bySessionId, [SID]: { ...s.bySessionId[SID], ...next } },
    }))
  })
  await render()
}

beforeEach(async () => {
  current = CANVAS_A
  paneCanvasId = 'canvas-a'
  useCanvasReviewStore.getState().reset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('a collapsed round does not follow you to another canvas', () => {
  it('leaves the other canvas\'s R1 expanded after you collapse this one', async () => {
    await render()
    await switchTo(CANVAS_A)
    expect(roundHeader().getAttribute('aria-expanded')).toBe('true')

    await act(async () => roundHeader().click())
    expect(roundHeader().getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).not.toContain('the header is cramped')

    // Same session, same panel, different canvas — and canvas B's R1 is a
    // different round that the user has never collapsed.
    await switchTo(CANVAS_B)
    expect(roundHeader().getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('the footer needs work')
  })

  it('collapses only the round you clicked, not every round on the canvas', async () => {
    // The key has two halves and both have to be in it. Keyed by canvas alone,
    // one click folds away rounds the user never touched.
    await render()
    await switchTo(CANVAS_A)
    expect(roundHeader('R1').getAttribute('aria-expanded')).toBe('true')
    expect(roundHeader('R2').getAttribute('aria-expanded')).toBe('true')

    await act(async () => roundHeader('R2').click())
    expect(roundHeader('R2').getAttribute('aria-expanded')).toBe('false')
    expect(roundHeader('R1').getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('the header is cramped')
  })

  it('still finds your toggle where you left it when you switch back', async () => {
    await render()
    await switchTo(CANVAS_A)
    await act(async () => roundHeader().click())
    expect(roundHeader().getAttribute('aria-expanded')).toBe('false')

    await switchTo(CANVAS_B)
    expect(roundHeader().getAttribute('aria-expanded')).toBe('true')

    await switchTo(CANVAS_A)
    expect(roundHeader().getAttribute('aria-expanded')).toBe('false')
  })
})
