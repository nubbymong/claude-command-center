// @vitest-environment jsdom
//
// The pane's chrome, as the M2 rework leaves it (W17-W24).
//
// The subject of most of this file is ONE bug with several doors into it: the
// glass could take the pointer and never give it back. Sketch was a setter, not
// a toggle, and the interaction mode is per-session state that outlives the
// pane — so a reviewer who drew one mark on a tall mockup found that neither
// the wheel nor the page's own scrollbar did anything for the rest of the
// session, with nothing on screen naming the reason. Everything here is driven
// through the real store and the real DOM the pane renders; the Excalidraw
// glass is a stub that records the props it was handed, because what matters is
// which layer owns the pointer, not what Excalidraw paints.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CanvasState } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

type El = { id: string; isDeleted?: boolean }
let sceneElements: El[] = []
// The pane also calls updateScene with only an appState (the glass repin), so
// the elements are replaced only when it actually sent some.
const updateScene = vi.fn((args: { elements?: El[] }) => {
  if (args?.elements) sceneElements = [...args.elements]
})
let capturedOnChange: ((els: El[]) => void) | null = null
/** What the pane asked of the glass this render — zen mode, view mode, the
 *  item defaults. The props ARE the contract for W18. */
let glassProps: Record<string, unknown> = {}
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

/**
 * Excalidraw's own normaliser, standing in for the real one: it drops what it
 * cannot repair and returns elements. What is under test here is the PANE's
 * contract around it — the count cap, the drop, and the promise that a
 * malformed scene is never fatal — not Excalidraw's repair rules. `throws`
 * makes it fail the way a normaliser meeting a hostile element would.
 */
const restoreElements = vi.fn((els: unknown) =>
  (els as El[]).filter((el) => !!el && typeof el === 'object' && typeof el.id === 'string' && el.id !== 'MALFORMED'),
)

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: (props: Record<string, unknown>) => {
    glassProps = props
    ;(props.excalidrawAPI as ((api: unknown) => void) | undefined)?.(fakeApi)
    capturedOnChange = (props.onChange as ((els: El[]) => void) | undefined) ?? null
    return null
  },
  restoreElements: (...args: unknown[]) => restoreElements(...(args as [unknown])),
  exportToBlob: vi.fn(),
  sceneCoordsToViewportCoords: () => ({ x: 0, y: 0 }),
  viewportCoordsToSceneCoords: () => ({ x: 0, y: 0 }),
}))

/** The four sketch props the panel consumes (M2 shared contract) — captured
 *  here so this file can exercise the PANE's half while the panel's half is
 *  still in flight. */
