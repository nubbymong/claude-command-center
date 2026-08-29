// @vitest-environment jsdom
//
// Testing mode's evidence, as the PANE owns it (M3).
//
// The claim this file exists to hold up: in Testing mode a note is a locked
// record of a screen, and everywhere else nothing of the kind happens. So each
// behaviour is asserted twice — once on a `uat` version and once on a mockup,
// where the shield, the capture and the trail must all be absent.
//
// Everything is driven through the real pane, the real store and the real DOM.
// The notes panel is a stub that records the props it was handed, because what
// is under test here is the pane's half of the seam: when the capture happens,
// what it carries, and what the site does while it is pending.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { CanvasReviewState, CanvasState, CanvasVersion } from '../../../src/shared/canvas'
import { defaultPackName } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@excalidraw/excalidraw', () => ({
  Excalidraw: () => null,
  restoreElements: (els: unknown) => els,
  exportToBlob: vi.fn(),
  sceneCoordsToViewportCoords: () => ({ x: 0, y: 0 }),
  viewportCoordsToSceneCoords: () => ({ x: 0, y: 0 }),
}))
vi.mock('../../../src/renderer/utils/config-saver', () => ({ saveConfigNow: vi.fn(async () => true) }))

/** A page that describes itself: one filled field, one dialog, a focus and a
 *  route. Sanitised for real on the way in — this is the RAW reply. */
const SNAPSHOT_REPLY = {
  viewport: { width: 800, height: 600, dpr: 1 },
  page: { pathname: '/checkout', hash: '', title: 'Checkout' },
  focusedRef: 'e2',
  root: {
    ref: 'e1',
    role: 'document',
    name: '',
    box: { x: 0, y: 0, width: 800, height: 600 },
    children: [
      {
        ref: 'e2',
        role: 'textbox',
        name: 'Email',
        box: { x: 10, y: 10, width: 200, height: 30 },
        state: { type: 'email', valueLength: 12 },
        children: [],
      },
      {
        ref: 'e3',
        role: 'dialog',
        name: 'Confirm order',
        box: { x: 0, y: 0, width: 400, height: 200 },
        children: [],
      },
    ],
  },
}
const askFrame = vi.fn(async () => SNAPSHOT_REPLY)
vi.mock('../../../src/renderer/canvas/canvas-frame-rpc', () => ({
  askCanvasFrame: (...args: unknown[]) => askFrame(...(args as [])),
  framesInFlight: () => 0,
  MAX_FRAME_REQUESTS_IN_FLIGHT: 4,
}))

interface ChannelHandlers {
  onReady: () => void
  onViewport: (vp: { scrollX: number; scrollY: number; width: number; height: number; dpr: number; scale: number }) => void
  onContentClick: (x: number, y: number, hit: unknown) => void
  onTypedInto: (hit: unknown) => void
  onNavigated: (route: string) => void
}
const createChannel = vi.fn(() => vi.fn())
vi.mock('../../../src/renderer/canvas/canvas-inbound-channel', () => ({
  createCanvasInboundChannel: (...args: unknown[]) => createChannel(...(args as [])),
  INBOUND_FLOOD_BUDGET: 600,
  INBOUND_FLOOD_WINDOW_MS: 1000,
  MAX_INBOUND_TRAIL_PER_FRAME: 8,
  reportedKeyIsPlausible: () => true,
  reportedClickIsPlausible: () => true,
}))

/** The evidence seam the pane hands the panel — captured, then driven. */
interface EvidenceSeam {
  pending: { evidenceId: string; previewDataUrl?: string } | null
  notice: string | null
  begin: () => void
  discard: () => void
  lock: (annotationId: string) => void
  adopt: (evidenceId: string) => void
  registerCancel: (fn: (() => void) | null) => void
  runTrail: () => unknown[]
  endRun: () => void
}
let panelProps: { evidence?: EvidenceSeam } | null = null
vi.mock('../../../src/renderer/components/CanvasNotesPanel', () => ({
  default: (props: { evidence?: EvidenceSeam }) => {
    panelProps = props
    return null
  },
}))

