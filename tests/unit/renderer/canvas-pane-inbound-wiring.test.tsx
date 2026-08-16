// @vitest-environment jsdom
//
// The pane must listen through the GATED channel, not with a raw window
// listener of its own. That distinction is the whole of the 2026-08-14 finding:
// the ungated listener honoured a forged `contentKey` (clearing a locked focus
// mid-note) and a forged `contentClick` (locking a focus of the page's
// choosing), and it issued one unbounded RPC per inbound message.
//
// So this renders the real pane and checks what it ARMS and TEARS DOWN — a
// revert to a hand-rolled listener fails here even though the channel's own
// tests would stay green.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { CanvasState } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

// The real Excalidraw dev ESM does not load under raw Node, and the glass is
// not what is under test here.
vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: () => null,
  exportToBlob: vi.fn(),
  sceneCoordsToViewportCoords: () => ({ x: 0, y: 0 }),
  viewportCoordsToSceneCoords: () => ({ x: 0, y: 0 }),
}))
vi.mock('../../../src/renderer/components/CanvasNotesPanel', () => ({ default: () => null }))

// A frame that never answers: what an inspect looks like while it is still in
// flight, which is when a second click must NOT open a second one.
const askFrame = vi.fn(() => new Promise(() => {}))
vi.mock('../../../src/renderer/canvas/canvas-frame-rpc', () => ({
  askCanvasFrame: (...args: unknown[]) => askFrame(...(args as [])),
  framesInFlight: () => 0,
  MAX_FRAME_REQUESTS_IN_FLIGHT: 4,
}))

const disposeChannel = vi.fn()
const createChannel = vi.fn(() => disposeChannel)
vi.mock('../../../src/renderer/canvas/canvas-inbound-channel', () => ({
  createCanvasInboundChannel: createChannel,
  INBOUND_FLOOD_BUDGET: 600,
  INBOUND_FLOOD_WINDOW_MS: 1000,
  reportedKeyIsPlausible: () => true,
  reportedClickIsPlausible: () => true,
}))

const AgentCanvasPane = (await import('../../../src/renderer/components/AgentCanvasPane')).default
const { useCanvasStore } = await import('../../../src/renderer/stores/canvasStore')
const { useCanvasReviewStore } = await import('../../../src/renderer/stores/canvasReviewStore')

const SID = 'session-1'
const STATE: CanvasState = {
  canvasId: 'canvas-1',
  sessionId: SID,
  activeVersionId: 'v1',
  versions: [{ id: 'v1', mode: 'design', createdAt: '2026-08-14T10:00:00Z', source: { mode: 'design', entry: 'index.html' } }],
} as CanvasState

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  pty: { ...((globalThis as any).window?.electronAPI?.pty ?? {}), write: vi.fn() },
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    getState: vi.fn(async () => STATE),
    reviewGetState: vi.fn(async () => null),
    listReclaimable: vi.fn(async () => []),
  },
}

let container: HTMLDivElement
let root: Root

beforeEach(async () => {
  createChannel.mockClear()
  disposeChannel.mockClear()
  askFrame.mockClear()
  useCanvasStore.getState().reset()
  useCanvasReviewStore.getState().reset()
  // Seeded synchronously: with an unhydrated store the pane renders its empty
  // state on the first pass and there is no frame to arm a channel for.
  useCanvasStore.setState({
    bySessionId: {
      [SID]: {
        canvasId: STATE.canvasId,
        versions: STATE.versions,
        activeVersionId: STATE.activeVersionId,
        interactionMode: 'browse',
        emptyView: 'intro',
        unseenRender: false,
        loaded: true,
      },
    },
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<AgentCanvasPane sessionId={SID} />)
  })
})

afterEach(() => {
  container.remove()
})

