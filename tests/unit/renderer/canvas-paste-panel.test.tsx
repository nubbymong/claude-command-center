// @vitest-environment jsdom
//
// The Ctrl+V paste handler's TARGET GATING, exercised with real paste events
// (canvasPasteImage.test.ts covers the pure conversion util; this covers the
// panel's decision of WHEN to intercept a paste). The guard is `!inPanel &&
// editable` — a paste aimed at some other tile's editable is left alone, a
// paste anywhere else on the active pane is intercepted. Without this test,
// inverting that guard would pass every other test.
//
// jsdom has no createImageBitmap, so an intercepted image paste fails to decode
// and surfaces the composer paste-error — which is exactly the branch we want
// to observe to prove the paste WAS intercepted.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import CanvasNotesPanel from '../../../src/renderer/components/CanvasNotesPanel'
import type { CanvasReviewState, CanvasVersion, Review, Annotation } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
vi.mock('@excalidraw/excalidraw', () => ({ exportToBlob: vi.fn() }))

const { useCanvasReviewStore } = await import('../../../src/renderer/stores/canvasReviewStore')

const SID = 'session-1'
const V2 = { id: 'v2', mode: 'design', createdAt: '2026-08-23T10:00:00Z', source: { mode: 'design', entry: 'index.html' } } as CanvasVersion
const REVIEW: Review = {
  id: 'R1',
  canvas: { canvasId: 'canvas-1', versionId: 'v1' } as Review['canvas'],
  versionId: 'v1',
  annotationIds: ['a1'],
  status: 'submitted',
  createdAt: '2026-08-23T09:00:00Z',
  submittedAt: '2026-08-23T09:05:00Z',
}
const NOTE: Annotation = { id: 'a1', reviewId: 'R1', scope: 'general', note: 'x', versionId: 'v1', state: 'open' }
const STATE: CanvasReviewState = { canvasId: 'canvas-1', sessionId: SID, reviews: [REVIEW], annotations: [NOTE] }

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  pty: { ...((globalThis as any).window?.electronAPI?.pty ?? {}), write: vi.fn() },
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    reviewGetState: vi.fn(async () => STATE),
    annotationResolve: vi.fn(async () => ({ state: STATE })),
    reviewMarkSeen: vi.fn(async () => STATE),
  },
}

/** A clipboard carrying one image file, shaped as imageFileFromClipboard reads it. */
function imageClipboard(): DataTransfer {
  const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' })
  return { items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }] } as unknown as DataTransfer
}
function textClipboard(): DataTransfer {
  return { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }] } as unknown as DataTransfer
}

/** Dispatch a paste at `target` with the given clipboard; returns the event so
 *  the caller can read defaultPrevented. Awaits the handler's async work. */
async function paste(target: EventTarget, data: DataTransfer): Promise<Event> {
  const ev = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'clipboardData', { value: data, configurable: true })
  await act(async () => {
    target.dispatchEvent(ev)
    // let the handler's `void (async () => …)()` settle
    await Promise.resolve()
    await Promise.resolve()
  })
  return ev
}

let container: HTMLDivElement
let root: Root

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <CanvasNotesPanel sessionId={SID} version={V2} getGlassApi={() => null} onReturnToTerminal={() => {}} isActive />,
    )
  })
}

beforeEach(() => {
  useCanvasReviewStore.getState().reset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('Ctrl+V target gating', () => {
  it('intercepts an image paste on a non-editable pane target (and surfaces the decode error)', async () => {
    await render()
    // A non-editable spot inside the document but not another tile's field.
    const ev = await paste(document.body, imageClipboard())
    expect(ev.defaultPrevented).toBe(true)
    // jsdom cannot decode, so the intercept ends in the composer paste-error —
    // proof the paste was taken, not passed through.
    expect(container.querySelector('[data-testid="composer-paste-error"]')).not.toBeNull()
  })

  it('leaves a paste aimed at ANOTHER tile’s editable alone', async () => {
    await render()
    // A foreign editable: a text field that is not inside this panel.
    const foreign = document.createElement('input')
    document.body.appendChild(foreign)
    const ev = await paste(foreign, imageClipboard())
    expect(ev.defaultPrevented).toBe(false)
    expect(container.querySelector('[data-testid="composer-paste-error"]')).toBeNull()
    foreign.remove()
  })

  it('ignores a paste with no image (leaves the textarea to handle text)', async () => {
    await render()
    const ev = await paste(document.body, textClipboard())
    expect(ev.defaultPrevented).toBe(false)
    expect(container.querySelector('[data-testid="composer-paste-error"]')).toBeNull()
  })

  it('does nothing at all while the pane is inactive', async () => {
    await act(async () => {
      root.render(
        <CanvasNotesPanel sessionId={SID} version={V2} getGlassApi={() => null} onReturnToTerminal={() => {}} isActive={false} />,
      )
    })
    const ev = await paste(document.body, imageClipboard())
    expect(ev.defaultPrevented).toBe(false)
    expect(container.querySelector('[data-testid="composer-paste-error"]')).toBeNull()
  })
})