const AgentCanvasPane = (await import('../../../src/renderer/components/AgentCanvasPane')).default
const { useCanvasStore } = await import('../../../src/renderer/stores/canvasStore')
const { useCanvasReviewStore } = await import('../../../src/renderer/stores/canvasReviewStore')
const { useSettingsStore, DEFAULT_SETTINGS } = await import('../../../src/renderer/stores/settingsStore')
const { useSessionStore } = await import('../../../src/renderer/stores/sessionStore')
const trail = await import('../../../src/renderer/canvas/canvas-trail')

const SID = 'session-1'
const CANVAS = 'canvas-1'

const uatVersion = (over: Partial<CanvasVersion> = {}): CanvasVersion =>
  ({
    id: 'v1',
    mode: 'uat',
    createdAt: '2026-08-29T10:00:00Z',
    source: { mode: 'uat', distRoot: 'C:/build', entry: 'index.html', buildLabel: '5' },
    ...over,
  }) as CanvasVersion
const designVersion = (): CanvasVersion =>
  ({
    id: 'v1',
    mode: 'design',
    createdAt: '2026-08-29T10:00:00Z',
    source: { mode: 'design', entry: 'index.html' },
  }) as CanvasVersion

let versions: CanvasVersion[] = [uatVersion()]
let reviewState: CanvasReviewState | null = null
/** The canvas SUBJECT main answers with. Seeded through `seed()` so the pane’s
 *  own refresh cannot overwrite what a test set up. */
let canvasTitle: string | undefined
/** Which version MAIN says is active. The pane refreshes on mount, so a seeded
 *  store alone is overwritten — main has to agree. */
let mainActiveVersionId = 'v1'

const evidenceCapture = vi.fn(async () => ({
  ok: true as const,
  evidenceId: '0123456789abcdef01234567',
  previewDataUrl: 'data:image/png;base64,AAAA',
  width: 800,
  height: 600,
}))
const evidenceDiscard = vi.fn(async () => ({ ok: true }))
const setPackName = vi.fn(async () => ({ canvasId: CANVAS, sessionId: SID, activeVersionId: 'v1', versions }) as CanvasState)
const evidenceRead = vi.fn(async () => ({ dataUrl: 'data:image/png;base64,SHOT' }))

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  pty: { ...((globalThis as any).window?.electronAPI?.pty ?? {}), write: vi.fn() },
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    getState: vi.fn(async () => ({ canvasId: CANVAS, sessionId: SID, activeVersionId: mainActiveVersionId, versions, ...(canvasTitle ? { title: canvasTitle } : {}) }) as CanvasState),
    reviewGetState: vi.fn(async () => reviewState),
    listReclaimable: vi.fn(async () => []),
    onChanged: vi.fn(() => () => {}),
    onReviewChanged: vi.fn(() => () => {}),
    onSnapshotRequest: vi.fn(() => () => {}),
    onFrameNavigated: vi.fn(() => () => {}),
    evidenceCapture,
    evidenceDiscard,
    evidenceRead,
    setPackName,
  },
}

let container: HTMLDivElement
let root: Root

function seed(over: { title?: string; activeVersionId?: string } = {}): void {
  canvasTitle = over.title
  mainActiveVersionId = over.activeVersionId ?? 'v1'
  useCanvasStore.setState({
    bySessionId: {
      [SID]: {
        canvasId: CANVAS,
        versions,
        activeVersionId: over.activeVersionId ?? 'v1',
        ...(over.title ? { title: over.title } : {}),
        interactionMode: 'browse',
        emptyView: 'intro',
        unseenRender: false,
        loaded: true,
      },
    },
  })
}

