// @vitest-environment jsdom
//
// The hand-back moment must be visible (owner expectation, 2026-08-13): when
// the agent renders while the Canvas pane is closed, the Canvas button pulses
// until the user opens it. Pins the store rule (closed pane → unseen; open
// pane → not news) and the button's attention state.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot } from 'react-dom/client'
import { act } from 'react'
import AgentCanvasButton from '../../../src/renderer/components/AgentCanvasButton'
import { setupCanvasListener, useCanvasStore } from '../../../src/renderer/stores/canvasStore'
import { useExcalidrawStore } from '../../../src/renderer/stores/excalidrawStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const SID = 'session-1'

// Capture the canvas:changed callback; reviewGetState/getState feed refresh.
let onChangedCb: ((e: { sessionId: string; canvasId: string; activeVersionId: string | null }) => void) | null = null
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    onChanged: (cb: typeof onChangedCb) => {
      onChangedCb = cb
      return () => {}
    },
    getState: vi.fn().mockResolvedValue(null),
  },
}

function fireChanged(): void {
  act(() => {
    onChangedCb?.({ sessionId: SID, canvasId: 'c1', activeVersionId: 'v1' })
  })
}

beforeEach(() => {
  useCanvasStore.getState().reset()
  // The excalidraw store has no full reset; drive the per-session flag directly.
  useExcalidrawStore.getState().setOpen(SID, false)
  setupCanvasListener() // idempotent; first call arms, later calls no-op
  expect(onChangedCb).toBeTruthy()
})

describe('unseen-render tracking', () => {
  it('marks a render that lands while the pane is closed, and only then', () => {
    fireChanged()
    expect(useCanvasStore.getState().bySessionId[SID].unseenRender).toBe(true)

    useCanvasStore.getState().clearUnseenRender(SID)
    useExcalidrawStore.getState().setOpen(SID, true)
    fireChanged()
    expect(useCanvasStore.getState().bySessionId[SID].unseenRender).toBe(false)
  })

  it('clears on demand and stays cleared', () => {
    useCanvasStore.getState().markUnseenRender(SID)
    useCanvasStore.getState().clearUnseenRender(SID)
    expect(useCanvasStore.getState().bySessionId[SID].unseenRender).toBe(false)
  })
})

describe('the Canvas button', () => {
  function render(): HTMLDivElement {
    const container = document.createElement('div')
    document.body.appendChild(container)
    act(() => {
      createRoot(container).render(<AgentCanvasButton sessionId={SID} />)
    })
    return container
  }

  it('pulses only while there is an unseen render and the pane is closed', () => {
    useExcalidrawStore.getState().setOpen(SID, false)
    useCanvasStore.getState().markUnseenRender(SID)
    const withDot = render()
    expect(withDot.querySelector('[data-testid="canvas-attention-dot"]')).toBeTruthy()
    expect(withDot.querySelector('button')?.title).toContain('rendered something new')

    useCanvasStore.getState().clearUnseenRender(SID)
    const withoutDot = render()
    expect(withoutDot.querySelector('[data-testid="canvas-attention-dot"]')).toBeNull()
  })

  it('shows no pulse when the pane is already open, even with the flag set', () => {
    useExcalidrawStore.getState().setOpen(SID, true)
    useCanvasStore.getState().markUnseenRender(SID)
    const container = render()
    expect(container.querySelector('[data-testid="canvas-attention-dot"]')).toBeNull()
  })
})