interface SketchSeam {
  canvasId?: string
  sketchRevision?: number
  getAllSketchElements?: () => El[]
  getUnattachedSketchElementIds?: () => string[]
  markSketchElementsAttached?: (ids: string[]) => void
  getSketchSceneForPersist?: () => { scene: string; versions: Record<string, string> } | null
  restoreSketchScene?: (s: { scene: string; versions: Record<string, string> }) => boolean
}
let panelProps: SketchSeam | null = null
vi.mock('../../../src/renderer/components/CanvasNotesPanel', () => ({
  default: (props: SketchSeam) => {
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
/** The bridge's handlers, so a test can report a viewport the way a real frame
 *  does — the Region chip is disabled until the page says how big it is. */
interface ChannelHandlers {
  onReady: () => void
  onViewport: (vp: { scrollX: number; scrollY: number; width: number; height: number; dpr: number; scale: number }) => void
}
const createChannel = vi.fn(() => vi.fn())
vi.mock('../../../src/renderer/canvas/canvas-inbound-channel', () => ({
  createCanvasInboundChannel: (...args: unknown[]) => createChannel(...(args as [])),
  INBOUND_FLOOD_BUDGET: 600,
  INBOUND_FLOOD_WINDOW_MS: 1000,
  reportedKeyIsPlausible: () => true,
  reportedClickIsPlausible: () => true,
}))

const AgentCanvasPane = (await import('../../../src/renderer/components/AgentCanvasPane')).default
const { useCanvasStore } = await import('../../../src/renderer/stores/canvasStore')
const { useCanvasReviewStore } = await import('../../../src/renderer/stores/canvasReviewStore')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')

const SID = 'session-1'
const CANVAS = 'canvas-1'
const v = (id: string) => ({
  id,
  mode: 'design' as const,
  createdAt: `2026-08-29T10:0${id.slice(1)}:00Z`,
  source: { mode: 'design' as const, entry: 'index.html' },
})
const STATE: CanvasState = {
  canvasId: CANVAS,
  sessionId: SID,
  activeVersionId: 'v1',
  versions: [v('v1'), v('v2')],
} as CanvasState

/** Which version the pane is showing. The pane refreshes from main on mount,
 *  so a seeded store alone is overwritten — main has to agree. */
let activeVersionId = 'v1'

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    getState: vi.fn(async () => ({ ...STATE, activeVersionId })),
    reviewGetState: vi.fn(async () => null),
    listReclaimable: vi.fn(async () => []),
    // M3: the pane subscribes to main’s full-document navigation push for
    // the action trail, so every mount of it needs the listener to exist.
    onFrameNavigated: vi.fn(() => () => {}),
    onChanged: vi.fn(() => () => {}),
    onReviewChanged: vi.fn(() => () => {}),
    onSnapshotRequest: vi.fn(() => () => {}),
  },
}

let container: HTMLDivElement
let root: Root

function seed(showing = 'v1'): void {
  activeVersionId = showing
  useCanvasStore.setState({
    bySessionId: {
      [SID]: {
        canvasId: CANVAS,
        versions: STATE.versions,
        activeVersionId: showing,
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
  glassProps = {}
  createChannel.mockClear()
  restoreElements.mockClear()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  useCanvasStore.setState({ sketchByCanvasId: {} })
  useCanvasReviewStore.setState({ bySessionId: {} })
  seed()
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

/** Let one animation frame pass — the throttle the glass-change bump uses. */
async function frame(): Promise<void> {
  await new Promise<void>((r) => requestAnimationFrame(() => r()))
}

/** What a live frame does first: say where the page is. Region stays disabled
 *  until it has, because a rectangle needs a coordinate space. */
async function reportViewport(): Promise<void> {
  const handlers = (createChannel.mock.calls[createChannel.mock.calls.length - 1]?.[0] as { handlers: ChannelHandlers }).handlers
  await act(async () => {
    handlers.onViewport({ scrollX: 0, scrollY: 0, width: 800, height: 600, dpr: 1, scale: 1 })
  })
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`)
}
function glass(): HTMLElement {
  const el = container.querySelector('[data-canvas-layer="glass"]')
  expect(el, 'the glass layer').toBeTruthy()
  return el as HTMLElement
}
async function click(el: Element | null): Promise<void> {
  expect(el).toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const STYLES = readFileSync(resolve(__dirname, '../../../src/renderer/styles.css'), 'utf8')

describe('Sketch gives the pointer back (W17)', () => {
  it('takes the pointer on the first press and returns it on the second', async () => {
    await render()
    expect(glass().style.pointerEvents).toBe('none')

    await click(byTestId('canvas-tool-sketch'))
    expect(useCanvasStore.getState().bySessionId[SID].interactionMode).toBe('draw')
    expect(glass().style.pointerEvents).toBe('auto')
    expect(byTestId('canvas-tool-sketch')?.getAttribute('aria-pressed')).toBe('true')

    // The whole bug: before this there was no second press. Nothing in the
    // tools row said "stop sketching", so the glass kept the pointer.
    await click(byTestId('canvas-tool-sketch'))
    expect(useCanvasStore.getState().bySessionId[SID].interactionMode).toBe('browse')
    expect(glass().style.pointerEvents).toBe('none')
    expect(byTestId('canvas-tool-sketch')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('arms Region without changing the drawing mode, and Esc disarms it', async () => {
    await render()
    await reportViewport()
    await click(byTestId('canvas-tool-sketch'))
    await click(byTestId('canvas-tool-region'))
    expect(useCanvasReviewStore.getState().bySessionId[SID]?.marqueeArmed).toBe(true)
    // Still in draw mode underneath — Region is a pointer claim, not a mode.
    expect(useCanvasStore.getState().bySessionId[SID].interactionMode).toBe('draw')

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(useCanvasReviewStore.getState().bySessionId[SID]?.marqueeArmed).toBe(false)
  })

  it('never enters draw mode by itself', async () => {
    await render()
    expect(useCanvasStore.getState().bySessionId[SID].interactionMode).toBe('browse')
    await act(async () => {
      seed('v2')
    })
    expect(useCanvasStore.getState().bySessionId[SID].interactionMode).toBe('browse')
  })
})

describe('an inert glass really is inert (W24)', () => {
  it('marks itself inert in every posture where the content owns the pointer', async () => {
    await render()
    await reportViewport()
    expect(glass().getAttribute('data-glass-inert')).toBe('true')

    await click(byTestId('canvas-tool-sketch'))
    expect(glass().getAttribute('data-glass-inert')).toBeNull()

    // Region armed on top of draw mode: the marquee owns the pointer, so the
    // glass is inert again even though the mode is still 'draw'.
    await click(byTestId('canvas-tool-region'))
    expect(glass().getAttribute('data-glass-inert')).toBe('true')
  })

  it('carries a testid a VM pass can point at — inert in browse, live in draw', async () => {
    // W24 and W19 are both "the glass kept the pointer", and neither has a
    // repro that survives in a unit suite (they need a real page, a real wheel
    // and a real Excalidraw). This is the one attribute both turn on, so a
    // manual check has something to name.
    await render()
    expect(byTestId('canvas-glass-inert')).toBeTruthy()
    expect(byTestId('canvas-glass-live')).toBeNull()

    await click(byTestId('canvas-tool-sketch'))
    expect(byTestId('canvas-glass-inert')).toBeNull()
    expect(byTestId('canvas-glass-live')).toBeTruthy()
  })

  it('has a stylesheet rule that no descendant can out-declare', () => {
    // `pointer-events` is INHERITED, and Excalidraw re-declares it on its
    // islands (`pointer-events: var(--ui-pointerEvents)`, which is `all`), so
    // the inline `none` on the wrapper is a request, not a guarantee. This rule
    // is what makes it one.
    expect(STYLES).toMatch(
      /\[data-canvas-layer='glass'\]\[data-glass-inert='true'\] \*\s*\{[^}]*pointer-events:\s*none\s*!important/,
    )
  })
})

describe('the drawing tools (W17/W18)', () => {
  it('offers the Tools chip only while drawing, and it flips the glass attribute', async () => {
    await render()
    expect(byTestId('canvas-tool-tools')).toBeNull()

    await click(byTestId('canvas-tool-sketch'))
    expect(byTestId('canvas-tool-tools')).toBeTruthy()
    expect(glass().getAttribute('data-glass-tools')).toBe('shown')

    await click(byTestId('canvas-tool-tools'))
    expect(glass().getAttribute('data-glass-tools')).toBe('hidden')
    expect(byTestId('canvas-tool-tools')?.getAttribute('aria-pressed')).toBe('false')

    await click(byTestId('canvas-tool-tools'))
    expect(glass().getAttribute('data-glass-tools')).toBe('shown')
  })

  it('hides the islands only on request, and only the row that holds them', () => {
    expect(STYLES).toMatch(
      /\[data-canvas-layer='glass'\]\[data-glass-tools='hidden'\] \.App-menu_top\s*\{[^}]*display:\s*none\s*!important/,
    )
  })

  it('runs the glass with zen mode OFF, so the properties island exists at all', async () => {
    await render()
    expect(glassProps.zenModeEnabled).toBe(false)
    // ...and it is not quietly hidden again by the always-on chrome sweep —
    // exactly the rule block, so a later conditional rule naming the same
    // class cannot make this pass or fail by accident.
    const start = STYLES.indexOf("[data-canvas-layer='glass'] .main-menu-trigger")
    expect(start).toBeGreaterThan(-1)
    const hiddenList = STYLES.slice(start, STYLES.indexOf('}', start) + 1)
    expect(hiddenList).not.toContain('App-menu__left')
    expect(hiddenList).not.toContain('App-menu_top')
    expect(hiddenList).not.toContain('App-toolbar')
  })

  it('starts a mark in a colour and a face that read as an annotation', async () => {
    await render()
    const appState = (glassProps.initialData as { appState: Record<string, unknown> }).appState
    expect(appState.currentItemStrokeColor).toBe('#d20f39')
    expect(appState.currentItemFontFamily).toBe(2)
    expect(appState.viewBackgroundColor).toBe('transparent')
  })
})

describe('right-click reaches the glass (W19)', () => {
  it('host never prevents contextmenu on the glass layer', async () => {
    await render()
    await click(byTestId('canvas-tool-sketch'))
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 })
    await act(async () => {
      glass().dispatchEvent(event)
    })
    expect(event.defaultPrevented).toBe(false)
  })

  it('is not turned into a region drag when the marquee is armed', async () => {
    await render()
    await reportViewport()
    await click(byTestId('canvas-tool-region'))
    const marquee = container.querySelector('[data-canvas-layer="marquee"]')
    expect(marquee, 'the marquee capture layer').toBeTruthy()

    await act(async () => {
      marquee!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 2, clientX: 10, clientY: 10 }))
    })
    expect(byTestId('canvas-marquee-rect')).toBeNull()

    // The primary button still starts one — the guard is about WHICH button.
    await act(async () => {
      marquee!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }))
    })
    expect(byTestId('canvas-marquee-rect')).toBeTruthy()
  })
})

describe('sketches survive the pane (W20)', () => {
  it('serialises the scene with the version each mark was drawn on, and puts it back', async () => {
    await render()
    sceneElements = [{ id: 'e1' }]
    await act(async () => {
      capturedOnChange?.([{ id: 'e1' }])
    })
    // A second mark, made on v2, so the round-trip has a stamp to get wrong.
    await act(async () => {
      seed('v2')
    })
    sceneElements = [{ id: 'e2' }]
    await act(async () => {
      capturedOnChange?.([{ id: 'e2' }])
    })

    const saved = panelProps?.getSketchSceneForPersist?.()
    expect(saved).toBeTruthy()
    expect(JSON.parse(saved!.scene).map((el: El) => el.id).sort()).toEqual(['e1', 'e2'])
    expect(saved!.versions).toEqual({ e1: 'v1', e2: 'v2' })

    // A fresh pane, nothing on the glass, the saved scene handed back.
    await act(async () => root.unmount())
    container.remove()
    sceneElements = []
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    seed('v2')
    await render()
    await act(async () => {
      panelProps?.restoreSketchScene?.(saved!)
    })
    // e2 belongs to the displayed version and goes back on the glass; e1 was
    // drawn on v1, so it lands in the stash rather than over the wrong page —
    // and the union the submit path reads still has both.
    expect(sceneElements.map((el) => el.id)).toEqual(['e2'])
    expect(panelProps?.getAllSketchElements?.()?.map((el) => el.id).sort()).toEqual(['e1', 'e2'])
  })

  it('refuses a scene that is not a list of elements', async () => {
    await render()
    await act(async () => {
      panelProps?.restoreSketchScene?.({ scene: 'not json', versions: {} })
      panelProps?.restoreSketchScene?.({ scene: '{"nope":1}', versions: {} })
      panelProps?.restoreSketchScene?.({ scene: '[null,{"no":"id"}]', versions: {} })
    })
    expect(sceneElements).toEqual([])
  })

  it('leaves out the strokes a note has already taken', async () => {
    await render()
    sceneElements = [{ id: 'e1' }, { id: 'e2' }]
    await act(async () => {
      capturedOnChange?.(sceneElements)
    })
    expect(panelProps?.getUnattachedSketchElementIds?.()).toEqual(['e1', 'e2'])

    await act(async () => {
      panelProps?.markSketchElementsAttached?.(['e1'])
    })
    expect(useCanvasStore.getState().sketchByCanvasId[CANVAS].attached).toEqual(['e1'])
    expect(panelProps?.getUnattachedSketchElementIds?.()).toEqual(['e2'])
  })

  it('still answers once the glass has been torn down', async () => {
    // The panel persists on ITS unmount and is a later sibling than the glass,
    // so the save that closes the pane asks a component that is already gone.
    // An empty answer there would file an empty scene over a real one.
    await render()
    sceneElements = [{ id: 'e1' }]
    await act(async () => {
      capturedOnChange?.([{ id: 'e1' }])
    })
    sceneElements = []
    expect(panelProps?.getSketchSceneForPersist?.()).toBeTruthy()
    expect(panelProps?.getAllSketchElements?.()?.map((el) => el.id)).toEqual(['e1'])

    // ...and a glass the user genuinely emptied stays empty: the deletion is
    // reported too, so there is nothing left to fall back on.
    await act(async () => {
      capturedOnChange?.([{ id: 'e1', isDeleted: true }])
    })
    expect(panelProps?.getAllSketchElements?.()).toEqual([])
    expect(panelProps?.getSketchSceneForPersist?.()).toBeNull()
  })

  it('counts a draft note`s strokes as taken, even after the in-memory set is gone', async () => {
    // The attached set is renderer memory. A restart empties it and the draft
    // notes come BACK from disk still naming their strokes — so the notes, not
    // the set, are what must decide. Without this the next note re-takes the
    // drawing the previous one already carries.
    await render()
    sceneElements = [{ id: 'e1' }, { id: 'e2' }]
    await act(async () => {
      capturedOnChange?.(sceneElements)
    })
    expect(panelProps?.getUnattachedSketchElementIds?.()).toEqual(['e1', 'e2'])

    useCanvasReviewStore.setState({
      bySessionId: {
        [SID]: {
          canvasId: CANVAS,
          reviews: [{ id: 'R1', status: 'draft', annotationIds: ['a1'] }],
          annotations: [{ id: 'a1', reviewId: 'R1', sketch: { excalidrawElementIds: ['e1'] } }],
        } as never,
      },
    })
    expect(panelProps?.getUnattachedSketchElementIds?.()).toEqual(['e2'])
  })

  it('parks an EMPTY scene when the user cleared the glass, never a null', async () => {
    // Null means "no belt, fall through to disk", and for a canvas the user
    // just cleared that answer puts the deleted strokes straight back.
    await render()
    sceneElements = [{ id: 'e1' }]
    await act(async () => {
      capturedOnChange?.([{ id: 'e1' }])
    })
    sceneElements = []
    await act(async () => {
      capturedOnChange?.([])
    })

    await act(async () => root.unmount())
    container.remove()
    const parked = useCanvasStore.getState().sketchByCanvasId[CANVAS]?.scene
    expect(parked).toEqual({ scene: '[]', versions: {} })

    // ...and the store will not let a later null undo that.
    act(() => {
      useCanvasStore.getState().stashSketchScene(CANVAS, null)
    })
    expect(useCanvasStore.getState().sketchByCanvasId[CANVAS]?.scene).toEqual({ scene: '[]', versions: {} })

    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  it('parks the scene in memory on unmount, and unrolls it on the way back', async () => {
    await render()
    sceneElements = [{ id: 'e1' }]
    await act(async () => {
      capturedOnChange?.([{ id: 'e1' }])
    })

    await act(async () => root.unmount())
    container.remove()
    const parked = useCanvasStore.getState().sketchByCanvasId[CANVAS]?.scene
    expect(parked).toBeTruthy()
    expect(JSON.parse(parked!.scene).map((el: El) => el.id)).toEqual(['e1'])

    // Reopening the pane finds it there — no disk read, no lost marks.
    sceneElements = []
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    await render()
    expect(sceneElements.map((el) => el.id)).toEqual(['e1'])
  })
})

describe('the panel is told when the glass changes (W20)', () => {
  it('bumps the revision once per frame, however many reports arrive in it', async () => {
    await render()
    const before = panelProps?.sketchRevision ?? 0

    // A freehand drag is a stream of reports for one growing element. The panel
    // must re-render for it, but once per frame — not once per mouse move.
    await act(async () => {
      capturedOnChange?.([{ id: 'e1', version: 1 } as El])
      capturedOnChange?.([{ id: 'e1', version: 2 } as El])
      capturedOnChange?.([{ id: 'e1', version: 3 } as El])
      await frame()
    })
    expect(panelProps?.sketchRevision).toBe(before + 1)

    // A second, separate edit is a second frame and a second bump.
    await act(async () => {
      capturedOnChange?.([{ id: 'e1', version: 3 }, { id: 'e2', version: 1 }] as El[])
      await frame()
    })
    expect(panelProps?.sketchRevision).toBe(before + 2)
  })

  it('says nothing when only the camera moved', async () => {
    await render()
    await act(async () => {
      capturedOnChange?.([{ id: 'e1', version: 1 } as El])
      await frame()
    })
    const settled = panelProps?.sketchRevision ?? 0

    // The pane repins the glass on every scroll of the page underneath, and
    // each repin is another onChange with the same elements. Re-rendering the
    // panel for those would put a render on every wheel notch.
    await act(async () => {
      capturedOnChange?.([{ id: 'e1', version: 1 } as El])
      capturedOnChange?.([{ id: 'e1', version: 1 } as El])
      await frame()
    })
    expect(panelProps?.sketchRevision).toBe(settled)
  })

  it('hands the panel the canvas the SURFACE is keyed by', async () => {
    await render()
    expect(panelProps?.canvasId).toBe(CANVAS)
  })
})

describe('a stored scene is never allowed to break the canvas (W20)', () => {
  it('drops a malformed element instead of handing it to the glass', async () => {
    await render()
    await act(async () => {
      panelProps?.restoreSketchScene?.({
        scene: JSON.stringify([{ id: 'good' }, { id: 'MALFORMED' }]),
        versions: {},
      })
    })
    expect(sceneElements.map((el) => el.id)).toEqual(['good'])
  })

  it('lets one bad entry drop only itself, never its good neighbours', async () => {
    // Excalidraw's normaliser reads `element.type` on every entry with no null
    // guard, so a single null in the list throws — and a catch around the whole
    // call would take the user's real strokes down with it.
    await render()
    let changed: boolean | undefined
    await act(async () => {
      changed = panelProps?.restoreSketchScene?.({
        scene: JSON.stringify([{ id: 'good1' }, null, 42, [], { id: 'good2' }]),
        versions: {},
      })
    })
    expect(changed).toBe(true)
    expect(sceneElements.map((el) => el.id)).toEqual(['good1', 'good2'])
  })

  it('caps how much of a stored scene it will even normalise', async () => {
    await render()
    const huge = Array.from({ length: 2500 }, (_, i) => ({ id: `e${i}` }))
    await act(async () => {
      panelProps?.restoreSketchScene?.({ scene: JSON.stringify(huge), versions: {} })
    })
    expect((restoreElements.mock.calls[0][0] as El[]).length).toBe(2000)
    expect(sceneElements.length).toBe(2000)
  })

  it('reports whether the glass actually moved, so an armed ignore-flag is not left armed', async () => {
    // The panel arms "ignore the next revision" before restoring, because a
    // restore it asked for is not the user drawing. A restore that changes
    // nothing fires no onChange, so a flag armed on faith would still be armed
    // when the user makes their FIRST real stroke and would swallow its
    // dirty-mark. The answer has to be the truth about the glass.
    await render()
    const scene = { scene: JSON.stringify([{ id: 'e1' }]), versions: {} }
    expect(panelProps?.restoreSketchScene?.(scene)).toBe(true)

    // Everything already known: nothing added, nothing changed.
    expect(panelProps?.restoreSketchScene?.(scene)).toBe(false)
    // Nothing survives the normaliser: also nothing changed.
    expect(
      panelProps?.restoreSketchScene?.({ scene: JSON.stringify([{ id: 'MALFORMED' }]), versions: {} }),
    ).toBe(false)
    // ...and neither does an unparseable one.
    expect(panelProps?.restoreSketchScene?.({ scene: 'not json', versions: {} })).toBe(false)
  })

  it('survives a normaliser that throws — reviews.json carries no MAC', async () => {
    await render()
    restoreElements.mockImplementationOnce(() => {
      throw new Error('hostile element')
    })
    await act(async () => {
      panelProps?.restoreSketchScene?.({ scene: JSON.stringify([{ id: 'e1' }]), versions: {} })
    })
    // Dropped, not fatal: an exception here renders inside Excalidraw and takes
    // the App-wide boundary with it, on every mount of that canvas.
    expect(sceneElements).toEqual([])
    expect(container.querySelector('[data-canvas-layer="glass"]')).toBeTruthy()
  })
})

describe('the canvas ⇄ terminal swap fades (W23)', () => {
  it('fades the pane in on mount', async () => {
    await render()
    expect(byTestId('canvas-pane-root')?.className).toContain('pane-fade-in')
  })

  it('holds still when the OS asks for less motion', () => {
    const block = STYLES.slice(STYLES.indexOf('.pane-fade-in {'))
    expect(block).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.pane-fade-in \{ animation: none; \}/)
  })
})