/** The session as the sidebar holds it — the pack name's first input. */
function seedSession(over: { label?: string; customName?: string } = {}): void {
  useSessionStore.setState({
    sessions: [
      {
        id: SID,
        label: over.label ?? 'default',
        ...(over.customName ? { customName: over.customName } : {}),
        workingDirectory: 'C:/project',
        model: 'sonnet',
        color: '#89b4fa',
        status: 'idle',
        createdAt: 0,
        sessionType: 'claude',
      } as never,
    ],
  })
}

beforeEach(() => {
  versions = [uatVersion()]
  reviewState = null
  canvasTitle = undefined
  mainActiveVersionId = 'v1'
  panelProps = null
  createChannel.mockClear()
  askFrame.mockClear()
  evidenceCapture.mockClear()
  evidenceDiscard.mockClear()
  evidenceRead.mockClear()
  setPackName.mockClear()
  trail.resetAllTrails()
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS } })
  useCanvasStore.setState({ sketchByCanvasId: {} })
  useCanvasReviewStore.setState({ bySessionId: {} })
  seedSession()
  seed()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  trail.resetAllTrails()
})

async function render(): Promise<void> {
  await act(async () => {
    root.render(<AgentCanvasPane sessionId={SID} isActive />)
  })
  // jsdom measures everything as zero, and the capture refuses a rectangle it
  // cannot believe in. Give the frame a real box, once, where the pane reads it.
  const frameEl = byTestId('canvas-content-frame')
  if (frameEl) {
    frameEl.getBoundingClientRect = (() => ({
      x: 12,
      y: 34,
      left: 12,
      top: 34,
      right: 812,
      bottom: 634,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    })) as typeof frameEl.getBoundingClientRect
  }
  // A live frame announces itself before anything asks it questions — and the
  // pane only asks a frame that has. Without this the stamp would arrive with
  // no tree, which is a real case with its own test, not the default one.
  if (createChannel.mock.calls.length > 0) {
    await act(async () => {
      channelHandlers().onReady()
      await Promise.resolve()
      await Promise.resolve()
    })
  }
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`)
}

function channelHandlers(): ChannelHandlers {
  const last = createChannel.mock.calls[createChannel.mock.calls.length - 1]?.[0] as { handlers: ChannelHandlers }
  return last.handlers
}

/** Start a note the way the composer does. */
async function startNote(): Promise<void> {
  await act(async () => {
    panelProps?.evidence?.begin()
  })
  // The capture waits a frame for the host's own layers to come off the page.
  await act(async () => {
    await new Promise<void>((r) => requestAnimationFrame(() => r()))
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('the pause shield', () => {
  it('mounts as the LAST child of the content frame once a capture is held', async () => {
    await render()
    expect(byTestId('canvas-pause-shield')).toBeNull()

    await startNote()

    const shield = byTestId('canvas-pause-shield')
    expect(shield).not.toBeNull()
    const frameEl = byTestId('canvas-content-frame')!
    // Last child: it has to cover the iframe, the glass AND the highlight
    // overlay, or the "inputs are blocked" promise is only true of some of them.
    expect(frameEl.lastElementChild).toBe(shield)
    expect(shield!.getAttribute('data-canvas-layer')).toBe('shield')
  })

  it('says exactly what saving will keep, and says it only here', async () => {
    await render()
    await startNote()
    const shield = byTestId('canvas-pause-shield')!
    expect(shield.textContent).toContain('Paused — writing a note')
    expect(shield.textContent).toContain('Inputs are blocked until you save or cancel')
    // The whole pane says it ONCE.
    const occurrences = (container.textContent ?? '').split('Inputs are blocked').length - 1
    expect(occurrences).toBe(1)
  })

  it('swallows the pointer and the wheel, so the frozen screen cannot move', async () => {
    await render()
    await startNote()
    const shield = byTestId('canvas-pause-shield')!

    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    shield.dispatchEvent(down)
    expect(down.defaultPrevented).toBe(true)

    // React's own wheel handling at the root is PASSIVE, so this has to be a
    // native listener or the promise on the card is not true.
    const wheel = new Event('wheel', { bubbles: true, cancelable: true })
    shield.dispatchEvent(wheel)
    expect(wheel.defaultPrevented).toBe(true)
  })

  it('takes keyboard focus out of the frame while the site is paused', async () => {
    await render()
    const iframe = container.querySelector('iframe') as HTMLIFrameElement
    iframe.focus()
    expect(document.activeElement).toBe(iframe)
    await startNote()
    expect(document.activeElement).not.toBe(iframe)
  })

  it('hides the host layers for the shot, then puts them back', async () => {
    await render()
    const glass = container.querySelector('[data-canvas-layer="glass"]') as HTMLElement
    const overlay = container.querySelector('[data-canvas-layer="overlay"]') as HTMLElement
    expect(glass.style.visibility).toBe('')

    // Mid-capture: the reply is held, so the layers must be off the page.
    let release: (v: unknown) => void = () => {}
    askFrame.mockImplementationOnce(() => new Promise((r) => (release = r)) as Promise<typeof SNAPSHOT_REPLY>)
    await act(async () => {
      panelProps?.evidence?.begin()
    })
    await act(async () => {
      await new Promise<void>((r) => requestAnimationFrame(() => r()))
    })
    expect(glass.style.visibility).toBe('hidden')
    expect(overlay.style.visibility).toBe('hidden')

    await act(async () => {
      release(SNAPSHOT_REPLY)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(glass.style.visibility).toBe('')
    expect(overlay.style.visibility).toBe('')
  })
})

describe('the capture', () => {
  it('happens once, with the frame rect, the stamp and the trail slice', async () => {
    await render()
    // Two clicks, so the slice has something in it.
    await act(async () => {
      channelHandlers().onContentClick(4, 5, { role: 'button', name: 'Checkout', tag: 'button', box: { x: 0, y: 0, width: 1, height: 1 } })
    })
    await startNote()
    // A second trigger while one is held must not take a second shot.
    await startNote()

    expect(evidenceCapture).toHaveBeenCalledTimes(1)
    const args = evidenceCapture.mock.calls[0][0] as unknown as {
      sessionId: string
      canvasId: string
      versionId: string
      rect: { x: number; y: number; width: number; height: number }
      stamp: { route?: string; fields: Array<{ name: string; fill: string }>; dialogs: unknown[]; focused?: { name: string } }
      trail: Array<{ kind: string }>
    }
    expect(args).toMatchObject({ sessionId: SID, canvasId: CANVAS, versionId: 'v1' })
    expect(args.rect).toEqual({ x: 12, y: 34, width: 800, height: 600 })
    expect(args.stamp.route).toBe('/checkout')
    expect(args.stamp.fields).toEqual([{ role: 'textbox', name: 'Email', fill: 'filled' }])
    expect(args.stamp.dialogs).toHaveLength(1)
    expect(args.stamp.focused).toMatchObject({ name: 'Email' })
    expect(args.trail.map((e) => e.kind)).toEqual(['click'])
  })

  it('never puts a typed value in the stamp it sends', async () => {
    await render()
    await startNote()
    const args = evidenceCapture.mock.calls[0][0]
    const serialised = JSON.stringify((args as unknown as { stamp: unknown }).stamp)
    expect(serialised).not.toContain('valueLength')
    expect(serialised).not.toContain('"value"')
  })

  it('says why in plain words when main refuses, and lets the note be written anyway', async () => {
    await render()
    evidenceCapture.mockResolvedValueOnce({ ok: false, reason: 'pack-full' } as never)
    await startNote()
    expect(panelProps?.evidence?.pending).toBeNull()
    expect(panelProps?.evidence?.notice).toBe('Evidence limit reached — delete a note or end the run.')
    // No shot means no frozen screen to protect.
    expect(byTestId('canvas-pause-shield')).toBeNull()
  })

  it('survives a frame that will not describe itself — viewport and clock still ride', async () => {
    await render()
    await act(async () => {
      channelHandlers().onViewport({ scrollX: 0, scrollY: 240, width: 800, height: 600, dpr: 2, scale: 1 })
    })
    askFrame.mockRejectedValueOnce(new Error('busy'))
    await startNote()
    const stamp = (evidenceCapture.mock.calls[0][0] as unknown as { stamp: { viewport: { scrollY: number }; fields: unknown[] } }).stamp
    expect(stamp.viewport.scrollY).toBe(240)
    expect(stamp.fields).toEqual([])
    expect(panelProps?.evidence?.pending).not.toBeNull()
  })

  it('discards the pending shot on cancel, and on Escape', async () => {
    await render()
    await startNote()
    await act(async () => {
      panelProps?.evidence?.discard()
    })
    expect(evidenceDiscard).toHaveBeenCalledWith({ sessionId: SID, canvasId: CANVAS, evidenceId: '0123456789abcdef01234567' })
    expect(byTestId('canvas-pause-shield')).toBeNull()

    // Escape goes through the panel's own cancel when it has registered one, so
    // the key does exactly what the button does.
    const cancel = vi.fn()
    await act(async () => {
      panelProps?.evidence?.registerCancel(cancel)
    })
    await startNote()
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('honours Escape FROM the composer — where the user`s hands actually are', async () => {
    await render()
    const cancel = vi.fn()
    await act(async () => {
      panelProps?.evidence?.registerCancel(cancel)
    })
    await startNote()
    // A textarea target: every other host key here refuses one, and this must
    // not, or the shield names a key it does not honour.
    const box = document.createElement('textarea')
    document.body.appendChild(box)
    await act(async () => {
      const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
      Object.defineProperty(event, 'target', { value: box })
      window.dispatchEvent(event)
    })
    box.remove()
    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('steps aside for the glass in draw mode, so a mark can still be made', async () => {
    await render()
    await startNote()
    expect(byTestId('canvas-pause-shield')!.getAttribute('data-shield-passthrough')).toBeNull()
    await act(async () => {
      useCanvasStore.getState().setInteractionMode(SID, 'draw')
    })
    expect(byTestId('canvas-pause-shield')!.getAttribute('data-shield-passthrough')).toBe('true')
    expect(byTestId('canvas-pause-shield')!.style.pointerEvents).toBe('none')
  })

  it('takes the shield down when the note locks it, and cuts the trail there', async () => {
    await render()
    await act(async () => {
      channelHandlers().onContentClick(1, 1, null)
    })
    await startNote()
    await act(async () => {
      panelProps?.evidence?.lock('a1')
    })
    expect(byTestId('canvas-pause-shield')).toBeNull()
    // The marker is on the run, and the next note's slice starts after it.
    const run = panelProps!.evidence!.runTrail() as Array<{ kind: string }>
    expect(run.map((e) => e.kind)).toEqual(['click', 'note'])
  })

  it('re-raises the shield for a capture that survived a pane switch', async () => {
    await render()
    await act(async () => {
      panelProps?.evidence?.adopt('ffffffffffffffffffffffff')
    })
    expect(byTestId('canvas-pause-shield')).not.toBeNull()
    expect(panelProps?.evidence?.pending).toEqual({ evidenceId: 'ffffffffffffffffffffffff' })
  })
})

