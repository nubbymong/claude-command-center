// @vitest-environment jsdom
//
// The three x-ray hover modes as the PANE actually behaves (#367).
//
// Off is the mode the owner asked for — "so I can view it as a normal browser"
// — and it is the one with two halves that can drift apart: the frame is asked
// to stop reporting, and the host ignores reports if it hears them anyway. The
// second half is the one that matters (the bridge shares a realm with the page
// and may ignore anything), so every mode here is driven through the channel
// handlers, exactly as a real frame would drive them, rather than by asserting
// that a request was sent.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { CanvasState } from '../../../src/shared/canvas'
import type { CanvasXrayMode } from '../../../src/renderer/canvas/xray-mode'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: () => null,
  exportToBlob: vi.fn(),
  sceneCoordsToViewportCoords: () => ({ x: 0, y: 0 }),
  viewportCoordsToSceneCoords: () => ({ x: 0, y: 0 }),
}))
// The notes panel is not under test, and this change deliberately does not
// touch it — the readout is its sibling.
vi.mock('../../../src/renderer/components/CanvasNotesPanel', () => ({ default: () => null }))
// No disk, no IPC: the settings store is REAL (the mode is a real per-user
// preference and the round-trip through it is part of what is under test).
vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn(async () => true) }))

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
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { resolveCanvasXrayMode } = await import('../../../src/renderer/canvas/xray-mode')

const SID = 'session-1'
const STATE: CanvasState = {
  canvasId: 'canvas-1',
  sessionId: SID,
  activeVersionId: 'v1',
  versions: [{ id: 'v1', mode: 'design', createdAt: '2026-08-14T10:00:00Z', source: { mode: 'design', entry: 'index.html' } }],
} as CanvasState

const SAVE_BUTTON = {
  role: 'button',
  name: 'Save',
  tag: 'button',
  uxId: 'save-button',
  box: { x: 10, y: 40, width: 60, height: 20 },
}
const VIEWPORT = { scrollX: 0, scrollY: 0, width: 800, height: 600, dpr: 1, scale: 1 }

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

interface Handlers {
  onReady: () => void
  onViewport: (vp: typeof VIEWPORT) => void
  onPointer: (hit: typeof SAVE_BUTTON | null) => void
  onContentClick: (x: number, y: number) => void
}

let container: HTMLDivElement
let root: Root

function handlers(): Handlers {
  return (createChannel.mock.calls[0][0] as { handlers: Handlers }).handlers
}

/** What the frame would do: report where the page is, then a hover on Save. */
async function hoverSaveButton(): Promise<void> {
  await act(async () => {
    handlers().onViewport(VIEWPORT)
    handlers().onPointer(SAVE_BUTTON)
  })
}

function overlay(): HTMLElement {
  const el = container.querySelector('[data-canvas-layer="overlay"]')
  expect(el, 'the stage overlay layer').toBeTruthy()
  return el as HTMLElement
}

function readout(): HTMLElement | null {
  return container.querySelector('[data-testid="canvas-xray-readout"]')
}

/** The hoverReporting requests the pane has sent to the frame, in order. */
function hoverReportingCalls(): boolean[] {
  return askFrame.mock.calls
    .map((c) => (c as unknown as unknown[])[2] as { type?: string; enabled?: boolean })
    .filter((p) => p?.type === 'hoverReporting')
    .map((p) => p.enabled as boolean)
}

async function renderPane(mode?: CanvasXrayMode): Promise<void> {
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, canvasXrayMode: mode } })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(<AgentCanvasPane sessionId={SID} />)
  })
}

