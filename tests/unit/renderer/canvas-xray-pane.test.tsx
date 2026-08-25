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

// A frame that answers a hoverReporting request (as a real bridge does) and
// never answers anything else — an inspect left in flight is what the
// one-inspect-at-a-time rule is about, and is not this file's subject.
const answerAsARealFrameWould = (_target: unknown, _canvasId: unknown, payload: { type?: string; enabled?: boolean }) =>
  payload?.type === 'hoverReporting'
    ? Promise.resolve({ enabled: payload.enabled })
    : new Promise(() => {})
const askFrame = vi.fn(answerAsARealFrameWould)
/** How many requests the RPC layer already has outstanding to this frame. The
 *  pane reads this before it posts, so a test can saturate the cap the way a
 *  snapshot, an inspect and a resolution pass do. */
let framesInFlightNow = 0
vi.mock('../../../src/renderer/canvas/canvas-frame-rpc', () => ({
  askCanvasFrame: (...args: unknown[]) => askFrame(...(args as [])),
  framesInFlight: () => framesInFlightNow,
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

/** A second render on the same canvas — switching to it reloads the frame. */
const V2 = {
  id: 'v2',
  mode: 'design',
  createdAt: '2026-08-14T10:05:00Z',
  source: { mode: 'design', entry: 'index.html' },
} as (typeof STATE.versions)[number]

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

/**
 * Park the NEXT frame request: it stays unanswered until the returned settle is
 * called. This is the shape both review blockers hide in — a hoverReporting
 * request is in flight (for up to HOVER_REPORTING_TIMEOUT_MS of real time)
 * while the world moves under it.
 */
function parkNextRequest(): (value: unknown) => void {
  let settle: (value: unknown) => void = () => {}
  askFrame.mockImplementationOnce(() => new Promise((resolve) => { settle = resolve }))
  return (value: unknown) => settle(value)
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
  // Reset, not clear: a test that installs its own frame behaviour must not
  // leave it running for the next one.
  askFrame.mockReset()
  askFrame.mockImplementation(answerAsARealFrameWould)
  framesInFlightNow = 0
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

  it('does not invite a hover the glass would swallow', async () => {
    // In Draw (and Region) the pointer never reaches the content, so "Hover the
    // page" was an instruction the user could follow for a while before working
    // out why nothing ever appeared (independent review of #405).
    await renderPane('stealth')
    await act(async () => {
      useCanvasStore.getState().setInteractionMode(SID, 'draw')
    })
    const idle = container.querySelector('[data-testid="canvas-xray-idle"]')
    expect(idle?.textContent).toContain('Draw has the pointer')
    expect(idle?.textContent).not.toContain('Hover the page')
  })

  it('says so for Region too, and goes back to the invitation in Browse', async () => {
    await renderPane('stealth')
    await act(async () => {
      useCanvasReviewStore.getState().setMarqueeArmed(SID, true)
    })
    expect(container.querySelector('[data-testid="canvas-xray-idle"]')?.textContent).toContain('Region has the pointer')

    await act(async () => {
      useCanvasReviewStore.getState().setMarqueeArmed(SID, false)
    })
    expect(container.querySelector('[data-testid="canvas-xray-idle"]')?.textContent).toContain('Hover the page')
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

  it('tells a newly navigated document to stop reporting too', async () => {
    // A link click inside the content replaces the document — and its bridge,
    // which starts at its reporting default — without changing the pane's
    // contentUrl or its reload nonce. `ready` is the only signal that the frame
    // has forgotten what it was told, so a mode sync keyed on the URL left Off
    // quieting only the FIRST page the canvas ever loaded (Copilot review,
    // #405). The host gate hid this: nothing was drawn either way, and only the
    // page's own per-mousemove work came back.
    await renderPane('off')
    await act(async () => handlers().onReady())
    expect(hoverReportingCalls()).toEqual([false])

    await act(async () => handlers().onReady())
    expect(hoverReportingCalls()).toEqual([false, false])
  })

  it('does not re-ask a document that is already quiet', async () => {
    // The reset is on `ready` (a new document), not on every render: a mode the
    // frame already agrees with must still cost no round-trip.
    await renderPane('off')
    await act(async () => handlers().onReady())
    await act(async () => handlers().onPointer(SAVE_BUTTON))
    await act(async () => handlers().onViewport(VIEWPORT))
    expect(hoverReportingCalls()).toEqual([false])
  })

  it('does not believe a request that was refused before it was posted', async () => {
    // canvas-frame-rpc caps requests in flight at four, and a snapshot, an
    // inspect and a resolveAnchors can already be outstanding when the user
    // reaches for the switch. Marking the frame quiet on the SEND left the host
    // permanently certain it had told a frame that was never told, and the page
    // doing per-mousemove work for the rest of that document's life (Copilot
    // review, #405). Nothing is drawn either way, so the work IS the symptom.
    const refuse = () => Promise.reject(new Error('Too many canvas frame requests are already in flight'))
    askFrame.mockImplementationOnce(refuse).mockImplementationOnce(refuse)
    await renderPane('off')
    // Each refusal reconciles when it settles, so the third attempt lands
    // without waiting for anything the page has to do first.
    await act(async () => handlers().onReady())
    expect(hoverReportingCalls()).toEqual([false, false, false])
    expect(overlay().textContent).not.toContain('button "Save"')

    // Once one lands, the asking stops.
    await act(async () => handlers().onPointer(SAVE_BUTTON))
    await act(async () => handlers().onViewport(VIEWPORT))
    expect(hoverReportingCalls()).toEqual([false, false, false])
  })

  it('gives up on a frame that will never confirm, and tries again when the user asks again', async () => {
    // The reconcile retries whenever a request settles without the frame
    // agreeing, so something has to stop a page that never complies from
    // setting the host's call rate. Three attempts per intent. (A non-boolean
    // is no answer at all: the reply is page-authored, so nothing is believed
    // from it and the host records that it does not know.)
    askFrame.mockImplementation(() => Promise.resolve({ enabled: 'nope' }))
    await renderPane('off')
    await act(async () => handlers().onReady())
    expect(hoverReportingCalls()).toEqual([false, false, false])

    // Reports from the page do not buy it more attempts.
    await act(async () => {
      for (let i = 0; i < 50; i++) handlers().onPointer(SAVE_BUTTON)
      for (let i = 0; i < 50; i++) handlers().onContentClick(1, 1)
    })
    expect(hoverReportingCalls()).toEqual([false, false, false])

    // Passing through On and back to Off is the user asking again, which is a
    // new intent and a fresh budget. On costs a round-trip of its own here —
    // this frame answered nothing the host could believe, so the host does NOT
    // know whether it is still reporting, and a mode that needs those reports
    // has to say so rather than assume the default it started from (fix-delta
    // verification, #405). A frame that answers truthfully still costs nothing:
    // see the round-trip test below.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="canvas-xray-on"]')!.click()
    })
    expect(hoverReportingCalls()).toEqual([false, false, false, true, true, true])
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="canvas-xray-off"]')!.click()
    })
    expect(hoverReportingCalls()).toEqual([false, false, false, true, true, true, false, false, false])

    // Nothing was ever drawn throughout: the host gate never depended on the
    // frame complying.
    expect(overlay().textContent).not.toContain('button "Save"')
  })

  it('says in the mode strip that hovering and clicking do nothing', async () => {
    await renderPane('off')
    expect(container.textContent).toContain('X-Ray is off')
  })
})

