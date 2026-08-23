// @vitest-environment jsdom
//
// Per-note variants (#373), the panel half: an addressed note carrying
// alternatives renders one chip per variant, clicking a chip approves WITH the
// key, and a closed note that was approved through a chip says which one won.
// These render the REAL panel and read what a person would see.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { Annotation, CanvasReviewState, CanvasVersion, Review } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@excalidraw/excalidraw', () => ({ exportToBlob: vi.fn() }))

const CanvasNotesPanel = (await import('../../../src/renderer/components/CanvasNotesPanel')).default
const { useCanvasReviewStore } = await import('../../../src/renderer/stores/canvasReviewStore')

const SID = 'session-1'
const V2: CanvasVersion = {
  id: 'v2',
  mode: 'design',
  createdAt: '2026-08-23T10:00:00Z',
  source: { mode: 'design', entry: 'index.html' },
} as CanvasVersion

const REVIEW: Review = {
  id: 'R1',
  canvas: { canvasId: 'canvas-1', versionId: 'v1' } as Review['canvas'],
  versionId: 'v1',
  annotationIds: ['a1', 'a2', 'a3'],
  status: 'submitted',
  createdAt: '2026-08-23T09:00:00Z',
  submittedAt: '2026-08-23T09:05:00Z',
}

/** Addressed WITH alternatives: the agent offered two ways to fix it. */
const OFFERED: Annotation = {
  id: 'a1',
  reviewId: 'R1',
  scope: 'general',
  note: 'the divider is heavy',
  versionId: 'v1',
  state: 'addressed',
  addressedAt: '2026-08-23T09:10:00Z',
  addressedBy: { actor: 'agent', sessionId: SID },
  variants: [
    { key: 'A', label: 'thin rule' },
    { key: 'B', label: 'no rule' },
  ],
}

/** Addressed with NO alternatives: the ordinary single-fix path. */
const PLAIN: Annotation = {
  id: 'a2',
  reviewId: 'R1',
  scope: 'general',
  note: 'tighten the header',
  versionId: 'v1',
  state: 'addressed',
  addressedAt: '2026-08-23T09:10:00Z',
  addressedBy: { actor: 'agent', sessionId: SID },
}

/** Already approved through a chip: the closed row must say which one won. */
const PICKED: Annotation = {
  id: 'a3',
  reviewId: 'R1',
  scope: 'general',
  note: 'the footer crowds the content',
  versionId: 'v1',
  state: 'approved',
  closedBy: 'user',
  closedFrom: 'addressed',
  variants: [
    { key: 'A', label: 'more padding' },
    { key: 'B', label: 'drop the footer' },
  ],
  chosenVariantKey: 'B',
}

const STATE: CanvasReviewState = {
  canvasId: 'canvas-1',
  sessionId: SID,
  reviews: [REVIEW],
  annotations: [OFFERED, PLAIN, PICKED],
}

const annotationResolve = vi.fn(async () => ({ state: STATE }))

let container: HTMLDivElement
let root: Root

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  pty: { ...((globalThis as any).window?.electronAPI?.pty ?? {}), write: vi.fn() },
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    reviewGetState: vi.fn(async () => STATE),
    annotationResolve,
  },
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <CanvasNotesPanel sessionId={SID} version={V2} getGlassApi={() => null} onReturnToTerminal={() => {}} />,
    )
  })
}

beforeEach(async () => {
  useCanvasReviewStore.getState().reset()
  annotationResolve.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('variant chips on an addressed note', () => {
  it('renders one chip per variant, with its key and label, on the offering note only', async () => {
    await render()
    const chipRows = container.querySelectorAll('[data-testid="note-variant-chips"]')
    expect(chipRows).toHaveLength(1)
    const a = container.querySelector('[data-testid="note-variant-A"]')!
    const b = container.querySelector('[data-testid="note-variant-B"]')!
    expect(a.textContent).toContain('A · thin rule')
    expect(b.textContent).toContain('B · no rule')
    // The plain Approve is still there beside them.
    const row = chipRows[0].parentElement!
    expect(row.textContent).toContain('Approve')
  })

  it('clicking a chip approves WITH that key', async () => {
    await render()
    await act(async () => {
      ;(container.querySelector('[data-testid="note-variant-B"]') as HTMLButtonElement).click()
    })
    expect(annotationResolve).toHaveBeenCalledWith({
      sessionId: SID,
      canvasId: 'canvas-1',
      annotationId: 'a1',
      action: 'approve',
      variantKey: 'B',
    })
  })

  it('the plain Approve still approves WITHOUT a key', async () => {
    await render()
    const chipRow = container.querySelector('[data-testid="note-variant-chips"]')!
    const approve = Array.from(chipRow.parentElement!.querySelectorAll('button')).find(
      (el) => el.textContent === 'Approve',
    )!
    await act(async () => {
      approve.click()
    })
    const args = annotationResolve.mock.calls[0][0] as Record<string, unknown>
    expect(args.action).toBe('approve')
    expect('variantKey' in args).toBe(false)
  })
})

describe('the closed row names the winner', () => {
  it('shows "picked B — drop the footer" on the approved note, once the closed section is open', async () => {
    await render()
    await act(async () => {
      ;(container.querySelector('[data-testid="review-closed-toggle"]') as HTMLButtonElement).click()
    })
    const picked = container.querySelector('[data-testid="review-closed-picked-variant"]')!
    expect(picked).toBeTruthy()
    expect(picked.textContent).toBe('picked B — drop the footer')
  })
})
