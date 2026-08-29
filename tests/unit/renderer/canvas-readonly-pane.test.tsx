// @vitest-environment jsdom
//
// The READ-ONLY pane (M4, W38) — a completed canvas that belongs to another
// session, opened from the project Library.
//
// This is a SECURITY-RELEVANT UI CONTRACT, so it is tested as one. Main refuses
// every mutating canvas channel for a caller that does not own the canvas
// (Builder E's boundary file proves that end); this file proves the other end:
// that the surface never OFFERS one, and — the assertion that cannot be fooled
// by a control moving somewhere else — that a read-only pane never CALLS one.
// The canvas preload API is spied whole through a proxy, so a channel nobody
// thought to enumerate is still caught the moment it is used.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { CanvasState, CanvasVersion } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

/* ── stubs for the heavy children ────────────────────────────────────────── */

const fakeGlassApi = {
  getSceneElements: () => [],
  updateScene: vi.fn(),
  getAppState: () => ({ selectedElementIds: {} }),
  getFiles: () => ({}),
  updateLibrary: vi.fn(),
  setActiveTool: vi.fn(),
  refresh: vi.fn(),
  onScrollChange: vi.fn(),
  getSceneElementsIncludingDeleted: () => [],
}
vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: (props: Record<string, unknown>) => {
    ;(props.excalidrawAPI as ((api: unknown) => void) | undefined)?.(fakeGlassApi)
    return null
  },
  restoreElements: (els: unknown) => els,
  exportToBlob: vi.fn(),
  sceneCoordsToViewportCoords: () => ({ x: 0, y: 0 }),
  viewportCoordsToSceneCoords: () => ({ x: 0, y: 0 }),
}))

/** Did the review panel mount at all? On a read-only surface it must not: it
 *  IS the composer, the decision bar, the per-note controls and the reopen
 *  buttons, and every one of those writes. */
