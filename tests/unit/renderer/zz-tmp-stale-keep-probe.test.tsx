// @vitest-environment jsdom
// TEMPORARY REVIEWER PROBE — deleted after the run.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { Annotation, CanvasReviewState, CanvasVersion, Review } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@excalidraw/excalidraw', () => ({ exportToBlob: vi.fn() }))

const CanvasNotesPanel = (await import('../../../src/renderer/components/CanvasNotesPanel')).default
const { useCanvasReviewStore } = await import('../../../src/renderer/stores/canvasReviewStore')

const SID = 's-1'
const V: CanvasVersion = { id: 'v1', mode: 'design', createdAt: '2026-08-23T10:00:00Z', source: { mode: 'design', entry: 'index.html' } } as CanvasVersion

const DRAFT_REVIEW: Review = {
  id: 'R1',
  canvas: { canvasId: 'canvas-1', sessionId: SID } as Review['canvas'],
  versionId: 'v1',
  annotationIds: ['a1'],
  status: 'draft',
  createdAt: '2026-08-23T09:00:00Z',
}
const NOTE_WITH_IMAGE: Annotation = {
  id: 'a1',
  reviewId: 'R1',
  scope: 'general',
  note: 'look at this',
  versionId: 'v1',
  state: 'open',
  image: { pngPath: 'reviews/pasted/a1.png' },
}
const WITH: CanvasReviewState = { canvasId: 'canvas-1', sessionId: SID, reviews: [DRAFT_REVIEW], annotations: [NOTE_WITH_IMAGE] }
const AFTER_DELETE: CanvasReviewState = { canvasId: 'canvas-1', sessionId: SID, reviews: [], annotations: [] }

const annotationUpsert = vi.fn(async () => ({ state: AFTER_DELETE, annotationId: 'a2' }))
const annotationDelete = vi.fn(async () => AFTER_DELETE)

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    reviewGetState: vi.fn(async () => WITH),
    annotationUpsert,
    annotationDelete,
  },
}

let container: HTMLDivElement
let root: Root
const q = (sel: string) => container.querySelector(sel) as HTMLElement | null
const byText = (tag: string, text: string) =>
  Array.from(container.querySelectorAll(tag)).find((e) => e.textContent?.trim() === text) as HTMLElement | undefined

beforeEach(() => {
  useCanvasReviewStore.getState().reset()
  annotationUpsert.mockClear()
  annotationDelete.mockClear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe("PROBE: stale image: 'keep' after the edited note is deleted", () => {
  it("leaves 'keep' on the composer and makes the next Add note fail silently", async () => {
    // Seed the store directly with a draft note carrying an image.
    await act(async () => {
      useCanvasReviewStore.setState({
        bySessionId: {
          [SID]: {
            loaded: true,
            canvasId: 'canvas-1',
            reviews: WITH.reviews,
            annotations: WITH.annotations,
            editingAnnotationId: null,
            focus: null,
            focusChain: [],
            focusChainIndex: 0,
          } as any,
        },
      })
    })
    await act(async () => {
      root.render(<CanvasNotesPanel sessionId={SID} version={V} getGlassApi={() => null} onReturnToTerminal={() => {}} isActive={true} />)
    })

    // The draft note is listed with its image chip.
    expect(q('[data-testid="draft-image-chip"]')).not.toBeNull()

    // Start editing it -> the composer picks up image: 'keep'.
    await act(async () => { byText('button', 'edit')!.click() })
    expect(q('[data-testid="composer-image-chip"]')).not.toBeNull()

    // Now DELETE the note that is being edited.
    await act(async () => { byText('button', 'delete')!.click(); await Promise.resolve() })
    await act(async () => { await Promise.resolve() })

    // BUG: the composer still shows the pasted-image chip for a note that is gone.
    const staleChip = q('[data-testid="composer-image-chip"]')
    // eslint-disable-next-line no-console
    console.log('PROBE stale composer chip after delete =', !!staleChip)

    // Type something and press Add note.
    const ta = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(ta, 'a brand new note')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const addBtn = byText('button', 'Add note')!
    await act(async () => { addBtn.click(); await Promise.resolve() })
    await act(async () => { await Promise.resolve() })

    // eslint-disable-next-line no-console
    console.log('PROBE upsert payload =', JSON.stringify(annotationUpsert.mock.calls[0]?.[0] ?? null))
  })
})
