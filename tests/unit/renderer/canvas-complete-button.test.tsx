// @vitest-environment jsdom
//
// The subject-level sign-off control (#476). What these pin:
//
//  - The button is BLOCKED (visible, disabled, explaining itself) while
//    anything is owed either way — drafts, open rounds, verdicts owed, a
//    ready render awaiting its first review — over the same review mirror
//    the panel renders, so button and panel cannot disagree.
//  - Two-step with the #456 double-click guard; the confirm names the subject.
//  - A refused completion (main moved under us) surfaces its reason in place.
//  - On a completed canvas the slot shows the Completed chip + one-click
//    Reopen instead of the working control.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { Annotation, Review } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const CanvasCompleteButton = (await import('../../../src/renderer/components/CanvasCompleteButton')).default
const { useCanvasStore } = await import('../../../src/renderer/stores/canvasStore')
const { useCanvasReviewStore } = await import('../../../src/renderer/stores/canvasReviewStore')

const SID = 'session-complete'
const CID = 'canvas-a'

const complete = vi.fn(async (_args: { sessionId: string; canvasId: string }) => ({ ok: true }))
const completeReopen = vi.fn(async (_args: { sessionId: string; canvasId: string }) => ({ ok: true }))
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    complete: (args: { sessionId: string; canvasId: string }) => complete(args),
    completeReopen: (args: { sessionId: string; canvasId: string }) => completeReopen(args),
  },
}

const review = (id: string, status: Review['status'], annotationIds: string[] = []): Review => ({
  id,
  canvas: { canvasId: CID, sessionId: SID },
  versionId: 'v1',
  annotationIds,
  status,
  createdAt: '2026-08-25T10:00:00Z',
  ...(status !== 'draft' ? { submittedAt: '2026-08-25T10:00:30Z' } : {}),
})

const note = (id: string, reviewId: string, state: Annotation['state']): Annotation => ({
  id, reviewId, scope: 'general', note: `text ${id}`, versionId: 'v1', state,
})

/** Seed the two mirrors the button reads. */
function seed(opts: {
  reviews?: Review[]
  annotations?: Annotation[]
  awaitingReview?: boolean
  completed?: { at: string; by: 'user' | 'agent' }
  versions?: Array<{ id: string; draft?: true; show?: true }>
}): void {
  useCanvasStore.setState({
    bySessionId: {
      [SID]: {
        canvasId: CID,
        versions: (opts.versions ?? []).map((v) => ({
          mode: 'design', createdAt: '2026-08-27T10:00:00Z', source: { mode: 'design', entry: 'index.html' }, ...v,
        })),
        activeVersionId: 'v1',
        interactionMode: 'browse',
        emptyView: 'intro',
        unseenRender: false,
        filedNotice: null,
        completedNotice: null,
        loaded: true,
        ...(opts.awaitingReview ? { awaitingReview: { versionId: 'v1', at: 'now' } } : {}),
        ...(opts.completed ? { completed: opts.completed } : {}),
      },
    },
  } as any)
  useCanvasReviewStore.setState({
    bySessionId: {
      [SID]: {
        loaded: true,
        canvasId: CID,
        reviews: opts.reviews ?? [],
        annotations: opts.annotations ?? [],
      },
    },
  } as any)
}

let container: HTMLDivElement
let root: Root
let nowSpy: ReturnType<typeof vi.spyOn> | null = null

function passGuard(): void {
  const later = Date.now() + 60_000
  nowSpy?.mockRestore()
  nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => later)
}

async function render(): Promise<void> {
  await act(async () => {
    root.render(<CanvasCompleteButton sessionId={SID} canvasId={CID} title="Quick Start rows" />)
  })
}

const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null

async function click(el: Element | null): Promise<void> {
  expect(el).toBeTruthy()
  await act(async () => (el as HTMLElement).click())
}