let notesPanelMounted = 0
vi.mock('../../../src/renderer/components/CanvasNotesPanel', () => ({
  default: () => {
    notesPanelMounted += 1
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

/* ── the whole canvas API, spied ─────────────────────────────────────────── */

/**
 * Everything a read-only pane is allowed to call.
 *
 * READS ONLY, and each one has to earn its place:
 *  - getState / onChanged / onReviewChanged / reviewGetState — the SESSION's own
 *    canvas mirror, which the pane keeps hydrated whatever it is displaying.
 *  - getReadonly — the foreign canvas, completed-only and project-scoped in main.
 *  - libraryList / evidenceRead — the Library overlay, if it is opened.
 *  - onSnapshotRequest / onFrameNavigated — main→renderer subscriptions.
 * Anything else is a write, and a write from here is the bug this file exists
 * to catch.
 */
const READ_ONLY_ALLOWED = new Set([
  'getState',
  'getReadonly',
  'reviewGetState',
  'libraryList',
  'evidenceRead',
  'onChanged',
  'onReviewChanged',
  'onSnapshotRequest',
  'onFrameNavigated',
])

let called: string[] = []
let readonlyState: CanvasState | null = null

const unsubscribe = () => () => {}
const impls: Record<string, (...args: any[]) => unknown> = {
  getState: async () => ownState(),
  getReadonly: async () => readonlyState,
  reviewGetState: async () => null,
  libraryList: async () => ({ rows: [], truncated: false }),
  evidenceRead: async () => null,
  onChanged: unsubscribe,
  onReviewChanged: unsubscribe,
  onSnapshotRequest: unsubscribe,
  onFrameNavigated: unsubscribe,
}

const memo = new Map<string, (...args: any[]) => unknown>()
const canvasApi = new Proxy(
  {},
  {
    get(_t, prop) {
      if (typeof prop !== 'string' || prop === 'then' || prop === 'toJSON') return undefined
      if (!memo.has(prop)) {
        memo.set(prop, (...args: any[]) => {
          called.push(prop)
          const impl = impls[prop]
          // An unmapped channel still ANSWERS (a promise of nothing), so the
          // component under test carries on and the failure that gets reported
          // is the forbidden call itself rather than an unhandled rejection.
          return impl ? impl(...args) : Promise.resolve(null)
        })
      }
      return memo.get(prop)
    },
  },
)

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  canvas: canvasApi,
}

const AgentCanvasPane = (await import('../../../src/renderer/components/AgentCanvasPane')).default
const { requestCanvasReadonlyView, _resetCanvasReadonlyRequestsForTest } = await import(
  '../../../src/renderer/components/CanvasLibrary'
)
const { useCanvasStore } = await import('../../../src/renderer/stores/canvasStore')
const { useCanvasReviewStore } = await import('../../../src/renderer/stores/canvasReviewStore')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')

const SID = 'session-1'
const OWN_CANVAS = 'canvas-own'
const FOREIGN = 'canvas-foreign'

const design = (id: string): CanvasVersion => ({
  id,
  mode: 'design',
  createdAt: '2026-08-29T10:00:00Z',
  source: { mode: 'design', entry: 'index.html' },
  verdict: { state: 'approved', at: '2026-08-29T11:00:00Z', by: 'user' },
}) as CanvasVersion

/** A PLAN version — a design-sourced document whose mode says what it is. */
const plan = (id: string): CanvasVersion => ({
  id,
  mode: 'plan',
  createdAt: '2026-08-29T10:00:00Z',
  source: { mode: 'design', entry: 'index.html' },
  verdict: { state: 'approved', at: '2026-08-29T11:00:00Z', by: 'user' },
}) as CanvasVersion

const pack = (id: string): CanvasVersion => ({
  id,
  mode: 'uat',
  createdAt: '2026-08-29T10:00:00Z',
  source: { mode: 'uat', distRoot: 'F:/site/dist', entry: 'index.html', buildLabel: '5' },
  verdict: { state: 'approved', at: '2026-08-29T11:00:00Z', by: 'user' },
}) as CanvasVersion

/**
 * A canvas holding TWO artefact runs — a mockup run and a plan.
 *
 * Both the positive control and the read-only negatives use it, and the shape
 * is chosen so the History dropdown really does offer its row actions: `delete`
 * appears only when a second artefact would remain, and `archive` only on a
 * non-uat artefact (a legacy uat build is inherently archived and has no
 * toggle). A mockup-plus-pack fixture would leave BOTH negatives passing on a
 * dropdown where neither control had ever existed.
 */
const twoArtefacts = (): CanvasVersion[] => [design('v1'), design('v2'), plan('v3')]

/** The SESSION's own canvas. Mutable, because the positive control needs a
 *  richer one than the default. */
let ownVersions: CanvasVersion[] = []
let ownActiveId = 'v1'

const ownState = (): CanvasState =>
  ({
    canvasId: OWN_CANVAS,
    sessionId: SID,
    activeVersionId: ownActiveId,
    versions: ownVersions,
  }) as CanvasState

/** Seed BOTH main's answer and the store mirror, so the first render and the
 *  mount refresh agree. */
function seedOwn(versions: CanvasVersion[], activeId: string): void {
  ownVersions = versions
  ownActiveId = activeId
  useCanvasStore.setState({
    bySessionId: {
      [SID]: {
        canvasId: OWN_CANVAS,
        versions,
        activeVersionId: activeId,
        interactionMode: 'browse',
        emptyView: 'intro',
        unseenRender: false,
        loaded: true,
      },
    },
  })
}

const foreignState = (versions: CanvasVersion[], activeId?: string): CanvasState =>
  ({
    canvasId: FOREIGN,
    sessionId: 'session-other',
    activeVersionId: activeId ?? versions[versions.length - 1].id,
    title: 'Onboarding flow',
    versions,
    completed: { at: '2026-08-29T12:00:00Z', by: 'user' },
  }) as CanvasState

let container: HTMLDivElement
let root: Root

const byTestId = (id: string): HTMLElement | null => container.querySelector(`[data-testid="${id}"]`)

async function render(): Promise<void> {
  await act(async () => {
    root.render(<AgentCanvasPane sessionId={SID} isActive />)
  })
}

async function openReadonly(versions: CanvasVersion[], activeId?: string): Promise<void> {
  readonlyState = foreignState(versions, activeId)
  await render()
  // The session's OWN canvas mounted first — its panel and its reads belong to
  // that phase. Everything recorded from here is the read-only pane's doing.
  notesPanelMounted = 0
  called = []
  await act(async () => {
    requestCanvasReadonlyView(SID, FOREIGN)
  })
  // The read is a promise; let it settle before anything is asserted.
  await act(async () => {
    await Promise.resolve()
  })
}

beforeEach(() => {
  called = []
  notesPanelMounted = 0
  readonlyState = null
  _resetCanvasReadonlyRequestsForTest()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  useSessionStore.setState({ sessions: [{ id: SID }] } as any)
  useCanvasReviewStore.setState({ bySessionId: {} })
  useCanvasStore.setState({ sketchByCanvasId: {} })
  seedOwn([design('v1')], 'v1')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  _resetCanvasReadonlyRequestsForTest()
})

describe('opening a completed canvas this session does not own', () => {
  it('reads it through canvas:getReadonly and shows it', async () => {
    await openReadonly([design('v1'), design('v2')])
    expect(called).toContain('getReadonly')
    expect(byTestId('canvas-pane-root')).toBeTruthy()
    expect(byTestId('canvas-content-frame')).toBeTruthy()
    expect(byTestId('canvas-artifact-name')?.textContent).toBe('Onboarding flow')
  })

  it('says whose work it is, in the header', async () => {
    await openReadonly([design('v1')])
    const chip = byTestId('canvas-readonly-chip')
    expect(chip).toBeTruthy()
    expect(chip?.textContent).toContain('READ-ONLY')
  })

  it('says so plainly when main will not hand it over', async () => {
    readonlyState = null
    await render()
    await act(async () => {
      requestCanvasReadonlyView(SID, FOREIGN)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(byTestId('canvas-readonly-unavailable')?.textContent).toContain('not readable from this session')
  })
})

describe('every mutating affordance is absent, one by one', () => {
  /** The enumerated set. Each entry is a control that writes, and the reason it
   *  cannot be on somebody else's finished artefact. */
  const FORBIDDEN: { testId: string; what: string }[] = [
    { testId: 'canvas-tool-sketch', what: 'Sketch — strokes ride the next note' },
    { testId: 'canvas-tool-region', what: 'Region — arms a note target' },
    { testId: 'canvas-tool-tools', what: 'the drawing tools, which only exist inside Sketch' },
    { testId: 'canvas-pack-name', what: 'the test pack rename' },
    { testId: 'canvas-pack-name-input', what: 'the test pack rename, mid-edit' },
    { testId: 'canvas-end-test', what: 'End test — a control over somebody else’s run' },
    { testId: 'canvas-complete-arm', what: 'Mark complete' },
    { testId: 'canvas-complete-confirm', what: 'Mark complete, armed' },
    { testId: 'canvas-completed-chip', what: 'the sign-off chip and the Reopen it carries' },
    { testId: 'canvas-completed-reopen', what: 'Reopen — the owner’s to undo' },
    { testId: 'canvas-history-archive', what: 'artifact archive, in the History dropdown' },
    { testId: 'canvas-history-delete', what: 'artifact delete, in the History dropdown' },
    { testId: 'canvas-panel-rail', what: 'the review panel’s collapsed rail' },
  ]

  /**
   * THE POSITIVE CONTROL for the list above.
   *
   * Every assertion in `renders none of them` is a `toBeNull`, and a `toBeNull`
   * passes just as happily when the testid was renamed, the fixture was too
   * thin to produce the control, or the control was deleted outright. So the
   * same controls are proved to EXIST on the session's own canvas first, with
   * the same fixture — two artefact runs, so History offers `delete` at all.
   */
  it('the same controls really are there when the canvas is yours', async () => {
    seedOwn(twoArtefacts(), 'v2')
    await render()
    expect(byTestId('canvas-version-stepper'), 'canvas-version-stepper').toBeTruthy()
    const history = byTestId('canvas-history-button')
    expect(history, 'canvas-history-button').toBeTruthy()
    await act(async () => history!.click())
    expect(byTestId('canvas-history-archive'), 'canvas-history-archive').toBeTruthy()
    expect(byTestId('canvas-history-delete'), 'canvas-history-delete').toBeTruthy()
    expect(byTestId('canvas-tool-sketch'), 'canvas-tool-sketch').toBeTruthy()
    expect(byTestId('canvas-tool-region'), 'canvas-tool-region').toBeTruthy()
  })

  it('renders none of them', async () => {
    // The SAME two-artefact fixture, displaying the mockup run — so History's
    // delete is one the pane could have offered, and did not.
    await openReadonly(twoArtefacts(), 'v2')
    // The History dropdown has to be OPEN for its own controls to be provable,
    // and the trigger must be THERE — a rename would otherwise turn the whole
    // loop below into a list of assertions about an empty pane.
    const history = byTestId('canvas-history-button')
    expect(history, 'canvas-history-button must still be on a read-only pane').toBeTruthy()
    await act(async () => history!.click())
    for (const entry of FORBIDDEN) {
      expect(byTestId(entry.testId), `${entry.testId} (${entry.what}) must not be on a read-only pane`).toBeNull()
    }
  })

  it('never mounts the review panel — composer, decision bar and note controls with it', async () => {
    await openReadonly([design('v1')])
    expect(notesPanelMounted).toBe(0)
  })

  it('keeps X-Ray, which only reads the page', async () => {
    await openReadonly([design('v1')])
    expect(byTestId('canvas-xray-mode')).toBeTruthy()
  })

  it('leaves the session’s own interaction mode alone', async () => {
    useCanvasStore.setState((s) => ({
      bySessionId: { ...s.bySessionId, [SID]: { ...s.bySessionId[SID], interactionMode: 'draw' as const } },
    }))
    await openReadonly([design('v1')])
    // The surface is browse-only regardless, and it must not have written the
    // session's own mode on the way there.
    expect(useCanvasStore.getState().bySessionId[SID].interactionMode).toBe('draw')
  })
})

describe('the pane never calls a mutating channel while read-only', () => {
  it('the spy can fail — a write through the same proxy is caught', async () => {
    await openReadonly([design('v1')])
    // Proving the verifier: without this, an allowlist that matched everything
    // (or a proxy that recorded nothing) would pass the two tests below in
    // silence. One deliberate write, and the filter has to see it.
    await (window as any).electronAPI.canvas.deleteCanvas({ canvasId: FOREIGN })
    expect(called.filter((name) => !READ_ONLY_ALLOWED.has(name))).toEqual(['deleteCanvas'])
  })

  it('holds for a mockup, through a version step and a History open', async () => {
    await openReadonly([design('v1'), design('v2')])
    // Must EXIST, or "stepping calls nothing" is a claim about a control that
    // was not on screen. The positive control above pins the same testid.
    const stepper = byTestId('canvas-version-stepper')
    expect(stepper, 'canvas-version-stepper must be on a read-only pane').toBeTruthy()
    const steps = Array.from(stepper!.querySelectorAll('button'))
    expect(steps.length).toBeGreaterThan(0)
    for (const btn of steps) {
      await act(async () => (btn as HTMLElement).click())
    }
    const forbidden = called.filter((name) => !READ_ONLY_ALLOWED.has(name))
    expect(forbidden, `forbidden canvas calls: ${forbidden.join(', ')}`).toEqual([])
    // Specifically: stepping a version must not move the SESSION's active one.
    expect(called).not.toContain('setActiveVersion')
  })

  it('holds for a completed test pack, which shows a plain notice instead of a recall', async () => {
    await openReadonly([pack('v1')])
    expect(byTestId('canvas-readonly-pack')).toBeTruthy()
    // Never the recall view: it would render "submitted with no notes" over a
    // run whose notes this session simply cannot read.
    expect(byTestId('canvas-recall')).toBeNull()
    expect(byTestId('canvas-recall-empty')).toBeNull()
    const forbidden = called.filter((name) => !READ_ONLY_ALLOWED.has(name))
    expect(forbidden, `forbidden canvas calls: ${forbidden.join(', ')}`).toEqual([])
  })
})

describe('the way back', () => {
  it('‹ Library drops the read-only view and opens the Library', async () => {
    await openReadonly([design('v1')])
    await act(async () => {
      byTestId('canvas-library-open')?.click()
    })
    expect(byTestId('canvas-readonly-chip')).toBeNull()
    expect(byTestId('canvas-library')).toBeTruthy()
  })

  it('a pack’s ‹ Library does the same', async () => {
    await openReadonly([pack('v1')])
    await act(async () => {
      byTestId('canvas-readonly-pack-back')?.click()
    })
    expect(byTestId('canvas-readonly-pack')).toBeNull()
    expect(byTestId('canvas-library')).toBeTruthy()
  })

  /**
   * The read-only view must not OUTLIVE the pane.
   *
   * The request slot is module state — that is what lets the Library raise it
   * from either of its two mount points — so nothing about closing the pane
   * clears it on its own. Left set, the next time the user opened their canvas
   * they got somebody else's back instead of their own work, with nothing on
   * screen explaining why. ✕ clears it, and so does the unmount App performs
   * when the pane closes; both are proved, because either one alone would let
   * the other rot.
   */
  it('closing the pane with ✕ drops it, so the next open is your own canvas', async () => {
    await openReadonly([design('v1')])
    expect(byTestId('canvas-readonly-chip')).toBeTruthy()
    await act(async () => {
      byTestId('canvas-pane-close')?.click()
    })
    expect(byTestId('canvas-readonly-chip')).toBeNull()
    expect(byTestId('canvas-content-frame')).toBeTruthy()
    expect(byTestId('canvas-artifact-name')).toBeNull() // the own canvas has no title
  })

  it('a pack’s ✕ drops it too', async () => {
    await openReadonly([pack('v1')])
    await act(async () => {
      byTestId('canvas-readonly-pack-close')?.click()
    })
    expect(byTestId('canvas-readonly-pack')).toBeNull()
  })

  it('unmounting the pane drops it — which is what App does on close', async () => {
    await openReadonly([design('v1')])
    expect(byTestId('canvas-readonly-chip')).toBeTruthy()
    await act(async () => root.unmount())
    root = createRoot(container)
    await render()
    expect(byTestId('canvas-readonly-chip')).toBeNull()
    expect(byTestId('canvas-readonly-unavailable')).toBeNull()
  })
})
