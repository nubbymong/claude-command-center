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
import type { Annotation, CanvasVersion, ForceClosures, Review } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const CanvasCompleteButton = (await import('../../../src/renderer/components/CanvasCompleteButton')).default
const { useCanvasStore } = await import('../../../src/renderer/stores/canvasStore')
const { useCanvasReviewStore } = await import('../../../src/renderer/stores/canvasReviewStore')

const SID = 'session-complete'
const CID = 'canvas-a'

const complete = vi.fn(async (_args: { sessionId: string; canvasId: string }) => ({ ok: true }))
const completeForce = vi.fn(async (_args: { sessionId: string; canvasId: string }) => ({ ok: true }))
const completeReopen = vi.fn(async (_args: { sessionId: string; canvasId: string }) => ({ ok: true }))
/** What main says a force would close. The armed confirm's label is built from
 *  this, so the label and the effect are drawn from one read. */
let closures: ForceClosures | null = { unsentNotes: 0, openNotes: 0, addressedNotes: 0, unreviewedVersionIds: [] }
;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    complete: (args: { sessionId: string; canvasId: string }) => complete(args),
    completeForce: (args: { sessionId: string; canvasId: string }) => completeForce(args),
    describeForceClosures: vi.fn(async () => closures),
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
  versions?: Array<{ id: string; draft?: true; show?: true; mode?: 'design' | 'plan' | 'uat'; verdict?: CanvasVersion['verdict'] }>
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

async function render(displayedVersionId: string | null = 'v1'): Promise<void> {
  await act(async () => {
    root.render(
      <CanvasCompleteButton sessionId={SID} canvasId={CID} title="Quick Start rows" displayedVersionId={displayedVersionId} />,
    )
  })
}

const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement | null

async function click(el: Element | null): Promise<void> {
  expect(el).toBeTruthy()
  await act(async () => (el as HTMLElement).click())
}

beforeEach(() => {
  complete.mockClear()
  completeForce.mockClear()
  completeReopen.mockClear()
  complete.mockResolvedValue({ ok: true })
  completeForce.mockResolvedValue({ ok: true })
  closures = { unsentNotes: 0, openNotes: 0, addressedNotes: 0, unreviewedVersionIds: [] }
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

  // MARK COMPLETE IS NEVER DEAD (W3). The old button went dark the moment
  // anything was owed, which left a canvas nobody could finish: the agent's
  // canvas_complete refuses while notes are outstanding (correctly, and still
  // does), and the user's only control was disabled. So it is HIDDEN or
  // ENABLED, never disabled.
  it('stays ENABLED with an open round, and offers to force it closed', async () => {
    seed({ reviews: [review('R1', 'submitted')], annotations: [note('a1', 'R1', 'open')] })
    await render()
    const arm = byId('canvas-complete-arm')!
    expect(arm.disabled).toBe(false)
    expect(arm.title).toContain('closing what is still outstanding as not done')
  })

  it('stays ENABLED with unsubmitted draft notes', async () => {
    seed({ reviews: [review('R1', 'draft', ['a1'])], annotations: [note('a1', 'R1', 'open')] })
    await render()
    expect(byId('canvas-complete-arm')!.disabled).toBe(false)
  })

  it('is HIDDEN while the artefact`s latest ready version is still OPEN', async () => {
    // The gesture that belongs to that state is the DECISION — approve or
    // reject in the panel — and an approval completes the canvas by itself.
    seed({ versions: [{ id: 'v1' }], awaitingReview: true })
    await render()
    expect(byId('canvas-complete-arm')).toBeNull()
    expect(byId('canvas-dismiss-button')).toBeNull()
  })

  it('asks that question of the DISPLAYED artefact, not the canvas`s latest version (D2)', async () => {
    // A plan (v1, still open) and a mockup (v2, approved) on one canvas. Keyed
    // on the canvas's latest version, the button would show while the user is
    // looking at the plan they are supposed to decide on, and hide while they
    // are looking at the settled mockup — exactly backwards, both times.
    seed({
      versions: [
        { id: 'v1', mode: 'plan' },
        { id: 'v2', verdict: { state: 'approved', by: 'user', at: 'now' } },
      ],
    })
    await render('v1')
    expect(byId('canvas-complete-arm')).toBeNull() // the plan is open — decide
    await act(async () => root.unmount())
    root = createRoot(container)
    await render('v2')
    expect(byId('canvas-complete-arm')).toBeTruthy() // the mockup is settled
  })
})