beforeEach(() => {
  complete.mockClear()
  completeReopen.mockClear()
  complete.mockResolvedValue({ ok: true })
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

describe('when it is offered', () => {
  it('is enabled when nothing is owed either way', async () => {
    seed({ reviews: [review('R1', 'resolved')], annotations: [note('a1', 'R1', 'approved')] })
    await render()
    expect(byId('canvas-complete-arm')!.disabled).toBe(false)
  })

  it('blocks on an open round and says so', async () => {
    seed({ reviews: [review('R1', 'submitted')], annotations: [note('a1', 'R1', 'open')] })
    await render()
    const arm = byId('canvas-complete-arm')!
    expect(arm.disabled).toBe(true)
    expect(arm.title).toContain('still open')
  })

  it('blocks on unsubmitted draft notes, naming the sharper loss first', async () => {
    seed({ reviews: [review('R1', 'draft', ['a1'])], annotations: [note('a1', 'R1', 'open')] })
    await render()
    const arm = byId('canvas-complete-arm')!
    expect(arm.disabled).toBe(true)
    expect(arm.title).toContain('unsubmitted')
  })

  it('blocks while a ready render awaits the first review', async () => {
    seed({ awaitingReview: true })
    await render()
    const arm = byId('canvas-complete-arm')!
    expect(arm.disabled).toBe(true)
    expect(arm.title).toContain('first review')
  })
})

describe('the two-step', () => {
  it('arms to a confirm that names the subject, and a double-click cannot fire it (#456)', async () => {
    seed({})
    await render()
    await click(byId('canvas-complete-arm'))
    const confirm = byId('canvas-complete-confirm')!
    expect(confirm.textContent).toContain('“Quick Start rows”')
    await click(confirm)
    expect(complete).not.toHaveBeenCalled()

    passGuard()
    await click(byId('canvas-complete-confirm'))
    expect(complete).toHaveBeenCalledWith({ sessionId: SID, canvasId: CID })
  })

  it('surfaces a refusal from main in place and disarms', async () => {
    seed({})
    complete.mockResolvedValueOnce({ ok: false, reason: 'not everything is settled: 1 note awaiting your verdict' } as any)
    await render()
    await click(byId('canvas-complete-arm'))
    passGuard()
    await click(byId('canvas-complete-confirm'))
    expect(byId('canvas-complete-confirm')).toBeNull()
    expect(container.querySelector('[data-testid="canvas-complete-refused"]')!.textContent).toContain('not everything is settled')
  })
})

describe('on a completed canvas', () => {
  it('shows the chip with provenance and a one-click Reopen instead', async () => {
    seed({ completed: { at: 'now', by: 'agent' } })
    await render()
    expect(byId('canvas-complete-arm')).toBeNull()
    const chip = container.querySelector('[data-testid="canvas-completed-chip"]')!
    expect(chip.textContent).toContain('Completed')
    expect((chip as HTMLElement).title).toContain('on your instruction')
    await click(byId('canvas-completed-reopen'))
    expect(completeReopen).toHaveBeenCalledWith({ sessionId: SID, canvasId: CID })
  })

  it('ADV: a refused Reopen surfaces its reason instead of dying silently', async () => {
    seed({ completed: { at: 'now', by: 'user' } })
    completeReopen.mockResolvedValueOnce({ ok: false, reason: 'not this session’s canvas' } as any)
    await render()
    await click(byId('canvas-completed-reopen'))
    expect(container.querySelector('[data-testid="canvas-complete-refused"]')!.textContent).toContain('not this session')
  })

  it('ADV: a rejected Reopen is caught, not left as an unhandled rejection', async () => {
    seed({ completed: { at: 'now', by: 'user' } })
    completeReopen.mockRejectedValueOnce(new Error('boom'))
    await render()
    await click(byId('canvas-completed-reopen'))
    expect(container.querySelector('[data-testid="canvas-complete-refused"]')!.textContent).toContain('could not reopen')
  })

  it('ADV r2: a "not completed" reopen result is NOT shown as an error (double-fire / already reopened)', async () => {
    seed({ completed: { at: 'now', by: 'user' } })
    completeReopen.mockResolvedValueOnce({ ok: false, reason: 'not completed' } as any)
    await render()
    await click(byId('canvas-completed-reopen'))
    expect(container.querySelector('[data-testid="canvas-complete-refused"]')).toBeNull()
  })
})

describe('ADV: the armed confirm does not carry across a subject switch', () => {
  it('arming on canvas A then re-rendering as canvas B disarms — no sign-off of B', async () => {
    seed({ reviews: [review('R1', 'resolved')], annotations: [note('a1', 'R1', 'approved')] })
    await render()
    await click(byId('canvas-complete-arm'))
    expect(byId('canvas-complete-confirm')).toBeTruthy()
    // The pane switches subject under the mounted button.
    await act(async () => {
      root.render(<CanvasCompleteButton sessionId={SID} canvasId="canvas-B" title="Subject B" />)
    })
    // Disarmed — the confirm is gone, so a click cannot sign off B.
    expect(byId('canvas-complete-confirm')).toBeNull()
    expect(byId('canvas-complete-arm')).toBeTruthy()
  })

  it('ADV r2: disarms when the canvas flips to completed under a mounted button', async () => {
    // The reopen→complete round trip: arm, then the same canvasId gains a
    // completed stamp. The chip must render already disarmed, so returning to
    // the working control (a later reopen) is not one stale click from firing.
    seed({ reviews: [review('R1', 'resolved')], annotations: [note('a1', 'R1', 'approved')] })
    await render()
    await click(byId('canvas-complete-arm'))
    expect(byId('canvas-complete-confirm')).toBeTruthy()
    await act(async () => {
      useCanvasStore.setState({
        bySessionId: {
          [SID]: { ...useCanvasStore.getState().bySessionId[SID], completed: { at: 'now', by: 'user' as const } },
        },
      } as any)
    })
    // Now completed → chip shown, and the armed confirm is gone (disarmed).
    expect(container.querySelector('[data-testid="canvas-completed-chip"]')).toBeTruthy()
    expect(byId('canvas-complete-confirm')).toBeNull()
  })

  it('ADV: blocks (fails closed) when the review mirror points at a different canvas', async () => {
    // The window right after a switch: mirror still on the previous canvas.
    useCanvasStore.setState({
      bySessionId: {
        [SID]: {
          canvasId: CID, versions: [], activeVersionId: 'v1',
          interactionMode: 'browse', emptyView: 'intro', unseenRender: false,
          filedNotice: null, completedNotice: null, loaded: true,
        },
      },
    } as any)
    useCanvasReviewStore.setState({
      bySessionId: { [SID]: { loaded: true, canvasId: 'canvas-OTHER', reviews: [], annotations: [] } },
    } as any)
    await render()
    expect(byId('canvas-complete-arm')!.disabled).toBe(true)
  })
})

describe('show-and-tell dismiss (owner call, 2026-08-27)', () => {
  it('a show-only canvas with no review activity gets the one-click Dismiss, no arming', async () => {
    seed({ versions: [{ id: 'v1', show: true }] })
    await render()
    expect(byId('canvas-dismiss-button')).toBeTruthy()
    expect(byId('canvas-complete-arm')).toBeNull()
    await click(byId('canvas-dismiss-button'))
    expect(complete).toHaveBeenCalledWith({ sessionId: SID, canvasId: CID })
  })

  it('any review-intent ready version falls back to the armed Mark-complete flow', async () => {
    seed({ versions: [{ id: 'v1', show: true }, { id: 'v2' }], awaitingReview: true })
    await render()
    expect(byId('canvas-dismiss-button')).toBeNull()
    expect(byId('canvas-complete-arm')).toBeTruthy()
  })

  it('review activity on a show version disables the one-click path', async () => {
    seed({
      versions: [{ id: 'v1', show: true }],
      reviews: [review('R1', 'submitted', ['a1'])],
      annotations: [note('a1', 'R1', 'open')],
    })
    await render()
    expect(byId('canvas-dismiss-button')).toBeNull()
    expect(byId('canvas-complete-arm')).toBeTruthy()
    expect(byId('canvas-complete-arm')!.disabled).toBe(true)
  })

  it('a refused dismiss surfaces its reason like the armed flow does', async () => {
    complete.mockResolvedValueOnce({ ok: false, reason: 'not this session’s canvas' } as any)
    seed({ versions: [{ id: 'v1', show: true }] })
    await render()
    await click(byId('canvas-dismiss-button'))
    expect(byId('canvas-complete-refused')?.textContent).toContain('not this session')
  })
})
