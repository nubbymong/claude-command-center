// canvas:reviewDismissAll — the Canvas button's right-click sweep. The handler
// composes the two existing user-driven mutations (closeOutCanvasReviews +
// clearAwaitingReview) over exactly the rows the queue number counts, so these
// tests pin the composition: scope filter, the verdict gate, the unreadable
// rule, and Zod rejection before any store call. Store behaviour itself is
// pinned by canvas-closeout-store.test.ts / canvas-store tests.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { IPC } from '../../../src/shared/ipc-channels'
import type { CanvasLibraryEntry } from '../../../src/shared/canvas'

/** A full CanvasReviewCounts, since the handler READS it per owned row (it does
 *  NOT read verdictRounds/openReviewCount off the library entry — those are set
 *  only by the listAll join, a different call). Mocking listAllCanvases with
 *  those fields pre-injected was exactly what hid the dead-branch bug, so these
 *  tests drive the real join through getReviewCountsForCanvas instead. */
const counts = (over: Partial<{ verdictRounds: number; openReviewIds: string[]; closeableNotes: number }> = {}) => ({
  draftNotes: 0,
  draftVersionIds: [] as string[],
  openReviewIds: [] as string[],
  openNotes: 0,
  addressedNotes: 0,
  closeableNotes: 0,
  verdictRounds: 0,
  ...over,
})

const handlers = new Map<string, (...a: unknown[]) => unknown>()
const listeners = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn),
    on: (ch: string, fn: (...a: unknown[]) => unknown) => listeners.set(ch, fn),
  },
  BrowserWindow: vi.fn(),
}))

const canvasStore = vi.hoisted(() => ({
  clearAwaitingReview: vi.fn(),
  deleteCanvas: vi.fn(),
  getCanvasStateForSession: vi.fn(),
  listAllCanvases: vi.fn(() => [] as CanvasLibraryEntry[]),
  onCanvasChanged: vi.fn(() => () => {}),
  renderVersion: vi.fn(),
  setActiveVersion: vi.fn(),
}))
vi.mock('../../../src/main/canvas/canvas-store', () => canvasStore)

const reviewStore = vi.hoisted(() => ({
  MAX_SKETCH_PNG_BYTES: 2 * 1024 * 1024,
  closeOutCanvasReviews: vi.fn(),
  deleteAnnotation: vi.fn(),
  dropReviewsForCanvas: vi.fn(),
  getReviewCountsForCanvas: vi.fn(),
  getReviewStateForSession: vi.fn(),
  markAddressedNotesSeen: vi.fn(),
  onReviewChanged: vi.fn(() => () => {}),
  reopenAnnotation: vi.fn(),
  resolveAnnotation: vi.fn(),
  submitReview: vi.fn(),
  upsertAnnotation: vi.fn(),
}))
vi.mock('../../../src/main/canvas/canvas-review-store', () => reviewStore)

vi.mock('../../../src/main/canvas/canvas-snapshot-broker', () => ({
  resolveCanvasSnapshot: vi.fn(),
  setSnapshotSender: vi.fn(),
}))

const sessionLink = vi.hoisted(() => ({
  canvasCwdForSession: vi.fn(() => 'F:/proj' as string | undefined),
  installCanvasSessionLink: vi.fn(),
  listReclaimableCanvases: vi.fn(),
  reclaimCanvasForSession: vi.fn(),
}))
vi.mock('../../../src/main/canvas/canvas-session-link', () => sessionLink)

const { registerCanvasHandlers } = await import('../../../src/main/ipc/canvas-handlers')

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'
const invoke = (args: unknown) => handlers.get(IPC.CANVAS_REVIEW_DISMISS_ALL)!({} as never, args)

const entry = (over: Partial<CanvasLibraryEntry> & { canvasId: string }): CanvasLibraryEntry => ({
  versionCount: 1,
  createdAt: '2026-08-24T00:00:00.000Z',
  lastRenderedAt: '2026-08-24T00:00:00.000Z',
  ...over,
})

beforeEach(() => {
  handlers.clear()
  listeners.clear()
  vi.clearAllMocks()
  sessionLink.canvasCwdForSession.mockReturnValue('F:/proj')
  canvasStore.listAllCanvases.mockReturnValue([])
  registerCanvasHandlers(() => null)
})

describe('validation — rejects before any store call', () => {
  it.each([
    [{}],
    [{ sessionId: '../evil' }],
    [{ sessionId: SID, extra: 1 }],
    [{ sessionId: SID, openTileSessionIds: ['bad id!'] }],
  ])('rejects %j', async (args) => {
    await expect(invoke(args)).rejects.toThrow()
    expect(canvasStore.listAllCanvases).not.toHaveBeenCalled()
    expect(reviewStore.closeOutCanvasReviews).not.toHaveBeenCalled()
    expect(canvasStore.clearAwaitingReview).not.toHaveBeenCalled()
  })
})

