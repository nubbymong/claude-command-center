// @vitest-environment jsdom
//
// "Close all rounds waiting on me", in the panel (#365).
//
// The pill said 3; all three were rounds the agent had finished and only the
// user's verdict could close, and there was no way to clear them — not here,
// and not by telling the agent. This is the user's half of the fix.
//
// What these pin, and why each one is worth a test:
//
//  - The bulk action writes STALE, never APPROVE. A close-out that quietly
//    recorded approval would put words in the user's mouth on the one record
//    that exists to hold their verdict, and the label would be a lie.
//  - It is two-step, and the second step says how many notes it will close.
//  - Its scope is the rounds waiting on YOU. A round still with the agent is
//    not touched, and is not counted in the label.
//  - Closed notes stay visible with WHO closed them, and Reopen is one click —
//    which is the only reason a one-click bulk close is a safe thing to offer.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { Annotation, CanvasReviewState, CanvasVersion, Review } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@excalidraw/excalidraw', () => ({ exportToBlob: vi.fn() }))

const CanvasNotesPanel = (await import('../../../src/renderer/components/CanvasNotesPanel')).default
const { useCanvasReviewStore } = await import('../../../src/renderer/stores/canvasReviewStore')

const SID = 'session-1'
const VERSION: CanvasVersion = {
  id: 'v1',
  mode: 'design',
  createdAt: '2026-08-22T10:00:00Z',
  source: { mode: 'design', entry: 'index.html' },
} as CanvasVersion

const review = (id: string, status: Review['status'], minute: string): Review => ({
  id,
  canvas: { canvasId: 'canvas-a', sessionId: SID },
  versionId: 'v1',
  annotationIds: [],
  status,
  createdAt: `2026-08-22T09:${minute}:00Z`,
  submittedAt: `2026-08-22T09:${minute}:30Z`,
})

const note = (id: string, reviewId: string, state: Annotation['state'], extra: Partial<Annotation> = {}): Annotation => ({
  id, reviewId, scope: 'general', note: `text of ${id}`, versionId: 'v1', state, ...extra,
})

/** Two rounds waiting on the user (R1, R2) and one still with the agent (R3).
 *  The third is the whole point: the bulk button must not reach it. */
function boardWithMixedRounds(): CanvasReviewState {
  return {
    canvasId: 'canvas-a',
    sessionId: SID,
    reviews: [review('R1', 'submitted', '01'), review('R2', 'submitted', '02'), review('R3', 'submitted', '03')],
    annotations: [
      note('a1', 'R1', 'addressed'),
      note('a2', 'R1', 'addressed'),
      note('a3', 'R2', 'addressed'),
      note('a4', 'R3', 'addressed'),
      note('a5', 'R3', 'open'),
    ],
  }
}

let current: CanvasReviewState
let container: HTMLDivElement
let root: Root
/** Every resolve the panel sent, in order. */
let resolves: Array<{ annotationId: string; action: string; canvasId: string }>
let reopens: string[]
/** Every "the user has these on screen" report the panel sent, in order. */
let seenReports: Array<{ canvasId: string; annotationIds: string[] }>

