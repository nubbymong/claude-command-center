// @vitest-environment jsdom
//
// The hand-back signal after #366 (owner pick B): the purple pulse is RETIRED.
// A render only becomes news when the agent deliberately marks it ready —
// drafts surface nothing at all — and readiness shows as words on the Canvas
// button ("Review needed", warning colour, the queue count), not as a glow.
// Pins the store rule (draft events never mark unseen) and the button's B
// state, including that the old attention dot cannot come back.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import AgentCanvasButton from '../../../src/renderer/components/AgentCanvasButton'
import { setupCanvasListener, useCanvasStore } from '../../../src/renderer/stores/canvasStore'
import { useCanvasReviewStore } from '../../../src/renderer/stores/canvasReviewStore'
import { useCanvasTotalsStore } from '../../../src/renderer/stores/canvasTotalsStore'
import { useExcalidrawStore } from '../../../src/renderer/stores/excalidrawStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const SID = 'session-1'

// Capture the canvas:changed callback; the three reads feed the queue.
let onChangedCb:
  | ((e: { sessionId: string; canvasId: string; activeVersionId: string | null; draft?: boolean }) => void)
  | null = null
const getState = vi.fn().mockResolvedValue(null)
const reviewGetState = vi.fn().mockResolvedValue(null)
const listAll = vi.fn().mockResolvedValue([])
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    onChanged: (cb: typeof onChangedCb) => {
      onChangedCb = cb
      return () => {}
    },
    getState,
    reviewGetState,
    listAll,
  },
}

function fireChanged(draft?: boolean): void {
  act(() => {
    onChangedCb?.({ sessionId: SID, canvasId: 'c1', activeVersionId: 'v1', ...(draft ? { draft } : {}) })
  })
}

beforeEach(() => {
  useCanvasStore.getState().reset()
  useCanvasReviewStore.getState().reset()
  useCanvasTotalsStore.getState().reset()
  // The excalidraw store has no full reset; drive the per-session flag directly.
  useExcalidrawStore.getState().setOpen(SID, false)
  getState.mockResolvedValue(null)
  reviewGetState.mockResolvedValue(null)
  listAll.mockResolvedValue([])
  setupCanvasListener() // idempotent; first call arms, later calls no-op
  expect(onChangedCb).toBeTruthy()
})

describe('unseen-render tracking (#366)', () => {
  it('marks a READY render that lands while the pane is closed, and only then', () => {
    fireChanged()
    expect(useCanvasStore.getState().bySessionId[SID].unseenRender).toBe(true)

    useCanvasStore.getState().clearUnseenRender(SID)
    useExcalidrawStore.getState().setOpen(SID, true)
    fireChanged()
    expect(useCanvasStore.getState().bySessionId[SID].unseenRender).toBe(false)
  })

  it('a DRAFT render is never news: the event carries draft and nothing is marked', () => {
    useExcalidrawStore.getState().setOpen(SID, false)
    fireChanged(true)
    expect(useCanvasStore.getState().bySessionId[SID]?.unseenRender ?? false).toBe(false)
  })

  it('a draft that CHANGES SUBJECT surfaces nothing either: no filing notice, no mirror move, deferred to the ready-mark', () => {
    // The user is on canvas c1; the agent starts drafting a NEW subject, which
    // files c1 store-side and repoints the session at c2. The renderer must
    // stay silent AND stay put — the filing is announced by the ready-mark's
    // own event, whose prev is still the canvas the user was on.
    useCanvasStore.setState({
      bySessionId: {
        [SID]: {
          canvasId: 'c1', versions: [], activeVersionId: 'v1',
          interactionMode: 'browse', emptyView: 'intro', unseenRender: false, loaded: true,
        },
      },
    })
    getState.mockClear()
    act(() => { onChangedCb?.({ sessionId: SID, canvasId: 'c2', activeVersionId: 'v1', draft: true }) })
    const afterDraft = useCanvasStore.getState().bySessionId[SID]
    expect(afterDraft.filedNotice ?? null).toBeNull()
    expect(afterDraft.canvasId, 'the mirror must not follow a draft').toBe('c1')
    expect(getState, 'no refresh on a draft event').not.toHaveBeenCalled()

    // The ready-mark arrives as an ordinary event on c2: NOW the filing of c1
    // is announced, from the prev the mirror faithfully kept.
    act(() => { onChangedCb?.({ sessionId: SID, canvasId: 'c2', activeVersionId: 'v1' }) })
    expect(useCanvasStore.getState().bySessionId[SID].filedNotice).toMatchObject({ canvasId: 'c1' })
  })

  it('clears on demand and stays cleared', () => {
    useCanvasStore.getState().markUnseenRender(SID)
    useCanvasStore.getState().clearUnseenRender(SID)
    expect(useCanvasStore.getState().bySessionId[SID].unseenRender).toBe(false)
  })
})

describe('the Canvas button (pick B)', () => {
  async function render(): Promise<HTMLDivElement> {
    const container = document.createElement('div')
    document.body.appendChild(container)
    await act(async () => {
      createRoot(container).render(<AgentCanvasButton sessionId={SID} />)
    })
    return container
  }

  it('the attention dot is retired: even an unseen render draws no pulse', async () => {
    useExcalidrawStore.getState().setOpen(SID, false)
    useCanvasStore.getState().markUnseenRender(SID)
    const container = await render()
    expect(container.querySelector('[data-testid="canvas-attention-dot"]')).toBeNull()
    expect(container.textContent).toContain('Canvas')
  })

  /** The live mirror as the hydrated refresh would leave it. Seeded directly so
   *  the assertions do not race the mock's microtasks. */
  function seedAwaiting() {
    useCanvasStore.setState({
      bySessionId: {
        [SID]: {
          canvasId: 'c1', versions: [], activeVersionId: 'v1',
          interactionMode: 'browse', emptyView: 'intro', unseenRender: false, loaded: true,
          awaitingReview: { versionId: 'v1', at: '2026-08-23T10:00:00Z' },
        },
      },
    })
    useCanvasReviewStore.setState({
      bySessionId: {
        [SID]: {
          loaded: true, canvasId: 'c1', reviews: [], annotations: [],
          focus: null, focusChain: [], focusChainIndex: 0, marqueeArmed: false,
          editingAnnotationId: null, resolution: null, panelHighlight: null, helpDismissed: false,
        },
      },
    })
  }

  it('a ready-marked round turns the button into the state itself: "Review needed" + the count', async () => {
    seedAwaiting()
    const container = await render()
    const button = container.querySelector('[data-testid="canvas-button"]') as HTMLButtonElement
    expect(button.textContent).toContain('Review needed')
    expect(button.dataset.waiting).toBe('true')
    expect(container.querySelector('[data-testid="canvas-queue-count"]')?.textContent).toBe('1')
  })

  it('with nothing owed the button is furniture again: no count, no warning label', async () => {
    const container = await render()
    const button = container.querySelector('[data-testid="canvas-button"]') as HTMLButtonElement
    expect(button.textContent).toContain('Canvas')
    expect(button.textContent).not.toContain('Review needed')
    expect(container.querySelector('[data-testid="canvas-queue-count"]')).toBeNull()
  })

  it('clicking the count opens the queue list, not the pane', async () => {
    seedAwaiting()
    const container = await render()
    await act(async () => {
      ;(container.querySelector('[data-testid="canvas-queue-count"]') as HTMLElement).click()
    })
    expect(container.querySelector('[data-testid="canvas-queue-popover"]')).toBeTruthy()
    expect(useExcalidrawStore.getState().bySessionId[SID]?.isOpen ?? false).toBe(false)
  })
})
