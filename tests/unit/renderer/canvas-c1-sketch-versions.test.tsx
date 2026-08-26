// @vitest-environment jsdom
//
// C1 version-stamped sketches (owner bug report 2026-08-26): a glass element
// belongs to the version on screen when it first appeared. Switching versions
// lifts foreign elements into the stash (updateScene without them), returning
// restores them, and the submit union hands the panel BOTH — so a v1 sketch
// still exports while v2 is displayed.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { CanvasState } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

type El = { id: string; isDeleted?: boolean }
let sceneElements: El[] = []
const updateScene = vi.fn((args: { elements: El[] }) => { sceneElements = [...args.elements] })
let capturedOnChange: ((els: El[]) => void) | null = null
const fakeApi = {
  getSceneElements: () => sceneElements,
  updateScene,
  getAppState: () => ({ selectedElementIds: {} }),
  getFiles: () => ({}),
  updateLibrary: vi.fn(),
  setActiveTool: vi.fn(),
  refresh: vi.fn(),
  onScrollChange: vi.fn(),
  getSceneElementsIncludingDeleted: () => sceneElements,
}

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: (props: { excalidrawAPI?: (api: unknown) => void; onChange?: (els: El[]) => void }) => {
    props.excalidrawAPI?.(fakeApi)
    capturedOnChange = props.onChange ?? null
    return null
  },
  exportToBlob: vi.fn(),
  sceneCoordsToViewportCoords: () => ({ x: 0, y: 0 }),
  viewportCoordsToSceneCoords: () => ({ x: 0, y: 0 }),
}))

// Capture what the pane hands the panel — the union accessor is the contract.
let panelProps: { getAllSketchElements?: () => El[] } | null = null
vi.mock('../../../src/renderer/components/CanvasNotesPanel', () => ({
  default: (props: { getAllSketchElements?: () => El[] }) => {
    panelProps = props
    return null
  },
}))
vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn(async () => true) }))
vi.mock('../../../src/renderer/canvas/canvas-frame-rpc', () => ({
  askCanvasFrame: vi.fn(() => new Promise(() => {})),
  framesInFlight: () => 0,
  MAX_FRAME_REQUESTS_IN_FLIGHT: 4,
}))
vi.mock('../../../src/renderer/canvas/canvas-inbound-channel', () => ({
  createCanvasInboundChannel: vi.fn(() => vi.fn()),
  INBOUND_FLOOD_BUDGET: 600,
  INBOUND_FLOOD_WINDOW_MS: 1000,
  reportedKeyIsPlausible: () => true,
  reportedClickIsPlausible: () => true,
}))

const AgentCanvasPane = (await import('../../../src/renderer/components/AgentCanvasPane')).default
const { useCanvasStore } = await import('../../../src/renderer/stores/canvasStore')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')

const SID = 'session-1'
const v = (id: string) => ({ id, mode: 'design' as const, createdAt: `2026-08-26T10:0${id.slice(1)}:00Z`, source: { mode: 'design' as const, entry: 'index.html' } })
const STATE: CanvasState = {
  canvasId: 'canvas-1',
  sessionId: SID,
  activeVersionId: 'v1',
  versions: [v('v1'), v('v2')],
} as CanvasState

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    getState: vi.fn(async () => STATE),
    reviewGetState: vi.fn(async () => null),
    listReclaimable: vi.fn(async () => []),
    onChanged: vi.fn(() => () => {}),
    onReviewChanged: vi.fn(() => () => {}),
    onSnapshotRequest: vi.fn(() => () => {}),
  },
}

let container: HTMLDivElement
let root: Root

function seed(activeVersionId: string) {
  useCanvasStore.setState({
    bySessionId: {
      [SID]: {
        canvasId: STATE.canvasId,
        versions: STATE.versions,
        activeVersionId,
        interactionMode: 'browse',
        emptyView: 'intro',
        unseenRender: false,
        loaded: true,
      },
    },
  })
}

beforeEach(() => {
  sceneElements = []
  updateScene.mockClear()
  panelProps = null
  capturedOnChange = null
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  seed('v1')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function render(): Promise<void> {
  await act(async () => {
    root.render(<AgentCanvasPane sessionId={SID} isActive />)
  })
}

describe('the sketch stash', () => {
  it('lifts a v1 element out of the scene on switch to v2, restores it on return, and the submit union always carries it', async () => {
    await render()
    // The user draws e1 while v1 is displayed — stamped v1 via onChange.
    sceneElements = [{ id: 'e1' }]
    await act(async () => { capturedOnChange?.([{ id: 'e1' }]) })

    // Switch the displayed version: e1 must leave the live scene...
    await act(async () => { seed('v2') })
    const lastScene = updateScene.mock.calls[updateScene.mock.calls.length - 1]?.[0]?.elements ?? []
    expect(lastScene.some((el: El) => el.id === 'e1')).toBe(false)
    // ...but the union the submit path reads still holds it.
    expect(panelProps?.getAllSketchElements?.()?.some((el) => el.id === 'e1')).toBe(true)

    // Return to v1: restored into the live scene.
    await act(async () => { seed('v1') })
    const restored = updateScene.mock.calls[updateScene.mock.calls.length - 1]?.[0]?.elements ?? []
    expect(restored.some((el: El) => el.id === 'e1')).toBe(true)
  })
})