describe('the action trail', () => {
  it('records clicks, typing and navigation as identity and timing only', async () => {
    await render()
    await act(async () => {
      const h = channelHandlers()
      h.onContentClick(4, 5, { role: 'button', name: 'Checkout', tag: 'button', box: { x: 0, y: 0, width: 1, height: 1 } })
      h.onTypedInto({ role: 'textbox', name: 'Email', tag: 'input', uxId: 'email', box: { x: 0, y: 0, width: 1, height: 1 } })
      h.onNavigated('/checkout#pay')
    })
    const run = panelProps!.evidence!.runTrail()
    expect(run.map((e) => (e as { kind: string }).kind)).toEqual(['click', 'typed', 'navigate'])
    expect(JSON.stringify(run)).toContain('Checkout')
    expect(JSON.stringify(run)).not.toContain('valueLength')
  })

  it('keeps recording with x-ray OFF — the mode is about drawing, not about evidence', async () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, canvasXrayMode: 'off' } })
    await render()
    await act(async () => {
      channelHandlers().onContentClick(4, 5, { role: 'link', name: 'Cart', tag: 'a', box: { x: 0, y: 0, width: 1, height: 1 } })
    })
    const run = panelProps!.evidence!.runTrail()
    expect(run).toHaveLength(1)
  })

  it('ends the run on request, so a submitted round does not bleed into the next', async () => {
    await render()
    await act(async () => {
      channelHandlers().onContentClick(1, 1, null)
    })
    expect(panelProps!.evidence!.runTrail()).toHaveLength(1)
    await act(async () => {
      panelProps!.evidence!.endRun()
    })
    expect(panelProps!.evidence!.runTrail()).toHaveLength(0)
  })
})

