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

const CanvasNotesPanel = (await import('../../../src/renderer/components/CanvasNotesPanel')).default
const { useCanvasReviewStore } = await import('../../../src/renderer/stores/canvasReviewStore')

const SID = 'session-1'
const VERSION: CanvasVersion = {
  id: 'v1',
  mode: 'design',
  createdAt: '2026-08-21T10:00:00Z',
  source: { mode: 'design', entry: 'index.html' },
} as CanvasVersion

/** One submitted round, one note the agent says it has addressed — so the round
 *  is waiting on the USER and its default is EXPANDED. */
function stateFor(canvasId: string, noteText: string): CanvasReviewState {
  const review: Review = {
    id: 'R1',
    canvas: { canvasId, versionId: 'v1' } as Review['canvas'],
    versionId: 'v1',
    annotationIds: ['a1'],
    status: 'submitted',
    createdAt: '2026-08-21T09:00:00Z',
    submittedAt: '2026-08-21T09:05:00Z',
  }
  const note: Annotation = {
    id: 'a1',
    reviewId: 'R1',
    scope: 'general',
    note: noteText,
    versionId: 'v1',
    state: 'addressed',
  }
  return { canvasId, sessionId: SID, reviews: [review], annotations: [note] }
}

const CANVAS_A = stateFor('canvas-a', 'the header is cramped')
const CANVAS_B = stateFor('canvas-b', 'the footer needs work')

let current: CanvasReviewState = CANVAS_A
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
      <CanvasNotesPanel sessionId={SID} version={VERSION} getGlassApi={() => null} onReturnToTerminal={() => {}} />,
    )
  })
}

/** The round header, whose aria-expanded IS the collapsed state the user sees. */
function roundHeader(): HTMLButtonElement {
  const group = container.querySelector('[data-testid="review-group"][data-review="R1"]')
  expect(group, 'the R1 round').toBeTruthy()
  const button = group!.querySelector('button')
  expect(button, 'the round header button').toBeTruthy()
  return button as HTMLButtonElement
}

/** Swap which canvas the session is on, the way the subject picker does. */
async function switchTo(next: CanvasReviewState): Promise<void> {
  current = next
  await act(async () => {
    useCanvasReviewStore.setState((s) => ({
      bySessionId: { ...s.bySessionId, [SID]: { ...s.bySessionId[SID], ...next } },
    }))
  })
  await render()
}

beforeEach(async () => {
  current = CANVAS_A
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