// ── The world moving under a parked request (independent review of #405) ─────
// A hoverReporting request can sit unanswered for up to HOVER_REPORTING_TIMEOUT_MS.
// Both findings live in that window, and neither has a symptom to repair from:
// the frame in both cases goes QUIET, which is indistinguishable from a page
// nobody is pointing at.
describe('a mode change while a request is in flight', () => {
  it('is not lost when the parked answer finally lands', async () => {
    // BLOCKER-1. Off, request parked; the user flips to On, and the in-flight
    // guard drops that sync. The parked answer then lands saying "quiet" — and
    // before the post-settle reconcile, nothing re-ran: the frame stayed quiet
    // for the life of the document, so x-ray On drew nothing, Stealth read out
    // nothing, and clicks stopped selecting, with no report to notice it by.
    const settle = parkNextRequest()
    await renderPane('off')
    await act(async () => handlers().onReady())
    expect(hoverReportingCalls()).toEqual([false])

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="canvas-xray-on"]')!.click()
    })
    expect(hoverReportingCalls()).toEqual([false])

    await act(async () => settle({ enabled: false }))
    expect(hoverReportingCalls()).toEqual([false, true])

    // …and the pane works again, which is the point.
    await hoverSaveButton()
    expect(overlay().textContent).toContain('button "Save"')
  })

  it('does not let the previous document’s answer land on the new one', async () => {
    // MAJOR-2. Doc A's parked answer arrives after doc B's `ready`. Believing
    // it about doc B set the state to "quiet" while doc B was loud, and the
    // reconcile then short-circuited — re-opening, through the other door, the
    // in-frame-navigation bug e608cf32 closed.
    const settleDocA = parkNextRequest()
    await renderPane('off')
    await act(async () => handlers().onReady())
    expect(hoverReportingCalls()).toEqual([false])

    // Doc B: an in-frame navigation, so a new bridge at its reporting default.
    await act(async () => handlers().onReady())
    expect(hoverReportingCalls()).toEqual([false])

    await act(async () => settleDocA({ enabled: false }))
    expect(hoverReportingCalls()).toEqual([false, false])
  })

  it('releases the in-flight slot even for an answer it refuses to believe', async () => {
    // The generation check must not skip the cleanup: one navigation during one
    // request would otherwise wedge the switch for the life of the pane.
    const settleDocA = parkNextRequest()
    await renderPane('off')
    await act(async () => handlers().onReady())
    await act(async () => handlers().onReady())
    await act(async () => settleDocA({ enabled: false }))

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="canvas-xray-on"]')!.click()
    })
    expect(hoverReportingCalls()).toEqual([false, false, true])
  })
})