describe('the armed confirm NAMES what it will force-close', () => {
  it('says each closure, and "as not done" — never as approved', async () => {
    closures = { unsentNotes: 1, openNotes: 1, addressedNotes: 2, unreviewedVersionIds: ['v3'] }
    seed({ reviews: [review('R1', 'submitted')], annotations: [note('a1', 'R1', 'open')] })
    await render()
    await click(byId('canvas-complete-arm'))
    const confirm = byId('canvas-complete-confirm')!
    expect(confirm.textContent).toContain('deletes 1 unsent note')
    expect(confirm.textContent).toContain('closes 1 note still with the agent, as not done')
    expect(confirm.textContent).toContain('closes 2 notes the agent answered, as not done')
    expect(confirm.textContent).toContain('closes v3 unreviewed')
  })

  it('forces through canvas:completeForce when something is owed', async () => {
    closures = { unsentNotes: 0, openNotes: 1, addressedNotes: 0 }
    seed({ reviews: [review('R1', 'submitted')], annotations: [note('a1', 'R1', 'open')] })
    await render()
    await click(byId('canvas-complete-arm'))
    passGuard()
    await click(byId('canvas-complete-confirm'))
    expect(completeForce).toHaveBeenCalledWith({ sessionId: SID, canvasId: CID })
    expect(complete).not.toHaveBeenCalled()
  })

  it('uses the PLAIN complete when nothing is owed — the full guard still runs', async () => {
    seed({ reviews: [review('R1', 'resolved')], annotations: [note('a1', 'R1', 'approved')] })
    await render()
    await click(byId('canvas-complete-arm'))
    // The arm and the confirm say the SAME words — the second click is plainly
    // the same action, not a new one to re-read. The subject's name rides the
    // tooltip, where it does not compete with the closures for label width.
    expect(byId('canvas-complete-confirm')!.textContent).toBe('Mark complete')
    expect(byId('canvas-complete-confirm')!.title).toContain('“Quick Start rows”')
    passGuard()
    await click(byId('canvas-complete-confirm'))
    expect(complete).toHaveBeenCalledWith({ sessionId: SID, canvasId: CID })
    expect(completeForce).not.toHaveBeenCalled()
  })

  it('names every open version the force will dismiss, not just one', async () => {
    closures = { unsentNotes: 0, openNotes: 0, addressedNotes: 0, unreviewedVersionIds: ['v1', 'v3'] }
    seed({ reviews: [review('R1', 'resolved')], annotations: [] })
    await render()
    await click(byId('canvas-complete-arm'))
    expect(byId('canvas-complete-confirm')!.textContent).toContain('closes v1, v3 unreviewed')
  })

  it('FORCES even when the describe came back null, so an owed canvas never gets a dead click', async () => {
    // main returning null (unreadable store, a canvas it will not describe)
    // leaves no phrases. Taking the plain path there sends the sign-off through
    // a guard that will refuse it, which reads to the user as a dead button.
    closures = null
    seed({ reviews: [review('R1', 'submitted')], annotations: [note('a1', 'R1', 'open')] })
    await render()
    await click(byId('canvas-complete-arm'))
    expect(byId('canvas-complete-confirm')!.textContent).toContain('closes whatever is still outstanding, as not done')
    passGuard()
    await click(byId('canvas-complete-confirm'))
    expect(completeForce).toHaveBeenCalledTimes(1)
    expect(complete).not.toHaveBeenCalled()
  })

  it('a subject switch clears the previous canvas`s phrases', async () => {
    closures = { unsentNotes: 4, openNotes: 0, addressedNotes: 0, unreviewedVersionIds: [] }
    seed({ reviews: [review('R1', 'resolved')], annotations: [] })
    await render()
    await click(byId('canvas-complete-arm'))
    expect(byId('canvas-complete-confirm')!.textContent).toContain('deletes 4 unsent notes')

    // The pane switches subject under a mounted button. The confirm must not
    // carry canvas A's sentence onto canvas B.
    await act(async () => {
      root.render(<CanvasCompleteButton sessionId={SID} canvasId="canvas-OTHER" title="Other" displayedVersionId="v1" />)
    })
    expect(byId('canvas-complete-confirm')).toBeNull()
    expect(container.textContent).not.toContain('deletes 4 unsent notes')
  })
})

describe('the two-step', () => {
  it('arms to a confirm that names the subject, and a double-click cannot fire it (#456)', async () => {
    seed({})
    await render()
    await click(byId('canvas-complete-arm'))
    const confirm = byId('canvas-complete-confirm')!
    expect(confirm.textContent).toBe('Mark complete')
    expect(confirm.title).toContain('“Quick Start rows”')
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
    // The stale mirror no longer decides anything: the button is never
    // disabled, and what the confirm SAYS comes from main's own describe —
    // which is read against the canvas id, not against the mirror. A renderer
    // that guessed here is how a confirm came to promise what the mutation
    // would not do.
    expect(byId('canvas-complete-arm')!.disabled).toBe(false)
    expect(byId('canvas-complete-arm')!.title).toContain('closing what is still outstanding')
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

  it('a review-intent version still OPEN hides the whole slot — decide first', async () => {
    seed({ versions: [{ id: 'v1', show: true }, { id: 'v2' }], awaitingReview: true })
    await render()
    expect(byId('canvas-dismiss-button')).toBeNull()
    expect(byId('canvas-complete-arm')).toBeNull()
  })

  it('review activity on a show version falls back to the armed Mark-complete flow', async () => {
    seed({
      versions: [{ id: 'v1', show: true }],
      reviews: [review('R1', 'submitted', ['a1'])],
      annotations: [note('a1', 'R1', 'open')],
    })
    await render()
    expect(byId('canvas-dismiss-button')).toBeNull()
    // Enabled, not disabled: the round it grew is exactly what the force exists
    // to close when the user decides they are done with the subject.
    expect(byId('canvas-complete-arm')!.disabled).toBe(false)
  })

  it('a refused dismiss surfaces its reason like the armed flow does', async () => {
    complete.mockResolvedValueOnce({ ok: false, reason: 'not this session’s canvas' } as any)
    seed({ versions: [{ id: 'v1', show: true }] })
    await render()
    await click(byId('canvas-dismiss-button'))
    expect(byId('canvas-complete-refused')?.textContent).toContain('not this session')
  })
})