/** Apply the transition main would apply, so the panel sees a real mirror. */
function applyResolve(annotationId: string, action: string): CanvasReviewState {
  const annotations = current.annotations.map((a) =>
    a.id === annotationId
      ? { ...a, state: (action === 'approve' ? 'approved' : action === 'dismiss' ? 'dismissed' : 'stale') as Annotation['state'], closedBy: 'user' as const, closedFrom: 'addressed' as const }
      : a,
  )
  const reviews = current.reviews.map((r) =>
    r.status === 'submitted' && !annotations.some((a) => a.reviewId === r.id && (a.state === 'open' || a.state === 'addressed'))
      ? { ...r, status: 'resolved' as const }
      : r,
  )
  current = { ...current, annotations, reviews }
  return current
}

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  pty: { ...((globalThis as any).window?.electronAPI?.pty ?? {}), write: vi.fn() },
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    reviewGetState: vi.fn(async () => current),
    annotationResolve: vi.fn(async ({ annotationId, action, canvasId }: { annotationId: string; action: string; canvasId: string }) => {
      resolves.push({ annotationId, action, canvasId })
      return { state: applyResolve(annotationId, action) }
    }),
    // The release side of the agent's close-out barrier. Mocked here because
    // the panel fires it on its own, from an effect, whenever the user is
    // actually looking at an addressed round.
    reviewMarkSeen: vi.fn(async ({ canvasId, annotationIds }: { canvasId: string; annotationIds: string[] }) => {
      seenReports.push({ canvasId, annotationIds })
      const marked = new Set(annotationIds)
      current = {
        ...current,
        annotations: current.annotations.map((a) => (marked.has(a.id) ? { ...a, userSawAddressed: true } : a)),
      }
      return { state: current, seen: annotationIds }
    }),
    annotationReopen: vi.fn(async ({ annotationId }: { annotationId: string }) => {
      reopens.push(annotationId)
      const annotations = current.annotations.map((a) =>
        a.id === annotationId ? { ...a, state: (a.closedFrom ?? 'open') as Annotation['state'], closedBy: undefined, closedFrom: undefined } : a,
      )
      const reviews = current.reviews.map((r) =>
        r.status === 'resolved' && annotations.some((a) => a.reviewId === r.id && (a.state === 'open' || a.state === 'addressed'))
          ? { ...r, status: 'submitted' as const }
          : r,
      )
      current = { ...current, annotations, reviews }
      return current
    }),
  },
}

/** `isActive` defaults to FALSE — the value that claims the user has seen
 *  nothing. Every test about the close-out barrier's release passes it
 *  explicitly, so no other test can grant that release by accident. */
async function render(isActive = false): Promise<void> {
  await act(async () => {
    root.render(
      <CanvasNotesPanel
        sessionId={SID}
        version={VERSION}
        getGlassApi={() => null}
        onReturnToTerminal={() => {}}
        isActive={isActive}
      />,
    )
  })
}

function byTestId(id: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${id}"]`)
}

/** One round's subtree, so a query cannot pick up the newest round's controls
 *  by accident — groups render newest first. */
function group(reviewId: string): HTMLElement {
  const el = container.querySelector(`[data-testid="review-group"][data-review="${reviewId}"]`)
  expect(el, `the ${reviewId} round`).toBeTruthy()
  return el as HTMLElement
}

/** Expand a round. A round with nothing live left starts COLLAPSED by design —
 *  closed work folds away rather than burying what is still in play — so the
 *  Closed list underneath it has to be opened first. */
async function expandRound(reviewId: string): Promise<void> {
  const header = group(reviewId).querySelector('button')
  expect(header).toBeTruthy()
  if (header!.getAttribute('aria-expanded') === 'false') {
    await act(async () => (header as HTMLElement).click())
  }
}

async function click(el: Element | null): Promise<void> {
  expect(el).toBeTruthy()
  await act(async () => (el as HTMLElement).click())
}

