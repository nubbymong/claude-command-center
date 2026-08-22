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
let resolves: Array<{ annotationId: string; action: string }>
let reopens: string[]

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
    annotationResolve: vi.fn(async ({ annotationId, action }: { annotationId: string; action: string }) => {
      resolves.push({ annotationId, action })
      return { state: applyResolve(annotationId, action) }
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

async function render(): Promise<void> {
  await act(async () => {
    root.render(<CanvasNotesPanel sessionId={SID} version={VERSION} getGlassApi={() => null} onReturnToTerminal={() => {}} />)
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
    expect(resolves).toEqual([{ annotationId: 'a1', action: 'stale' }])
  })
})
