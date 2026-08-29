// @vitest-environment jsdom
//
// The RESUME signal (M4/W37): ownerless canvas work on this project, offered
// where the user already looks for canvas state — a quiet dot on the Canvas
// button, and a second section in the queue popover.
//
// The whole point of the design is that it stays SEPARATE from the review
// queue. The queue is what this session owes an answer on; a resumable is work
// nobody currently holds. Folding them together would make one number mean two
// things and would let spare work borrow the loud "Review needed" state, which
// is the one thing the button's colour is reserved for. Most of these tests
// exist to keep that line drawn.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import AgentCanvasButton from '../../../src/renderer/components/AgentCanvasButton'
import CanvasQueuePopover from '../../../src/renderer/components/CanvasQueuePopover'
import { CONFIRM_GUARD_MS } from '../../../src/renderer/hooks/useArmedConfirm'
import { useCanvasStore } from '../../../src/renderer/stores/canvasStore'
import { useCanvasReviewStore } from '../../../src/renderer/stores/canvasReviewStore'
import { useCanvasTotalsStore } from '../../../src/renderer/stores/canvasTotalsStore'
import { useExcalidrawStore } from '../../../src/renderer/stores/excalidrawStore'
import { useSessionStore } from '../../../src/renderer/stores/sessionStore'
import type { CanvasLibraryEntry, ResumableRow } from '../../../src/shared/canvas'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

const SID = 'session-1'

const getState = vi.fn(async () => null)
const reviewGetState = vi.fn(async () => null)
const listAll = vi.fn(async () => [] as CanvasLibraryEntry[])
const listResumables = vi.fn(async () => [] as ResumableRow[])
const resume = vi.fn(async () => ({ ok: true }) as { ok: boolean; reason?: string })
const dismiss = vi.fn(async () => ({ ok: true }) as { ok: boolean; reason?: string })
const reclaim = vi.fn(async () => ({ ok: true, state: null }))

;(globalThis as any).window.electronAPI = {
  ...((globalThis as any).window?.electronAPI ?? {}),
  canvas: {
    ...((globalThis as any).window?.electronAPI?.canvas ?? {}),
    onChanged: () => () => {},
    onReviewChanged: () => () => {},
    getState,
    reviewGetState,
    listAll,
    listResumables,
    resume,
    dismiss,
    reclaim,
  },
}

const row = (over: Partial<ResumableRow> = {}): ResumableRow => ({
  canvasId: 'r1',
  title: 'Login flow',
  kind: 'pack',
  noteCount: 6,
  lastRenderedAt: '2026-08-28T16:42:00Z',
  expectedOwnerSessionId: 'dead-session',
  ...over,
})

const owedEntry = (over: Partial<CanvasLibraryEntry> = {}): CanvasLibraryEntry =>
  ({
    canvasId: 'owed-1',
    versionCount: 1,
    createdAt: '2026-08-29T09:00:00Z',
    lastRenderedAt: '2026-08-29T09:00:00Z',
    ownedByThisSession: true,
    awaitingReview: true,
    title: 'Working pill',
    ...over,
  }) as CanvasLibraryEntry

let container: HTMLDivElement
let root: Root

