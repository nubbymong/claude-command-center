// @vitest-environment jsdom
//
// The notes panel under the SETTLED machine (2026-08-29).
//
// What this file replaces is as important as what it pins. The old
// canvas-closeout-panel suite covered "Close all rounds waiting on me", the
// per-note Approve / Close / Dismiss row, and the round-level "Approve all /
// Accept as built / Dismiss the rest" bar. All of it is gone (W6): notes have
// no verdicts of their own, so nothing on this panel waits on the user, and the
// pile of "N for you" rounds those controls existed to clear cannot form.
//
// What is left, and pinned here:
//
//  - a SETTLED round says HOW it settled, and never as somebody's click when
//    nobody clicked;
//  - an OBSERVATION reads as "nothing owed" rather than as a verdict;
//  - settled work stays visible and reopens — the note, and the whole round;
//  - approving with notes warns FIRST that they become observations, because
//    discovering that afterwards is the working-pill strand from the user's side.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { Annotation, CanvasReviewState, CanvasVersion, Review } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('@excalidraw/excalidraw', () => ({ exportToBlob: vi.fn() }))

const CanvasNotesPanel = (await import('../../../src/renderer/components/CanvasNotesPanel')).default
const { useCanvasReviewStore } = await import('../../../src/renderer/stores/canvasReviewStore')
const { useCanvasStore } = await import('../../../src/renderer/stores/canvasStore')

const SID = 'session-1'
const VERSION: CanvasVersion = {
  id: 'v1',
  mode: 'design',
  createdAt: '2026-08-22T10:00:00Z',
  source: { mode: 'design', entry: 'index.html' },
} as CanvasVersion

const review = (id: string, status: Review['status'], minute: string, extra: Partial<Review> = {}): Review => ({
  id,
  canvas: { canvasId: 'canvas-a', sessionId: SID },
  versionId: 'v1',
  annotationIds: [],
  status,
  createdAt: `2026-08-22T09:${minute}:00Z`,
  submittedAt: `2026-08-22T09:${minute}:30Z`,
  ...extra,
})

const note = (id: string, reviewId: string, state: Annotation['state'], extra: Partial<Annotation> = {}): Annotation => ({
  id, reviewId, scope: 'general', note: `text of ${id}`, versionId: 'v1', state, ...extra,
})

let current: CanvasReviewState
let container: HTMLDivElement
let root: Root
let reopens: string[]
let roundReopens: Array<{ canvasId: string; reviewId: string }>

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  pty: { ...((globalThis as any).window?.electronAPI?.pty ?? {}), write: vi.fn() },
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    reviewGetState: vi.fn(async () => current),
    reviewMarkSeen: vi.fn(async () => ({ state: current, seen: [] })),
    annotationReopen: vi.fn(async ({ annotationId }: { annotationId: string }) => {
      reopens.push(annotationId)
      const annotations = current.annotations.map((a) =>
        a.id === annotationId ? { ...a, state: (a.closedFrom ?? 'open') as Annotation['state'], closedBy: undefined, closedFrom: undefined } : a,
      )
      const reviews = current.reviews.map((r) =>
        r.status === 'resolved' && annotations.some((a) => a.reviewId === r.id && (a.state === 'open' || a.state === 'addressed'))
          ? { ...r, status: 'submitted' as const, settled: undefined }
          : r,
      )
      current = { ...current, annotations, reviews }
      return current
    }),
    reviewReopen: vi.fn(async ({ canvasId, reviewId }: { canvasId: string; reviewId: string }) => {
      roundReopens.push({ canvasId, reviewId })
      const annotations = current.annotations.map((a) =>
        a.reviewId === reviewId ? { ...a, state: (a.closedFrom ?? 'open') as Annotation['state'], closedBy: undefined, closedFrom: undefined } : a,
      )
      const reviews = current.reviews.map((r) => (r.id === reviewId ? { ...r, status: 'submitted' as const, settled: undefined } : r))
      current = { ...current, annotations, reviews }
      return current
    }),
  },
}

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

function group(reviewId: string): HTMLElement {
  const el = container.querySelector(`[data-testid="review-group"][data-review="${reviewId}"]`)
  expect(el, `the ${reviewId} round`).toBeTruthy()
  return el as HTMLElement
}

/** A settled round starts COLLAPSED by design — settled work folds away rather
 *  than burying what is still in play — so it has to be opened first. */
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
  reopens = []
  roundReopens = []
  current = {
    canvasId: 'canvas-a',
    sessionId: SID,
    reviews: [review('R1', 'submitted', '01'), review('R2', 'submitted', '02')],
    annotations: [note('a1', 'R1', 'addressed'), note('a2', 'R2', 'open')],
  }
  useCanvasReviewStore.getState().reset()
  useCanvasStore.setState({ bySessionId: {} } as never)
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

