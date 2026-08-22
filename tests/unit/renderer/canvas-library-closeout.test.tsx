// @vitest-environment jsdom
//
// The canvas library's "Close notes" row action (#365, Q-7).
//
// This is the seam where a count computed in one file labels a button that
// calls a rule written in another, and it is where the first cut of this
// feature broke: the label came from `addressedNotes` (every addressed note on
// the canvas) while the mutation skipped any round still holding an open note.
// On the routine partial round the button promised "Close 1 note", cleared
// nothing, and — because the number it was drawn from never moved — stayed on
// screen for ever with no explanation.
//
// So the rule these tests hold to is one sentence: THE BUTTON APPEARS WHEN, AND
// COUNTS WHAT, THE MUTATION WOULD ACTUALLY CLEAR. `closeableNoteCount` is the
// single number for both, and main computes it with the mutation's own gate.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { CanvasLibraryEntry } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const { CanvasLibrary } = await import('../../../src/renderer/components/CanvasLibrary')

const SID = 'session-1'

function entry(over: Partial<CanvasLibraryEntry> = {}): CanvasLibraryEntry {
  return {
    canvasId: 'canvas-a',
    versionCount: 3,
    createdAt: '2026-08-22T09:00:00Z',
    lastRenderedAt: '2026-08-22T11:00:00Z',
    title: 'Checkout flow',
    cwd: 'F:/work/project',
    latestMode: 'design',
    ...over,
  }
}

let container: HTMLDivElement
let root: Root
let entries: CanvasLibraryEntry[]
let closeOutCalls: string[]
/** What main answers for reviewCloseOut. */
let closeOutReply: { ok: boolean; closed?: number; reviews?: string[] }

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    listAll: vi.fn(async () => entries),
    deleteCanvas: vi.fn(async () => ({ ok: true })),
    reclaim: vi.fn(async () => ({ ok: true, state: null })),
    reviewCloseOut: vi.fn(async ({ canvasId }: { canvasId: string }) => {
      closeOutCalls.push(canvasId)
      return closeOutReply
    }),
  },
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<CanvasLibrary sessionId={SID} onClose={() => {}} />)
  })
}

const byTestId = (id: string): HTMLElement | null => container.querySelector(`[data-testid="${id}"]`)

async function click(el: Element | null): Promise<void> {
  expect(el).toBeTruthy()
  await act(async () => (el as HTMLElement).click())
}

beforeEach(() => {
  closeOutCalls = []
  closeOutReply = { ok: true, closed: 3, reviews: ['R1'] }
  entries = [entry({ closeableNoteCount: 3, openReviewCount: 1 })]
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('when the button is offered', () => {
  it('appears when there is something a close-out would clear', async () => {
    await render()
    expect(byTestId('canvas-library-close')).toBeTruthy()
  })

  it('is absent on a partial round, where the mutation would clear nothing', async () => {
    // The Q-1 case: an addressed note exists, but its round still holds an open
    // one, so `closeableNoteCount` is 0 and no button is drawn. Before the fix
    // this rendered a button that did nothing and never went away.
    entries = [entry({ closeableNoteCount: 0, openReviewCount: 1 })]
    await render()
    expect(byTestId('canvas-library-close')).toBeNull()
  })

  it('is absent when the review store could not be read', async () => {
    // undefined, never 0 — "could not tell" must not render as an offer.
    entries = [entry({ closeableNoteCount: undefined, openReviewCount: undefined })]
    await render()
    expect(byTestId('canvas-library-close')).toBeNull()
  })

  it('is absent on a canvas with nothing outstanding at all', async () => {
    entries = [entry({ closeableNoteCount: 0, openReviewCount: 0 })]
    await render()
    expect(byTestId('canvas-library-close')).toBeNull()
  })
})

describe('what it says and does', () => {
  it('is two-step, and the confirm counts exactly what will be cleared', async () => {
    await render()
    expect(byTestId('canvas-library-close-confirm')).toBeNull()
    await click(byTestId('canvas-library-close'))
    const confirm = byTestId('canvas-library-close-confirm')
    expect(confirm).toBeTruthy()
    expect(confirm!.textContent).toBe('Close 3 notes')
    expect(closeOutCalls).toEqual([])
  })

  it('singularises one note', async () => {
    entries = [entry({ closeableNoteCount: 1, openReviewCount: 1 })]
    await render()
    await click(byTestId('canvas-library-close'))
    expect(byTestId('canvas-library-close-confirm')!.textContent).toBe('Close 1 note')
  })

  it('calls close-out for that canvas and reports how many were cleared', async () => {
    await render()
    await click(byTestId('canvas-library-close'))
    await click(byTestId('canvas-library-close-confirm'))

    expect(closeOutCalls).toEqual(['canvas-a'])
    expect(byTestId('canvas-library-closed-count')!.textContent).toContain('closed 3 notes')
  })

  it('never deletes — the delete path is a different call entirely', async () => {
    await render()
    await click(byTestId('canvas-library-close'))
    await click(byTestId('canvas-library-close-confirm'))
    expect((window as any).electronAPI.canvas.deleteCanvas).not.toHaveBeenCalled()
    // The row is still there afterwards; a cleared canvas is not a gone one.
    expect(container.querySelectorAll('[data-testid="canvas-library-row"]')).toHaveLength(1)
  })

  it('says the store could not be read rather than "cleared 0"', async () => {
    // ok:false is "could not tell", and the difference matters: reporting it as
    // a successful close of zero tells the user their board is clear when
    // nothing was even read.
    closeOutReply = { ok: false }
    await render()
    await click(byTestId('canvas-library-close'))
    await click(byTestId('canvas-library-close-confirm'))

    expect(byTestId('canvas-library-closed-count')).toBeNull()
    expect(container.textContent).toContain('could not be read')
  })

  it('arming delete disarms close, so the two confirms can never both be live', async () => {
    await render()
    await click(byTestId('canvas-library-close'))
    expect(byTestId('canvas-library-close-confirm')).toBeTruthy()
    await click(byTestId('canvas-library-delete'))
    expect(byTestId('canvas-library-close-confirm')).toBeNull()
    expect(byTestId('canvas-library-confirm-delete')).toBeTruthy()
  })

  it('arming close disarms delete', async () => {
    await render()
    await click(byTestId('canvas-library-delete'))
    expect(byTestId('canvas-library-confirm-delete')).toBeTruthy()
    await click(byTestId('canvas-library-close'))
    expect(byTestId('canvas-library-confirm-delete')).toBeNull()
    expect(byTestId('canvas-library-close-confirm')).toBeTruthy()
  })
})