describe('the test pack has a name', () => {
  it('derives it from the SAME inputs main does — config label first, title second', async () => {
    // One pack must not wear two names. Main builds this from the session's
    // config label (off its spawn record) and falls back to the canvas title;
    // the pane has to derive from the same two, in the same order, or the
    // agent's reply and the header disagree about which run is which.
    seedSession({ label: 'Checkout config' })
    seed({ title: 'Checkout flow' })
    await render()
    const expected = defaultPackName({
      configName: 'Checkout config',
      title: 'Checkout flow',
      buildLabel: '5',
      versionId: 'v1',
      at: '2026-08-29T10:00:00Z',
    })
    expect(byTestId('canvas-pack-name')!.textContent).toBe(expected)
    // ...and it really is the config label doing the work, not the title.
    expect(expected.startsWith('Checkout config · build 5 · ')).toBe(true)
  })

  it('prefers the user`s own session name, and reads "default" as no name at all', async () => {
    // Both rules are main's: TerminalView sends `customName || label ||
    // 'default'` into the spawn record, and main treats the literal 'default'
    // as absent rather than as a config actually called "default".
    seedSession({ label: 'Checkout config', customName: 'Smoke run' })
    seed({ title: 'Checkout flow' })
    await render()
    expect(byTestId('canvas-pack-name')!.textContent).toContain('Smoke run · build 5 · ')

    await act(() => root.unmount())
    root = createRoot(container)
    seedSession({ label: 'default' })
    seed({ title: 'Checkout flow' })
    await render()
    expect(byTestId('canvas-pack-name')!.textContent).toContain('Checkout flow · build 5 · ')
  })

  it('does NOT persist the derived default when Enter is pressed on an untouched name', async () => {
    // The box is seeded with the derivation, so Enter on it would freeze
    // today's build label and today's date into the record for good — the one
    // thing a derived-never-stored default exists to prevent.
    await render()
    await act(async () => {
      byTestId('canvas-pack-name')!.click()
    })
    const input = byTestId('canvas-pack-name-input') as HTMLInputElement
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(setPackName).not.toHaveBeenCalled()
    // The chip is back, still showing the derivation rather than a frozen copy.
    expect(byTestId('canvas-pack-name')!.textContent).toContain('build 5')
  })

  it('derives one, and renames in place', async () => {
    await render()
    const chip = byTestId('canvas-pack-name')!
    expect(chip.textContent).toContain('build 5')

    await act(async () => {
      chip.click()
    })
    const input = byTestId('canvas-pack-name-input') as HTMLInputElement
    expect(input).not.toBeNull()
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, 'Checkout smoke')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(setPackName).toHaveBeenCalledWith({ sessionId: SID, canvasId: CANVAS, versionId: 'v1', name: 'Checkout smoke' })
  })

  it('an emptied box means "go back to the derived default", not a blank name', async () => {
    versions = [uatVersion({ packName: 'Old name' } as Partial<CanvasVersion>)]
    seed()
    await render()
    await act(async () => {
      byTestId('canvas-pack-name')!.click()
    })
    const input = byTestId('canvas-pack-name-input') as HTMLInputElement
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, '   ')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(setPackName).toHaveBeenCalledWith({ sessionId: SID, canvasId: CANVAS, versionId: 'v1', name: null })
  })
})