describe('the panel offers no per-note verdicts at all', () => {
  it('shows no Approve / Close / Dismiss on a live note, and no bulk close strip', async () => {
    await render()
    expect(byTestId('close-all-waiting')).toBeNull()
    expect(byTestId('note-close-stale')).toBeNull()
    expect(byTestId('review-approve-rest')).toBeNull()
    expect(byTestId('review-accept-as-built')).toBeNull()
    expect(byTestId('review-dismiss-rest')).toBeNull()
    // The rounds are still listed — they are with the AGENT, not with the user.
    expect(container.querySelectorAll('[data-testid="review-group"]')).toHaveLength(2)
    expect(byTestId('review-section-agent')).toBeTruthy()
    expect(byTestId('review-section-you')).toBeNull()
  })

  it('shows variant chips as read-only labels, not as buttons that approve', async () => {
    current = {
      ...current,
      annotations: [note('a1', 'R1', 'addressed', { variants: [{ key: 'A', label: 'thin rule' }, { key: 'B', label: 'no rule' }] })],
    }
    await render()
    const chip = byTestId('note-variant-A')
    expect(chip).toBeTruthy()
    expect(chip!.tagName).toBe('SPAN')
    expect(chip!.textContent).toContain('thin rule')
  })

  it('shows the agent`s "updated in vN" claim beside the note', async () => {
    current = { ...current, annotations: [note('a1', 'R1', 'addressed', { addressedIn: 'v9' })] }
    await render()
    expect(byTestId('note-updated-in')!.textContent).toContain('updated in v9')
  })
})