beforeEach(async () => {
  current = boardWithMixedRounds()
  resolves = []
  reopens = []
  seenReports = []
  useCanvasReviewStore.getState().reset()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('close all rounds waiting on me', () => {
  it('counts only the rounds waiting on you, not the one still with the agent', async () => {
    await render()
    const bar = byTestId('close-all-waiting')
    expect(bar).toBeTruthy()
    // R1 and R2 — never R3, which still has an open note.
    expect(bar!.textContent).toContain('2 rounds waiting on you')
  })

  it('is two-step, and the confirm says exactly how many notes it will close', async () => {
    await render()
    expect(byTestId('close-all-waiting-confirm')).toBeNull()
    await click(byTestId('close-all-waiting-arm'))
    const confirm = byTestId('close-all-waiting-confirm')
    expect(confirm).toBeTruthy()
    // a1, a2, a3 — a4 belongs to the round still with the agent.
    expect(confirm!.textContent).toContain('Close 3 notes')
  })

  it('closes them as STALE and never as approved', async () => {
    await render()
    await click(byTestId('close-all-waiting-arm'))
    await click(byTestId('close-all-waiting-confirm'))

    // Newest round first, which is the order the panel lists them in.
    expect(resolves.map((r) => r.annotationId)).toEqual(['a3', 'a1', 'a2'])
    expect(resolves.every((r) => r.action === 'stale')).toBe(true)
    expect(resolves.some((r) => r.action === 'approve')).toBe(false)
  })

  it('leaves the round still with the agent untouched', async () => {
    await render()
    await click(byTestId('close-all-waiting-arm'))
    await click(byTestId('close-all-waiting-confirm'))

    expect(resolves.map((r) => r.annotationId)).not.toContain('a4')
    expect(current.annotations.find((a) => a.id === 'a4')!.state).toBe('addressed')
    expect(current.annotations.find((a) => a.id === 'a5')!.state).toBe('open')
    expect(current.reviews.find((r) => r.id === 'R3')!.status).toBe('submitted')
  })

  it('disappears once nothing is waiting on you any more', async () => {
    await render()
    await click(byTestId('close-all-waiting-arm'))
    await click(byTestId('close-all-waiting-confirm'))
    await render()
    // R3 is still with the agent, so it is not "waiting on you" and the bar
    // has nothing left to offer.
    expect(byTestId('close-all-waiting')).toBeNull()
  })

  it('can be cancelled without closing anything', async () => {
    await render()
    await click(byTestId('close-all-waiting-arm'))
    await click(container.querySelector('[data-testid="close-all-waiting"] button')) // Cancel
    expect(byTestId('close-all-waiting-confirm')).toBeNull()
    expect(resolves).toEqual([])
  })

  it('offers "Accept as built" on a round, never a second Approve', async () => {
    await render()
    const accept = group('R1').querySelector('[data-testid="review-accept-as-built"]')
    expect(accept).toBeTruthy()
    expect(accept!.textContent).toBe('Accept as built')
    await click(accept)
    expect(resolves.every((r) => r.action === 'stale')).toBe(true)
    expect(resolves.map((r) => r.annotationId)).toEqual(['a1', 'a2'])
  })

  it('never offers the round bulk action on a round still with the agent', async () => {
    await render()
    // R3 has an open note, so there is nothing for the user to decide yet and
    // a bulk button would just be a way to close work nobody claims to have done.
    expect(group('R3').querySelector('[data-testid="review-accept-as-built"]')).toBeNull()
    expect(group('R3').querySelector('[data-testid="review-approve-rest"]')).toBeNull()
  })
})

describe('closed work stays visible, and reopens in one click', () => {
  it('says who closed each note, and marks the agent’s as on your instruction', async () => {
    current = {
      canvasId: 'canvas-a',
      sessionId: SID,
      reviews: [review('R1', 'resolved', '01')],
      annotations: [
        note('a1', 'R1', 'stale', { closedBy: 'agent', closedFrom: 'addressed' }),
        note('a2', 'R1', 'approved', { closedBy: 'user', closedFrom: 'addressed' }),
      ],
    }
    await render()
    await expandRound('R1')
    const chip = byTestId('review-agent-closed-chip')
    expect(chip).toBeTruthy()
    expect(chip!.textContent).toContain('1 on your instruction')

    await click(byTestId('review-closed-toggle'))
    const rows = container.querySelectorAll('[data-testid="review-closed-note"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].textContent).toContain('closed — work shipped')
    expect(rows[0].textContent).toContain('by the agent on your instruction')
    // The user's own approval is never attributed to the agent.
    expect(rows[1].textContent).toContain('approved')
    expect(rows[1].textContent).toContain('by you')
    // Cleared, not deleted: the text is still readable.
    expect(rows[0].textContent).toContain('text of a1')
  })

  it('reopens a closed note from the panel', async () => {
    current = {
      canvasId: 'canvas-a',
      sessionId: SID,
      reviews: [review('R1', 'resolved', '01')],
      annotations: [note('a1', 'R1', 'stale', { closedBy: 'agent', closedFrom: 'addressed' })],
    }
    await render()
    await expandRound('R1')
    await click(byTestId('review-closed-toggle'))
    await click(byTestId('review-reopen-note'))

    expect(reopens).toEqual(['a1'])
    expect(current.annotations[0].state).toBe('addressed')
    expect(current.reviews[0].status).toBe('submitted')
  })

  it('offers a per-note Close that is not Approve', async () => {
    await render()
    const closeBtn = group('R1').querySelector('[data-testid="note-close-stale"]')
    expect(closeBtn).toBeTruthy()
    expect(closeBtn!.textContent).toBe('Close')
    await click(closeBtn)
    expect(resolves).toEqual([{ annotationId: 'a1', action: 'stale', canvasId: 'canvas-a' }])
  })

  it('says out loud when the agent both did the work and closed the note', async () => {
    // Q-2 residue. The agent's close-out precondition is a state the agent
    // writes itself, so on an agent-closed note the same party did the work and
    // ended the conversation about it. The store refuses the two in one pass;
    // it cannot see whether the user actually asked. So the row says so, next
    // to a Reopen.
    current = {
      canvasId: 'canvas-a',
      sessionId: SID,
      reviews: [review('R1', 'resolved', '01')],
      annotations: [
        note('a1', 'R1', 'stale', { closedBy: 'agent', closedFrom: 'addressed' }),
        note('a2', 'R1', 'stale', { closedBy: 'user', closedFrom: 'addressed' }),
      ],
    }
    await render()
    await expandRound('R1')
    await click(byTestId('review-closed-toggle'))
    const flags = container.querySelectorAll('[data-testid="review-closed-agent-both"]')
    // Only the agent-closed row carries it; the user's own close does not.
    expect(flags).toHaveLength(1)
    expect(flags[0].textContent).toContain('nobody else checked it')
  })
})

describe('a bulk pass cannot land on the wrong canvas, or race itself', () => {
  it('stops the moment the session switches canvas mid-pass (Q-3)', async () => {
    // `annotationResolve` carries only a note id, and main resolves it against
    // whatever canvas the session points at NOW. Ids restart at a1 on every
    // canvas, so a canvas_render naming a new subject mid-pass would send the
    // remaining ids at an unrelated canvas — closing that canvas's notes under
    // the user's own name.
    let calls = 0
    ;(window as any).electronAPI.canvas.annotationResolve = vi.fn(
      async ({ annotationId, action, canvasId }: { annotationId: string; action: string; canvasId: string }) => {
        resolves.push({ annotationId, action, canvasId })
        const state = applyResolve(annotationId, action)
        calls++
        // The agent files this canvas and starts a new one, right after the
        // first note is closed.
        if (calls === 1) current = { ...state, canvasId: 'canvas-b' }
        return { state: current }
      },
    )

    await render()
    await click(byTestId('close-all-waiting-arm'))
    await click(byTestId('close-all-waiting-confirm'))

    // One resolve landed on the canvas the ids belonged to; the pass then
    // stopped rather than continuing against canvas-b.
    expect(resolves).toHaveLength(1)
    // And it NAMED that canvas. The pre-flight check above stops the rest of
    // the pass, but it cannot stop the write already in flight when the canvas
    // changes — main refuses that one by comparing the id the pass started on
    // against the canvas the session is on now, inside the same synchronous
    // mutation as the write. Sending the id is this side of that guard.
    expect(resolves[0].canvasId).toBe('canvas-a')
  })

  it('locks every other verdict control while the bulk pass runs (Q-6)', async () => {
    // Two loops over the same notes interleave otherwise, each resolve landing
    // on a note the other has already consumed.
    let release: (() => void) | null = null
    ;(window as any).electronAPI.canvas.annotationResolve = vi.fn(
      async ({ annotationId, action, canvasId }: { annotationId: string; action: string; canvasId: string }) => {
        resolves.push({ annotationId, action, canvasId })
        const state = applyResolve(annotationId, action)
        if (!release) await new Promise<void>((r) => { release = r })
        return { state }
      },
    )

    await render()
    await click(byTestId('close-all-waiting-arm'))
    // Start the pass but do not let it finish.
    void act(async () => (byTestId('close-all-waiting-confirm') as HTMLElement).click())
    await act(async () => {})

    // Assert the controls are PRESENT and disabled — `?? true` on a missing
    // element would pass this test without the lock existing at all.
    const accept = group('R1').querySelector('[data-testid="review-accept-as-built"]') as HTMLButtonElement | null
    const perNote = group('R1').querySelector('[data-testid="note-close-stale"]') as HTMLButtonElement | null
    expect(accept).toBeTruthy()
    expect(perNote).toBeTruthy()
    expect(accept!.disabled).toBe(true)
    expect(perNote!.disabled).toBe(true)

    if (release) (release as () => void)()
    await act(async () => {})
  })
})