describe('History says what the run actually was', () => {
  /** A decided v1 plus an OPEN v2, so the pane stays on the live stage and the
   *  picker — not the recall view — is the thing under test. */
  function seedRun(observationNotes: number): void {
    versions = [
      uatVersion({ id: 'v1', verdict: { state: 'approved', at: '2026-08-29T17:00:00Z', by: 'user' } } as Partial<CanvasVersion>),
      uatVersion({ id: 'v2', createdAt: '2026-08-29T18:00:00Z' } as Partial<CanvasVersion>),
    ]
    const annotations = Array.from({ length: observationNotes }, (_, k) => ({
      id: `a${k + 1}`,
      reviewId: 'R1',
      scope: 'general',
      note: `observation ${k + 1}`,
      versionId: 'v1',
      state: 'observation',
    }))
    useCanvasReviewStore.setState({
      bySessionId: {
        [SID]: {
          canvasId: CANVAS,
          reviews: [
            {
              id: 'R1',
              canvas: { canvasId: CANVAS, sessionId: SID },
              versionId: 'v1',
              annotationIds: annotations.map((a) => a.id),
              status: 'resolved',
              createdAt: '2026-08-29T16:00:00Z',
              submittedAt: '2026-08-29T17:00:00Z',
              decision: 'approve',
            },
          ],
          annotations,
          composer: null,
          loaded: true,
          focus: null,
          focusChain: [],
          focusChainIndex: 0,
          marqueeArmed: false,
          editingAnnotationId: null,
          resolution: null,
          panelHighlight: null,
          helpDismissed: false,
        } as never,
      },
    })
    seed({ activeVersionId: 'v2' })
  }

  async function badgeForV1(): Promise<string> {
    await render()
    await act(async () => {
      ;(byTestId('canvas-history-button') as HTMLButtonElement).click()
    })
    return byTestId('canvas-history-badge-v1')!.textContent ?? ''
  }

  it('says PASSED WITH OBSERVATIONS when the pass carried notes', async () => {
    // The label was in the shared vocabulary and unreachable from here: History
    // had no way to count the notes, so a pass carrying two the user wrote for
    // the agent read as a plain pass — the row hiding the only thing on it that
    // still wanted reading.
    seedRun(2)
    expect(await badgeForV1()).toBe('PASSED WITH OBSERVATIONS')
  })

  it('says a plain PASSED when it carried none', async () => {
    seedRun(0)
    expect(await badgeForV1()).toBe('PASSED')
  })
})

