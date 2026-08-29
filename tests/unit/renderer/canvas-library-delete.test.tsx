// @vitest-environment jsdom
//
// The canvas library's row actions, after the settled machine removed the
// per-row "Close notes" bulk (W6).
//
// What is left on a row is DELETE, and delete is the one destructive canvas
// operation there is — so the whole surface of this file is the two-step arm
// and its double-click proofing (#456). Bulk-clearing a canvas's rounds from a
// list, where none of the notes are on screen and nothing states what will be
// closed, was the shape that let "settled" mean six different things; the one
// exit that remains is Mark complete in the pane, which names each closure
// before the user commits.
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

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    listAll: vi.fn(async () => entries),
    deleteCanvas: vi.fn(async () => ({ ok: true })),
    reclaim: vi.fn(async () => ({ ok: true, state: null })),
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
  entries = [entry({ liveRoundCount: 1, openReviewCount: 1, phase: 'with-agent' })]
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  nowSpy?.mockRestore()
  nowSpy = null
})

// #456: a freshly-armed confirm ignores activation for CONFIRM_GUARD_MS so a
// double-click cannot arm and fire in one gesture. Deliberate confirms jump a
// mocked clock past the window instead of really waiting.
let nowSpy: ReturnType<typeof vi.spyOn> | null = null
function passGuard(): void {
  const later = Date.now() + 60_000
  nowSpy?.mockRestore()
  nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => later)
}

describe('the row no longer offers a bulk close-out', () => {
  it('shows no "Close notes" control, whatever the row reports as outstanding', async () => {
    await render()
    expect(byTestId('canvas-library-close')).toBeNull()
    expect(byTestId('canvas-library-close-confirm')).toBeNull()
    expect((window as any).electronAPI.canvas.reviewCloseOut).toBeUndefined()
  })
})

describe('delete is two-step and double-click-proof (#456)', () => {
  it('a double-click cannot arm and fire delete in one gesture', async () => {
    await render()
    const deleteCanvas = (window as any).electronAPI.canvas.deleteCanvas
    deleteCanvas.mockClear()
    await click(byTestId('canvas-library-delete'))
    await click(byTestId('canvas-library-confirm-delete'))
    expect(deleteCanvas).not.toHaveBeenCalled()
    // Still armed — the delete waits for a deliberate second decision.
    expect(byTestId('canvas-library-confirm-delete')).toBeTruthy()

    passGuard()
    await click(byTestId('canvas-library-confirm-delete'))
    expect(deleteCanvas).toHaveBeenCalledTimes(1)
  })

  it('arming moves focus onto the confirm', async () => {
    await render()
    await click(byTestId('canvas-library-delete'))
    expect(document.activeElement).toBe(byTestId('canvas-library-confirm-delete'))
  })
})