describe('a settled round says HOW it settled', () => {
  it('names the decision that closed it, and never claims a click nobody made', async () => {
    current = {
      canvasId: 'canvas-a',
      sessionId: SID,
      reviews: [review('R1', 'resolved', '01', { settled: { at: '2026-08-22T09:05:00Z', by: 'decision', versionId: 'v8' } })],
      annotations: [note('a1', 'R1', 'stale', { closedBy: 'decision', closedFrom: 'open', settledBy: { versionId: 'v8' } })],
    }
    await render()
    expect(group('R1').textContent).toContain('settled by your v8 decision')
    await expandRound('R1')
    await click(byTestId('review-closed-toggle'))
    const rows = container.querySelectorAll('[data-testid="review-closed-note"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].textContent).toContain('settled by your v8 decision')
    // Cleared, not deleted: the text is still readable.
    expect(rows[0].textContent).toContain('text of a1')
  })

  it('says on the ROW whether the note was ever answered (m14)', async () => {
    // "closed — work shipped" would be a claim about the work that nobody made.
    // What the row can honestly say is what happened to THIS note, and that is
    // a different sentence depending on where it was when the decision landed.
    current = {
      canvasId: 'canvas-a',
      sessionId: SID,
      reviews: [review('R1', 'resolved', '01', { settled: { at: '2026-08-22T09:05:00Z', by: 'decision', versionId: 'v8', reviewId: 'R8' } })],
      annotations: [
        note('a1', 'R1', 'stale', { closedBy: 'decision', closedFrom: 'open', settledBy: { versionId: 'v8', reviewId: 'R8' } }),
        note('a2', 'R1', 'stale', { closedBy: 'decision', closedFrom: 'addressed', addressedIn: 'v7', settledBy: { versionId: 'v8', reviewId: 'R8' } }),
        note('a3', 'R1', 'stale', { closedBy: 'decision', closedFrom: 'addressed', settledBy: { versionId: 'v8', reviewId: 'R8' } }),
      ],
    }
    await render()
    await expandRound('R1')
    await click(byTestId('review-closed-toggle'))
    const rows = container.querySelectorAll('[data-testid="review-closed-note"]')
    // Nobody ever answered a1 — the user should be able to SEE that in the list.
    expect(rows[0].textContent).toContain('closed — never resolved · superseded by your Review #8')
    // a2 was answered, and the agent said where the fix landed.
    expect(rows[1].textContent).toContain('updated in v7 · superseded by your Review #8')
    // a3 was answered without a version named.
    expect(rows[2].textContent).toContain('answered by the agent · superseded by your Review #8')
    // Nothing here claims the work shipped.
    expect(container.textContent).not.toContain('work shipped')
  })

  it('a zero-note decision names the VERDICT on the round header (R1)', async () => {
    // The label needs the canvas's versions to look the verdict word up. The
    // panel reads them from the canvas store; without that wiring the header
    // says the shrug — "your v8 decision" — and the user has to go and find out
    // which way it went.
    useCanvasStore.setState({
      bySessionId: {
        [SID]: {
          canvasId: 'canvas-a',
          versions: [
            { id: 'v8', mode: 'design', createdAt: '2026-08-22T10:00:00Z', source: { mode: 'design', entry: 'index.html' }, verdict: { state: 'approved', by: 'user', at: 'now' } },
          ],
          activeVersionId: 'v8',
          interactionMode: 'browse',
          emptyView: 'intro',
          unseenRender: false,
          filedNotice: null,
          completedNotice: null,
          loaded: true,
        },
      },
    } as never)
    current = {
      canvasId: 'canvas-a',
      sessionId: SID,
      reviews: [review('R1', 'resolved', '01', { settled: { at: '2026-08-22T09:05:00Z', by: 'decision', versionId: 'v8' } })],
      annotations: [note('a1', 'R1', 'stale', { closedBy: 'decision', closedFrom: 'open', settledBy: { versionId: 'v8' } })],
    }
    await render()
    expect(group('R1').textContent).toContain('settled by your v8 approval')
    expect(group('R1').textContent).not.toContain('v8 decision')
  })

  it('reads an OBSERVATION as nothing owed, and "passed with observations" on the round', async () => {
    current = {
      canvasId: 'canvas-a',
      sessionId: SID,
      reviews: [review('R1', 'resolved', '01', { decision: 'approve', settled: { at: '2026-08-22T09:05:00Z', by: 'observation' } })],
      annotations: [note('a1', 'R1', 'observation', { closedBy: 'user', closedFrom: 'open' })],
    }
    await render()
    expect(group('R1').textContent).toContain('passed with observations')
    await expandRound('R1')
    await click(byTestId('review-closed-toggle'))
    expect(container.querySelector('[data-testid="review-closed-note"]')!.textContent).toContain('nothing owed')
  })

  it('says who closed it when the AGENT did, on the user`s instruction', async () => {
    current = {
      canvasId: 'canvas-a',
      sessionId: SID,
      reviews: [review('R1', 'resolved', '01', { settled: { at: '2026-08-22T09:05:00Z', by: 'agent' } })],
      annotations: [
        note('a1', 'R1', 'stale', { closedBy: 'agent', closedFrom: 'addressed' }),
        note('a2', 'R1', 'approved', { closedBy: 'user', closedFrom: 'addressed' }),
      ],
    }
    await render()
    await expandRound('R1')
    expect(byTestId('review-agent-closed-chip')!.textContent).toContain('1 on your instruction')
    await click(byTestId('review-closed-toggle'))
    const rows = container.querySelectorAll('[data-testid="review-closed-note"]')
    expect(rows[0].textContent).toContain('by the agent on your instruction')
    // The user's own approval is never attributed to the agent.
    expect(rows[1].textContent).toContain('by you')
  })
})

describe('settled work reopens — the only revivals there are', () => {
  beforeEach(() => {
    current = {
      canvasId: 'canvas-a',
      sessionId: SID,
      reviews: [review('R1', 'resolved', '01', { settled: { at: '2026-08-22T09:05:00Z', by: 'decision', versionId: 'v8' } })],
      annotations: [
        note('a1', 'R1', 'stale', { closedBy: 'decision', closedFrom: 'addressed', settledBy: { versionId: 'v8' } }),
        note('a2', 'R1', 'stale', { closedBy: 'decision', closedFrom: 'open', settledBy: { versionId: 'v8' } }),
      ],
    }
  })

  it('reopens one note', async () => {
    await render()
    await expandRound('R1')
    await click(byTestId('review-closed-toggle'))
    await click(byTestId('review-reopen-note'))
    expect(reopens).toEqual(['a1'])
    expect(current.annotations[0].state).toBe('addressed')
    expect(current.reviews[0].status).toBe('submitted')
  })

  it('reopens the whole round, naming the canvas it was composed against', async () => {
    await render()
    await expandRound('R1')
    await click(byTestId('review-reopen-round'))
    expect(roundReopens).toEqual([{ canvasId: 'canvas-a', reviewId: 'R1' }])
    expect(current.reviews[0].status).toBe('submitted')
    expect(current.annotations.map((a) => a.state)).toEqual(['addressed', 'open'])
  })

  it('offers no round reopen on a LIVE round — there is nothing to bring back', async () => {
    current = {
      canvasId: 'canvas-a',
      sessionId: SID,
      reviews: [review('R1', 'submitted', '01')],
      annotations: [note('a1', 'R1', 'addressed'), note('a2', 'R1', 'stale', { closedBy: 'agent', closedFrom: 'addressed' })],
    }
    await render()
    await expandRound('R1')
    expect(byTestId('review-reopen-round')).toBeNull()
  })
})
