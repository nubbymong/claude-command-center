// @vitest-environment jsdom
//
// The Agent Canvas empty state (owner feedback 2026-08-13): with nothing
// rendered, the pane must introduce the surface and put the first render one
// keypress away — not fall silently back to the old Draw pane. These pin the
// landing's contract: intro by default, starter prompt typed into the PTY
// WITHOUT a newline (the user confirms), and the classic sketchpad still one
// click away in both directions.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import CanvasEmptyState from '../../../src/renderer/components/CanvasEmptyState'
import { useCanvasStore } from '../../../src/renderer/stores/canvasStore'
import { useCanvasReviewStore } from '../../../src/renderer/stores/canvasReviewStore'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// The sketchpad view embeds the real ExcalidrawPane (heavy); the landing's own
// behaviour is what's under test.
vi.mock('../../../src/renderer/components/ExcalidrawPane', () => ({
  default: ({ sessionId }: { sessionId: string }) => <div data-testid="sketchpad">{sessionId}</div>,
}))

const ptyWriteMock = vi.fn()
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  pty: { ...((globalThis as any).window?.electronAPI?.pty ?? {}), write: ptyWriteMock },
}

const SID = 'session-1'
let container: HTMLDivElement
let root: Root

function render(): void {
  act(() => {
    root.render(<CanvasEmptyState sessionId={SID} onClose={() => {}} />)
  })
}

function click(el: Element | null): void {
  expect(el, 'expected element to click').toBeTruthy()
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function buttonByText(text: string): Element | null {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent?.includes(text)) ?? null
}

beforeEach(() => {
  ptyWriteMock.mockClear()
  useCanvasStore.getState().reset()
  useCanvasReviewStore.getState().reset()
  document.body.innerHTML = ''
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

describe('the landing (intro view)', () => {
  it('is the default, names the surface, and explains the loop and the controls', () => {
    render()
    expect(container.textContent).toContain('Agent Canvas')
    expect(container.textContent).toContain('nothing rendered yet')
    expect(container.textContent).toContain('The review loop')
    expect(container.textContent).toContain('Submit review')
    expect(container.textContent).toContain('canvas_render')
    // The classic pane is NOT mounted on the greeting.
    expect(container.querySelector('[data-testid="sketchpad"]')).toBeNull()
  })

  it('types the starter prompt into the terminal WITHOUT a newline', () => {
    render()
    click(buttonByText('Type it into the terminal'))
    expect(ptyWriteMock).toHaveBeenCalledTimes(1)
    const [sessionId, text] = ptyWriteMock.mock.calls[0]
    expect(sessionId).toBe(SID)
    expect(text).toContain('canvas_render')
    expect(text).toContain('data-ux-id')
    // The user presses Enter, not us — a trailing newline would SEND it.
    expect(text).not.toMatch(/[\r\n]/)
  })
})

describe('the sketchpad escape hatch (spec D2)', () => {
  it('is one click away, and one click back', () => {
    render()
    click(buttonByText('Sketchpad'))
    expect(container.querySelector('[data-testid="sketchpad"]')).toBeTruthy()
    expect(useCanvasStore.getState().bySessionId[SID].emptyView).toBe('sketchpad')

    click(buttonByText('Agent Canvas'))
    expect(container.querySelector('[data-testid="sketchpad"]')).toBeNull()
    expect(container.textContent).toContain('The review loop')
  })

  it('remembers the choice per session within the run', () => {
    useCanvasStore.getState().setEmptyView(SID, 'sketchpad')
    render()
    expect(container.querySelector('[data-testid="sketchpad"]')).toBeTruthy()
  })
})

describe('the notes-panel primer flag', () => {
  it('defaults to visible and dismisses per session', () => {
    expect(useCanvasReviewStore.getState().bySessionId[SID]?.helpDismissed ?? false).toBe(false)
    useCanvasReviewStore.getState().dismissHelp(SID)
    expect(useCanvasReviewStore.getState().bySessionId[SID].helpDismissed).toBe(true)
  })
})