describe('the pane listens to the frame through the gated channel', () => {
  it('arms exactly one channel, pointed at its own iframe element and window', async () => {
    expect(createChannel).toHaveBeenCalledTimes(1)
    const options = createChannel.mock.calls[0][0] as {
      canvasId: string
      getFrameWindow: () => Window | null
      getFrameElement: () => Element | null
    }
    expect(options.canvasId).toBe('canvas-1')
    const iframe = container.querySelector('iframe')
    expect(iframe).toBeTruthy()
    // The element the focus gate reads, and the window the origin check reads,
    // are this pane's own frame — not a captured stale one.
    expect(options.getFrameElement()).toBe(iframe)
    expect(options.getFrameWindow()).toBe(iframe!.contentWindow)
    await act(async () => root.unmount())
  })

  it('disposes the channel when the pane goes away', async () => {
    await act(async () => root.unmount())
    expect(disposeChannel).toHaveBeenCalledTimes(1)
  })

  it('keeps ONE inspect in flight however many clicks are reported', async () => {
    const options = createChannel.mock.calls[0][0] as { handlers: { onContentClick: (x: number, y: number) => void } }
    await act(async () => {
      for (let i = 0; i < 20; i++) options.handlers.onContentClick(i, i)
    })
    expect(askFrame).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
  })

  it('tells the user when the page floods the bridge, instead of going quiet', async () => {
    const options = createChannel.mock.calls[0][0] as { handlers: { onFlood: () => void } }
    await act(async () => {
      options.handlers.onFlood()
    })
    expect(container.textContent).toContain('flooded the canvas bridge')
    await act(async () => root.unmount())
  })
})

// ── The frame's own ceiling (adversarial review, 2026-08-15) ─────────────────
// The off-screen capture frame has delegated nothing since the headless path
// landed; the VISIBLE frame — same untrusted documents, same origin scheme — had
// no `allow` at all, so it inherited the default policy for every powerful
// feature the host document is permitted.
describe('the visible content frame delegates no permissions', () => {
  it('carries an empty allow list, like the off-screen capture frame', async () => {
    const iframe = container.querySelector('iframe')
    expect(iframe).toBeTruthy()
    expect(iframe!.getAttribute('allow')).toBe('')
    // …and the sandbox it has always had is untouched.
    expect(iframe!.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms')
    await act(async () => root.unmount())
  })
})

// ── Whose voice the readout is in (adversarial review, 2026-08-15) ───────────
// role/name/tag/uxId in the hover chip are the frame's `pointer` report about
// ITSELF. Every other page-authored identity in the pane is marked — the locked
// label, the notes-panel labels, the resolution checklist — and this one, the
// readout a reviewer actually reads while hunting for an element, printed the
// artifact's account of itself in the app's own voice.
describe('the hover readout is marked as the page’s own account of itself', () => {
  async function hoverOverSaveButton(): Promise<HTMLElement> {
    const options = createChannel.mock.calls[0][0] as {
      handlers: {
        onViewport: (vp: { scrollX: number; scrollY: number; width: number; height: number; dpr: number; scale: number }) => void
        onPointer: (hit: { role: string; name: string; tag: string; uxId?: string; box: { x: number; y: number; width: number; height: number } } | null) => void
      }
    }
    await act(async () => {
      // A viewport first: without one there is no stage rect and no chip.
      options.handlers.onViewport({ scrollX: 0, scrollY: 0, width: 800, height: 600, dpr: 1, scale: 1 })
      options.handlers.onPointer({ role: 'button', name: 'Save', tag: 'button', uxId: 'save-button', box: { x: 10, y: 40, width: 60, height: 20 } })
    })
    // The innermost div carrying the label — the chip itself, not the overlay
    // layers around it (querySelectorAll is document order, so the last match in
    // the chain is the deepest).
    const carriers = Array.from(container.querySelectorAll('div')).filter((el) =>
      el.textContent?.includes('button "Save"'),
    )
    const chip = carriers[carriers.length - 1]
    expect(chip, 'the hover readout chip').toBeTruthy()
    expect(chip.querySelector('div'), 'the chip has no nested div — it IS the chip').toBeNull()
    return chip
  }

  it('prints the marker in front of the identity the page reported', async () => {
    const chip = await hoverOverSaveButton()
    expect(chip.textContent).toContain('page-reported')
    expect(chip.textContent).toContain('button "Save"')
    await act(async () => root.unmount())
  })

  it('carries the attribution as a tooltip, like every other page-authored label', async () => {
    const chip = await hoverOverSaveButton()
    expect(chip.getAttribute('title')).toMatch(/cannot verify/i)
    await act(async () => root.unmount())
  })
})