describe('a mockup is untouched by any of it', () => {
  beforeEach(() => {
    versions = [designVersion()]
    seed()
  })

  it('hands the panel no evidence seam at all', async () => {
    await render()
    expect(panelProps?.evidence).toBeUndefined()
  })

  it('has no pack chip, no End test, and no shield', async () => {
    await render()
    expect(byTestId('canvas-pack-name')).toBeNull()
    expect(byTestId('canvas-end-test')).toBeNull()
    expect(byTestId('canvas-pause-shield')).toBeNull()
  })

  it('captures nothing and records no trail, whatever the page reports', async () => {
    await render()
    await act(async () => {
      const h = channelHandlers()
      h.onContentClick(4, 5, { role: 'button', name: 'Checkout', tag: 'button', box: { x: 0, y: 0, width: 1, height: 1 } })
      h.onTypedInto({ role: 'textbox', name: 'Email', tag: 'input', box: { x: 0, y: 0, width: 1, height: 1 } })
      h.onNavigated('/elsewhere')
      h.onViewport({ scrollX: 0, scrollY: 900, width: 800, height: 600, dpr: 1, scale: 1 })
    })
    expect(evidenceCapture).not.toHaveBeenCalled()
    expect(trail.trailForRun(CANVAS, 'v1')).toEqual([])
  })
})