describe('scope — exactly the rows the queue counts', () => {
  it('resolves the project scope in main and passes the session through', async () => {
    await invoke({ sessionId: SID, openTileSessionIds: [SID] })
    expect(sessionLink.canvasCwdForSession).toHaveBeenCalledWith(SID)
    expect(canvasStore.listAllCanvases).toHaveBeenCalledWith([SID], 'F:/proj', SID)
  })

  it('never touches a canvas belonging to another session', async () => {
    canvasStore.listAllCanvases.mockReturnValue([
      entry({ canvasId: 'foreign-1', awaitingReview: true, awaitingReviewAt: '2026-08-24T00:00:00.000Z' }),
    ])
    // Even if the store WOULD report a full round on it, the row is skipped
    // before any count is read.
    reviewStore.getReviewCountsForCanvas.mockReturnValue(counts({ verdictRounds: 3 }))
    const res = await invoke({ sessionId: SID })
    expect(reviewStore.getReviewCountsForCanvas).not.toHaveBeenCalled()
    expect(reviewStore.closeOutCanvasReviews).not.toHaveBeenCalled()
    expect(canvasStore.clearAwaitingReview).not.toHaveBeenCalled()
    expect(res).toEqual({ closedNotes: 0, closedReviews: 0, clearedAwaiting: 0, unreadable: 0 })
  })

  it('sweeps owned rows and the active row alike', async () => {
    reviewStore.closeOutCanvasReviews.mockReturnValue({ closed: 2, reviews: ['R1', 'R2'] })
    canvasStore.listAllCanvases.mockReturnValue([
      entry({ canvasId: 'own-1', ownedByThisSession: true }),
      entry({ canvasId: 'own-2', ownedByThisSession: true, isActiveForThisSession: true, awaitingReview: true, awaitingReviewAt: '2026-08-24T00:00:00.000Z' }),
    ])
    reviewStore.getReviewCountsForCanvas.mockImplementation((id: string) =>
      id === 'own-1' ? counts({ verdictRounds: 2, openReviewIds: ['R1', 'R2'] }) : counts(),
    )
    const res = await invoke({ sessionId: SID })
    expect(reviewStore.closeOutCanvasReviews).toHaveBeenCalledTimes(1)
    expect(reviewStore.closeOutCanvasReviews).toHaveBeenCalledWith('own-1')
    expect(canvasStore.clearAwaitingReview).toHaveBeenCalledTimes(1)
    expect(canvasStore.clearAwaitingReview).toHaveBeenCalledWith('own-2')
    expect(res).toEqual({ closedNotes: 2, closedReviews: 2, clearedAwaiting: 1, unreadable: 0 })
  })
})

describe('gates — the sweep clears what the number promised, nothing else', () => {
  it('skips close-out where the label counted no verdict rounds', async () => {
    canvasStore.listAllCanvases.mockReturnValue([
      // Open notes are with the AGENT; a close-out here would be refused
      // per-round anyway, but the handler must not even try.
      entry({ canvasId: 'own-1', ownedByThisSession: true }),
    ])
    reviewStore.getReviewCountsForCanvas.mockReturnValue(counts({ verdictRounds: 0, openReviewIds: ['R1'] }))
    const res = await invoke({ sessionId: SID })
    expect(reviewStore.closeOutCanvasReviews).not.toHaveBeenCalled()
    expect(res.closedNotes).toBe(0)
  })

  it('reports an unreadable review store, never folds it into zero', async () => {
    canvasStore.listAllCanvases.mockReturnValue([
      entry({ canvasId: 'own-1', ownedByThisSession: true }),
      entry({ canvasId: 'own-2', ownedByThisSession: true, awaitingReview: true, awaitingReviewAt: '2026-08-24T00:00:00.000Z' }),
    ])
    // null read = unreadable store (the queue's own "unknown" rule).
    reviewStore.getReviewCountsForCanvas.mockImplementation((id: string) => (id === 'own-1' ? null : counts()))
    const res = await invoke({ sessionId: SID })
    expect(res.unreadable).toBe(1)
    expect(res.clearedAwaiting).toBe(1)
  })

  it('a close-out that returns null adds nothing to the tallies', async () => {
    reviewStore.closeOutCanvasReviews.mockReturnValue(null)
    canvasStore.listAllCanvases.mockReturnValue([
      entry({ canvasId: 'own-1', ownedByThisSession: true }),
    ])
    reviewStore.getReviewCountsForCanvas.mockReturnValue(counts({ verdictRounds: 1, openReviewIds: ['R1'] }))
    const res = await invoke({ sessionId: SID })
    expect(res.closedNotes).toBe(0)
    expect(res.closedReviews).toBe(0)
  })
})