// ── What the host does NOT know (fix-delta verification of #405) ─────────────
// The bridge applies hoverReporting and only THEN replies, so a request that
// does not come back is not a request that did not happen. Everything here is
// about the host being honest that it has no account of the frame, and about
// not spending its one budget on conditions inside itself.
describe('a request the frame never acknowledged', () => {
  it('leaves the host not knowing, so the next mode still asks', async () => {
    // MAJOR-A. Off is applied by the bridge; the ack is dropped (or lands after
    // the timeout). Carrying the old belief forward made the flip to On a
    // no-op — desire(true) matched belief(true), the reconcile short-circuited
    // — and the frame stayed quiet for the life of the document: x-ray On drew
    // nothing, clicks selected nothing, and no report was left to repair from.
    const lost = () => Promise.reject(new Error('The canvas frame did not answer the hoverReporting request in time.'))
    askFrame.mockImplementationOnce(lost).mockImplementationOnce(lost).mockImplementationOnce(lost)
    await renderPane('off')
    await act(async () => handlers().onReady())
    expect(hoverReportingCalls()).toEqual([false, false, false])

    // The user asks for On. The frame may well be quiet — the host cannot say —
    // so this MUST go out rather than be answered from a stale belief.
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="canvas-xray-on"]')!.click()
    })
    expect(hoverReportingCalls()).toEqual([false, false, false, true])

    // …and once that lands the asking stops: unknown is a state to leave, not a
    // reason to keep asking.
    await act(async () => handlers().onPointer(SAVE_BUTTON))
    expect(hoverReportingCalls()).toEqual([false, false, false, true])
  })

  it('does not spend the budget on a frame it never managed to ask', async () => {
    // MINOR-B. Over the RPC's in-flight cap the request is refused BEFORE a
    // listener exists — a synchronous rejection, which the post-settle
    // reconcile fires straight back into: all three attempts went in three
    // microtasks, on a condition that clears in milliseconds. (Reachable: the
    // resolution pass has no in-flight guard of its own, so a few note edits
    // inside its ten-second window saturate the cap.) The intent was then
    // wedged — the cap cleared and nothing ever asked again.
    askFrame.mockImplementation((target: unknown, canvasId: unknown, payload: { type?: string; enabled?: boolean }) =>
      framesInFlightNow >= 4
        ? Promise.reject(new Error('Too many canvas frame requests are already in flight'))
        : answerAsARealFrameWould(target, canvasId, payload),
    )
    framesInFlightNow = 4
    await renderPane('off')
    await act(async () => handlers().onReady())
    // Nothing was asked at all, so nothing was held against the frame.
    expect(hoverReportingCalls()).toEqual([])

    framesInFlightNow = 0
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    expect(hoverReportingCalls()).toEqual([false])
  })

  it('does not let a parked answer land on the document that replaced it', async () => {
    // The NIT. A new version (or a retry) reloads the frame and resets the
    // belief to a fresh bridge's default — but the request parked against the
    // OLD document was still in its generation, so its answer landed on the new
    // one and undid that reset. The generation bump belongs with every reset,
    // not only with `ready`.
    const settleOld = parkNextRequest()
    await renderPane('off')
    await act(async () => handlers().onReady())
    expect(hoverReportingCalls()).toEqual([false])

    await act(async () => {
      useCanvasStore.setState((s) => ({
        bySessionId: {
          ...s.bySessionId,
          [SID]: {
            ...s.bySessionId[SID]!,
            versions: [...STATE.versions, V2],
            activeVersionId: V2.id,
          },
        },
      }))
    })
    await act(async () => settleOld({ enabled: false }))
    expect(hoverReportingCalls()).toEqual([false, false])
  })

  it('does not let a flood of `ready` multiply the send rate', async () => {
    // MINOR-C. `ready` is page-authored, and every one of them is a new
    // document with a fresh attempt budget — so a page that simply re-emits it
    // multiplied the host's send rate by that budget (three requests became
    // eighteen after five extra readys). The rolling send window is the
    // ceiling, whatever drives it. Time is frozen so this asserts the ceiling
    // and not the wall clock.
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    try {
      askFrame.mockImplementation(() => Promise.resolve({ enabled: 'nope' }))
      await renderPane('off')
      for (let i = 0; i < 6; i++) await act(async () => handlers().onReady())
      // Six documents × three attempts is eighteen without a ceiling.
      expect(hoverReportingCalls().length).toBe(12)
      expect(hoverReportingCalls().every((enabled) => enabled === false)).toBe(true)
      // And the mode still holds regardless: the host gate never depended on
      // any of this landing.
      await hoverSaveButton()
      expect(overlay().textContent).not.toContain('button "Save"')
    } finally {
      now.mockRestore()
    }
  })
})