/** The three hydration reads chain several awaits deep (the totals refresh
 *  reads resumables, then the listing, then sets), so a couple of microtask
 *  ticks is not enough — settle on a macrotask. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0))
  })
}

async function renderButton(): Promise<void> {
  await act(async () => {
    root.render(<AgentCanvasButton sessionId={SID} />)
  })
  await settle()
}

async function renderPopover(onClose = () => {}): Promise<void> {
  await useCanvasTotalsStore.getState().refresh(SID)
  await act(async () => {
    root.render(<CanvasQueuePopover sessionId={SID} onClose={onClose} />)
  })
  await settle()
}

const testid = (id: string): HTMLElement | null => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const testids = (id: string): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`))

function click(el: Element | null): void {
  expect(el, 'expected element to click').toBeTruthy()
  act(() => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

async function clickAsync(el: Element | null): Promise<void> {
  expect(el, 'expected element to click').toBeTruthy()
  await act(async () => {
    el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
  await settle()
}

let nowSpy: ReturnType<typeof vi.spyOn> | null = null
afterEach(() => {
  nowSpy?.mockRestore()
  nowSpy = null
  // UNMOUNT, not just detach. A left-mounted button keeps its store
  // subscriptions, and the next test's `reset()` re-fires its hydration effect
  // — with the previous test's mocks still in place, which lands stale totals
  // over the fresh ones and reads as a product bug.
  act(() => root.unmount())
})

beforeEach(() => {
  useCanvasStore.getState().reset()
  useCanvasReviewStore.getState().reset()
  useCanvasTotalsStore.getState().reset()
  useExcalidrawStore.getState().setOpen(SID, false)
  useSessionStore.setState({ sessions: [] as never })
  for (const m of [getState, reviewGetState, listAll, listResumables, resume, dismiss, reclaim]) m.mockClear()
  getState.mockResolvedValue(null)
  reviewGetState.mockResolvedValue(null)
  listAll.mockResolvedValue([])
  listResumables.mockResolvedValue([])
  resume.mockResolvedValue({ ok: true })
  dismiss.mockResolvedValue({ ok: true })
  document.body.innerHTML = ''
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

describe('the Canvas button dot', () => {
  it('is drawn, and named, when work is going spare', async () => {
    listResumables.mockResolvedValue([row()])
    await renderButton()
    const dot = testid('canvas-resume-dot')!
    expect(dot.getAttribute('data-empty')).toBeNull()
    expect(dot.querySelector('svg')).toBeTruthy()
    // Not a decoration: it has to say what it means to a screen reader too.
    expect(dot.querySelector('svg')!.getAttribute('aria-label')).toBe(
      'Unfinished canvas work can be resumed',
    )
    expect(testid('canvas-button')!.getAttribute('title')).toContain('can be resumed')
  })

  it('reserves its slot while idle so the button never widens under the cursor', async () => {
    // The dot arrives from a background sweep, not a click. A slot that only
    // existed when filled would shove every tool to its right the moment main
    // answered — the same failure ReservedLabel exists to prevent for the word.
    await renderButton()
    const empty = testid('canvas-resume-dot')
    expect(empty, 'the slot is present while idle').toBeTruthy()
    expect(empty!.getAttribute('data-empty')).toBe('true')
    expect(empty!.querySelector('svg'), 'nothing is drawn in it').toBeNull()
    expect(empty!.getAttribute('title'), 'and it names nothing').toBeNull()
  })

  it('never appears in the loud state — a review owed outranks work going spare', async () => {
    listAll.mockResolvedValue([owedEntry()])
    listResumables.mockResolvedValue([row()])
    await renderButton()
    expect(testid('reserved-label-current')!.textContent).toBe('Review needed')
    expect(testid('canvas-resume-dot'), 'no dot beside Review needed').toBeNull()
  })

  it('never appears while the pane is open', async () => {
    useExcalidrawStore.getState().setOpen(SID, true)
    listResumables.mockResolvedValue([row()])
    await renderButton()
    expect(testid('reserved-label-current')!.textContent).toBe('Terminal')
    expect(testid('canvas-resume-dot')).toBeNull()
  })

  it('spare work is NOT the review queue: no count chip, no warning label', async () => {
    listResumables.mockResolvedValue([row(), row({ canvasId: 'r2' }), row({ canvasId: 'r3' })])
    await renderButton()
    expect(testid('reserved-label-current')!.textContent).toBe('Canvas')
    expect(testid('canvas-queue-count'), 'three resumables must not read as three reviews').toBeNull()
    expect(testid('canvas-button')!.getAttribute('data-waiting')).toBeNull()
  })
})

describe('the queue popover — the Resume section', () => {
  it('is absent when nothing is going spare', async () => {
    await renderPopover()
    expect(testid('canvas-queue-resume-section')).toBeNull()
  })

  it('sits apart from what is owed, and names each row', async () => {
    listAll.mockResolvedValue([owedEntry()])
    listResumables.mockResolvedValue([row()])
    await renderPopover()

    // Both sections, and they do not blur into one another.
    expect(testids('canvas-queue-row')).toHaveLength(1)
    const section = testid('canvas-queue-resume-section')!
    expect(section.textContent).toContain('Can be resumed')
    const r = testid('canvas-queue-resume-row')!
    expect(r.textContent).toContain('Login flow')
    expect(r.textContent).toContain('test pack')
    expect(r.textContent).toContain('6 notes')
  })

  it('Resume carries the compare-and-set token, then opens the pane and closes', async () => {
    useSessionStore.setState({ sessions: [{ id: 'tile-a' }] as never })
    listResumables.mockResolvedValue([row()])
    const onClose = vi.fn()
    await renderPopover(onClose)

    await clickAsync(testid('canvas-queue-resume-action'))
    expect(resume).toHaveBeenCalledWith({
      sessionId: SID,
      canvasId: 'r1',
      expectedOwnerSessionId: 'dead-session',
      openTileSessionIds: ['tile-a'],
    })
    expect(useExcalidrawStore.getState().bySessionId[SID]?.isOpen).toBe(true)
    expect(onClose).toHaveBeenCalled()
  })

  it('a lost race says so in plain words, refreshes, and does not open the pane', async () => {
    listResumables.mockResolvedValue([row()])
    const onClose = vi.fn()
    await renderPopover(onClose)

    resume.mockResolvedValueOnce({ ok: false, reason: 'changed' })
    listResumables.mockResolvedValue([])
    await clickAsync(testid('canvas-queue-resume-action'))

    expect(container.textContent).toContain('picked that up first')
    expect(container.textContent, 'never a raw reason code').not.toContain('changed')
    expect(useExcalidrawStore.getState().bySessionId[SID]?.isOpen ?? false).toBe(false)
    expect(onClose).not.toHaveBeenCalled()
    // Re-read on the refusal — the row must not linger.
    expect(testid('canvas-queue-resume-row')).toBeNull()
  })

  it('a live owner is refused the same way', async () => {
    listResumables.mockResolvedValue([row()])
    await renderPopover()
    resume.mockResolvedValueOnce({ ok: false, reason: 'owner-live' })
    await clickAsync(testid('canvas-queue-resume-action'))
    expect(container.textContent).toContain('picked that up first')
    expect(container.textContent).not.toContain('owner-live')
  })

  it('Dismiss arms, and the confirm names the evidence that goes with it', async () => {
    listResumables.mockResolvedValue([row()])
    await renderPopover()

    click(testid('canvas-queue-dismiss'))
    expect(dismiss).not.toHaveBeenCalled()
    const confirm = testid('canvas-queue-dismiss-confirm')!
    expect(confirm.textContent).toContain('6 notes')
    expect(confirm.textContent).toContain('evidence')

    const realNow = Date.now.bind(Date)
    nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + CONFIRM_GUARD_MS * 3)
    await clickAsync(confirm)
    expect(dismiss).toHaveBeenCalledWith({ sessionId: SID, canvasId: 'r1', openTileSessionIds: [] })
  })

  it('a note-less pack names the canvas rather than counting to zero', async () => {
    // Evidence can exist with no notes written against it yet. Same sentence as
    // the front page's confirm — one irreversible action, one wording.
    listResumables.mockResolvedValue([row({ noteCount: 0 })])
    await renderPopover()
    click(testid('canvas-queue-dismiss'))
    const confirm = testid('canvas-queue-dismiss-confirm')!
    expect(confirm.textContent).toBe('Delete this canvas and its saved evidence')
    expect(confirm.textContent).not.toContain('0 note')
  })

  it('a double-click cannot arm and discard in one gesture (#456)', async () => {
    listResumables.mockResolvedValue([row()])
    await renderPopover()
    click(testid('canvas-queue-dismiss'))
    click(testid('canvas-queue-dismiss-confirm'))
    await act(async () => { await Promise.resolve() })
    expect(dismiss).not.toHaveBeenCalled()
    expect(testid('canvas-queue-dismiss-confirm'), 'still armed').toBeTruthy()
  })

  it('the dead Verdict badge arm is gone — every queue row is a Review', async () => {
    // C1 left `review` as the only queue kind, so the badge's second arm had
    // become a colour and a word the code could never draw.
    listAll.mockResolvedValue([owedEntry()])
    await renderPopover()
    expect(testids('canvas-queue-row')).toHaveLength(1)
    expect(container.textContent).not.toContain('Verdict')
    expect(testid('canvas-queue-row')!.textContent).toContain('Review')
  })
})