describe('a submitted run opens as evidence, never as the live site', () => {
  beforeEach(() => {
    versions = [
      uatVersion({
        verdict: { state: 'rejected', at: '2026-08-29T17:00:00Z', by: 'user' },
      } as Partial<CanvasVersion>),
    ]
    reviewState = {
      canvasId: CANVAS,
      sessionId: SID,
      reviews: [
        {
          id: 'R1',
          canvas: { canvasId: CANVAS, sessionId: SID },
          versionId: 'v1',
          annotationIds: ['a1'],
          status: 'submitted',
          createdAt: '2026-08-29T16:00:00Z',
          submittedAt: '2026-08-29T17:00:00Z',
          decision: 'reject',
        },
      ],
      annotations: [
        {
          id: 'a1',
          reviewId: 'R1',
          scope: 'general',
          note: 'Button stays disabled after fixing the email',
          versionId: 'v1',
          state: 'open',
          evidence: {
            shotPath: 'reviews/evidence/a1.png',
            width: 800,
            height: 600,
            stamp: {
              capturedAt: '2026-08-29T16:44:02.000Z',
              route: '/checkout',
              viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, dpr: 1, zoom: 1 },
              dialogs: [{ role: 'dialog', name: 'Confirm order' }],
              fields: [{ role: 'textbox', name: 'Email', fill: 'filled' }],
            },
            trail: [{ at: '2026-08-29T16:43:58.000Z', gapMs: 0, kind: 'click', target: { role: 'button', name: 'Checkout' } }],
          },
        },
      ],
    } as unknown as CanvasReviewState
    useCanvasReviewStore.setState({
      bySessionId: {
        [SID]: {
          canvasId: CANVAS,
          reviews: reviewState.reviews,
          annotations: reviewState.annotations,
          composer: null,
          loaded: true,
          focus: null,
          focusChain: [],
          focusChainIndex: 0,
          marqueeArmed: false,
          editingAnnotationId: null,
          resolution: null,
          panelHighlight: null,
          helpDismissed: false,
        } as never,
      },
    })
    seed()
  })

  it('replaces the stage with the pack — no iframe anywhere', async () => {
    await render()
    expect(byTestId('canvas-recall')).not.toBeNull()
    expect(container.querySelector('iframe')).toBeNull()
    expect(byTestId('canvas-recall-verdict')!.textContent).toBe('FAILED')
    expect(byTestId('canvas-recall-pack-name')!.textContent).toContain('build 5')
  })

  it('offers the LIBRARY as the way back when the canvas holds nothing else', async () => {
    await render()
    expect(byTestId('canvas-recall-back')!.textContent).toContain('Library')
  })

  it('offers the CANVAS instead when there is still something live to show', async () => {
    // Recall replaces the whole stage, History control included — so a pack
    // reached by stepping must not be a room with one exit.
    versions = [
      versions[0],
      uatVersion({ id: 'v2', createdAt: '2026-08-29T18:00:00Z' } as Partial<CanvasVersion>),
    ]
    seed()
    await render()
    const back = byTestId('canvas-recall-back')!
    expect(back.textContent).toContain('Canvas')
    // Main answers the switch, so the assertion is about what the pane does
    // with a real answer rather than about a call that silently failed.
    const setActiveVersion = vi.fn(async () => ({
      canvasId: CANVAS,
      sessionId: SID,
      activeVersionId: 'v2',
      versions,
    }))
    ;(window.electronAPI.canvas as unknown as { setActiveVersion: unknown }).setActiveVersion = setActiveVersion
    await act(async () => {
      back.click()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(setActiveVersion).toHaveBeenCalledWith({ sessionId: SID, versionId: 'v2' })
    expect(byTestId('canvas-recall')).toBeNull()
    expect(container.querySelector('iframe')).not.toBeNull()
  })

  it('reads the saved screen back through the evidence channel', async () => {
    await render()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(evidenceRead).toHaveBeenCalledWith({ sessionId: SID, canvasId: CANVAS, path: 'reviews/evidence/a1.png' })
  })
})