beforeEach(() => {
  createChannel.mockClear()
  disposeChannel.mockClear()
  askFrame.mockClear()
  useCanvasStore.getState().reset()
  useCanvasReviewStore.getState().reset()
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
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('x-ray ON — what shipped', () => {
  it('is the default when nothing was ever chosen', async () => {
    await renderPane(undefined)
    expect(resolveCanvasXrayMode(useSettingsStore.getState().settings.canvasXrayMode)).toBe('on')
  })

  it('outlines and labels the hovered element on the page', async () => {
    await renderPane('on')
    await hoverSaveButton()
    expect(overlay().textContent).toContain('button "Save"')
    expect(overlay().querySelectorAll('.border-blue').length).toBe(1)
  })

  it('shows nothing in the side panel — the readout belongs to stealth', async () => {
    await renderPane('on')
    await hoverSaveButton()
    expect(readout()).toBeNull()
  })

  it('costs the frame no round-trip: the bridge already reports by default', async () => {
    await renderPane('on')
    await act(async () => handlers().onReady())
    expect(hoverReportingCalls()).toEqual([])
  })
})

describe('x-ray STEALTH — resolved, but nothing drawn on the page', () => {
  it('draws no outline and no label chip over the content', async () => {
    await renderPane('stealth')
    await hoverSaveButton()
    expect(overlay().textContent).not.toContain('button "Save"')
    expect(overlay().querySelectorAll('.border-blue').length).toBe(0)
  })

  it('names the hovered element in the side panel instead', async () => {
    await renderPane('stealth')
    await hoverSaveButton()
    const panel = readout()
    expect(panel, 'the stealth readout').toBeTruthy()
    expect(panel!.textContent).toContain('button "Save"')
    expect(panel!.textContent).toContain('save-button')
  })

  it('states the box in numbers rather than painting it', async () => {
    await renderPane('stealth')
    await hoverSaveButton()
    expect(container.querySelector('[data-testid="canvas-xray-box"]')?.textContent).toContain('60 × 20')
    expect(container.querySelector('[data-testid="canvas-xray-box"]')?.textContent).toContain('10, 40')
  })

  it('still marks the identity as the page’s own account of itself', async () => {
    // Moving the readout off the page does not make the page a more reliable
    // narrator of it — the same attribution the on-page chip carries.
    await renderPane('stealth')
    await hoverSaveButton()
    const label = container.querySelector('[data-testid="canvas-xray-label"]')
    expect(label?.textContent).toContain('page-reported')
    expect(label?.getAttribute('title')).toMatch(/cannot verify/i)
  })

  it('empties the readout when the pointer leaves the page', async () => {
    await renderPane('stealth')
    await hoverSaveButton()
    await act(async () => handlers().onPointer(null))
    expect(readout()!.textContent).not.toContain('button "Save"')
    expect(readout()!.textContent).toContain('Hover the page')
  })

  it('keeps the frame reporting — stealth still needs the hit', async () => {
    await renderPane('stealth')
    await act(async () => handlers().onReady())
    expect(hoverReportingCalls()).toEqual([])
  })

  it('still selects on click', async () => {
    await renderPane('stealth')
    await act(async () => handlers().onContentClick(12, 44))
    expect(askFrame).toHaveBeenCalledTimes(1)
    expect((askFrame.mock.calls[0] as unknown as unknown[])[2]).toMatchObject({ type: 'inspect' })
  })
})

describe('x-ray OFF — the page behaves like a normal browser tab', () => {
  it('draws nothing on the page for a hover the frame reports anyway', async () => {
    // The frame is asked to stop reporting, but the bridge is page-controlled
    // code: this is the host refusing a report it did not want.
    await renderPane('off')
    await hoverSaveButton()
    expect(overlay().textContent).not.toContain('button "Save"')
    expect(overlay().querySelectorAll('.border-blue').length).toBe(0)
  })

  it('shows nothing in the side panel either', async () => {
    await renderPane('off')
    await hoverSaveButton()
    expect(readout()).toBeNull()
  })

  it('selects nothing on click — no inspect is issued at all', async () => {
    await renderPane('off')
    await act(async () => {
      handlers().onViewport(VIEWPORT)
      for (let i = 0; i < 5; i++) handlers().onContentClick(12, 44)
    })
    expect(askFrame.mock.calls.filter((c) => ((c as unknown as unknown[])[2] as { type?: string })?.type === 'inspect')).toEqual([])
    expect(useCanvasReviewStore.getState().bySessionId[SID]?.focus ?? null).toBeNull()
  })

  it('tells the frame to stop reporting once it is ready', async () => {
    await renderPane('off')
    await act(async () => handlers().onReady())
    expect(hoverReportingCalls()).toEqual([false])
  })

  it('says in the mode strip that hovering and clicking do nothing', async () => {
    await renderPane('off')
    expect(container.textContent).toContain('x-ray is off')
  })
})

describe('the header switch', () => {
  it('offers exactly three segments, with the current one pressed', async () => {
    await renderPane('stealth')
    const group = container.querySelector('[data-testid="canvas-xray-mode"]')!
    const buttons = Array.from(group.querySelectorAll('button'))
    expect(buttons.map((b) => b.textContent)).toEqual(['Off', 'Stealth', 'On'])
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'true', 'false'])
  })

  it('switches mode in one click, and the choice is written to the user’s settings', async () => {
    await renderPane('on')
    await hoverSaveButton()
    expect(overlay().textContent).toContain('button "Save"')

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="canvas-xray-off"]')!.click()
    })
    // Per user, not per canvas: the value lands in the settings store.
    expect(useSettingsStore.getState().settings.canvasXrayMode).toBe('off')
    // …and what was already on screen is dropped, not left painted over a page
    // the user just asked to see plainly.
    expect(overlay().textContent).not.toContain('button "Save"')
  })

  it('round-trips off → stealth → on, telling the frame only when that changes', async () => {
    await renderPane('on')
    await act(async () => handlers().onReady())

    const click = async (mode: CanvasXrayMode) => {
      await act(async () => {
        container.querySelector<HTMLButtonElement>(`[data-testid="canvas-xray-${mode}"]`)!.click()
      })
      expect(useSettingsStore.getState().settings.canvasXrayMode).toBe(mode)
    }

    await click('off')
    await click('stealth')
    await click('on')
    await click('off')
    // on(default, silent) → off → stealth(live again) → on(no change) → off.
    expect(hoverReportingCalls()).toEqual([false, true, false])
  })
})