describe('the redesigned chrome (item C)', () => {
  it('#469: Inspect and X-Ray are one fused capsule, and the feature is named on it', async () => {
    await renderPane('on')
    const capsule = container.querySelector('[data-testid="canvas-inspect-capsule"]')!
    expect(capsule, 'the fused capsule').toBeTruthy()
    // Both halves live INSIDE the one bordered control...
    expect(capsule.querySelector('[data-testid="canvas-tool-inspect"]')).toBeTruthy()
    expect(capsule.querySelector('[data-testid="canvas-xray-mode"]')).toBeTruthy()
    // ...and the segment carries the feature's name.
    expect(capsule.textContent).toContain('X-RAY')
  })

  it('leads with the mode as the title, with a keel line', async () => {
    await renderPane('on')
    // A 'design' version reads as MOCKUP MODE (plan/uat are the other two).
    const word = container.querySelector('[data-testid="canvas-mode-word"]')
    expect(word?.textContent).toBe('MOCKUP MODE')
    expect(word?.getAttribute('data-canvas-mode')).toBe('design')
    expect(container.querySelector('[data-testid="canvas-mode-keel"]')).not.toBeNull()
  })

  it('presents Inspect / Sketch / Region as tool chips, Inspect active in browse', async () => {
    await renderPane('on')
    expect(container.querySelector('[data-testid="canvas-tool-inspect"]')?.getAttribute('aria-pressed')).toBe('true')
    expect(container.querySelector('[data-testid="canvas-tool-sketch"]')?.getAttribute('aria-pressed')).toBe('false')
    expect(container.querySelector('[data-testid="canvas-tool-region"]')?.getAttribute('aria-pressed')).toBe('false')
  })

  it('moves the active chip to Sketch when the pointer goes to the glass', async () => {
    await renderPane('on')
    await act(async () => useCanvasStore.getState().setInteractionMode(SID, 'draw'))
    expect(container.querySelector('[data-testid="canvas-tool-inspect"]')?.getAttribute('aria-pressed')).toBe('false')
    expect(container.querySelector('[data-testid="canvas-tool-sketch"]')?.getAttribute('aria-pressed')).toBe('true')
  })

  it('carries the X-ray setting inside the Inspect group', async () => {
    await renderPane('stealth')
    const chips = container.querySelector('[data-testid="canvas-tool-chips"]')!
    // The x-ray group is a descendant of the tool chips, not a separate control.
    expect(chips.querySelector('[data-testid="canvas-xray-mode"]')).not.toBeNull()
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
