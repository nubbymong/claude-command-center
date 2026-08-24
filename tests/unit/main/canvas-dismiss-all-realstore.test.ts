/**
 * canvas:reviewDismissAll — REAL-STORE regression (guards adversarial finding F1).
 *
 * The sibling canvas-dismiss-all.test.ts mocks listAllCanvases and drives the
 * count join through a mocked getReviewCountsForCanvas. That is fast but it once
 * MASKED a real bug: the handler used to read e.verdictRounds / e.openReviewCount
 * off the library entry, and the mock hand-injected those fields — which the REAL
 * listAllCanvases never sets (only the CANVAS_LIST_ALL join loop does). So the
 * close-out branch was dead and `unreadable` was inflated to the owned-row count.
 *
 * This file wires the REAL canvas-store + canvas-review-store behind the real
 * handler, so the entries the handler reads are exactly what listAllCanvases
 * produces. It fails against the pre-fix handler and passes against the fixed one
 * (which reads counts via getReviewCountsForCanvas, like CANVAS_LIST_ALL).
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { IPC } from '../../../src/shared/ipc-channels'

// ── Mocks: only the leaves. canvas-store + canvas-review-store are REAL. ──────
vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-da-realstore-'))
  return { getResourcesDirectory: () => dir }
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

vi.mock('../../../src/main/canvas/canvas-snapshot-broker', () => ({
  resolveCanvasSnapshot: vi.fn(),
  setSnapshotSender: vi.fn(),
}))

// The session→cwd resolver is main-owned; here it is a knob so the handler's
// project scope points at our temp project.
const sessionLink = vi.hoisted(() => ({
  canvasCwdForSession: vi.fn<(sid: string) => string | undefined>(),
  installCanvasSessionLink: vi.fn(),
  listReclaimableCanvases: vi.fn(() => []),
  reclaimCanvasForSession: vi.fn(() => false),
}))
vi.mock('../../../src/main/canvas/canvas-session-link', () => sessionLink)

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const canvasStore = await import('../../../src/main/canvas/canvas-store')
const reviewStore = await import('../../../src/main/canvas/canvas-review-store')
const { registerCanvasHandlers } = await import('../../../src/main/ipc/canvas-handlers')

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'
const SID_B = 'f9e8d7c6b5a4f3e2d1c0b9a8'
const PROJECT = path.join(getResourcesDirectory(), 'proj')

const reviewsPath = (canvasId: string) => path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews.json')

const dismissAll = (args: unknown) => handlers.get(IPC.CANVAS_REVIEW_DISMISS_ALL)!({} as never, args)
const listAll = (args: unknown) => handlers.get(IPC.CANVAS_LIST_ALL)!({} as never, args)

/** A reviews.json with one SUBMITTED review holding one ADDRESSED note — a round
 *  waiting on the user (verdictRounds === 1, closeable). */
function seedAddressedReview(canvasId: string, versionId: string): void {
  const record = {
    canvasId,
    sessionId: SID,
    nextReview: 2,
    nextAnnotation: 2,
    reviews: [
      {
        id: 'R1',
        status: 'submitted',
        versionId,
        annotationIds: ['a1'],
        createdAt: '2026-08-24T00:00:00.000Z',
        canvas: { canvasId, sessionId: SID },
      },
    ],
    annotations: [
      { id: 'a1', reviewId: 'R1', scope: 'general', note: 'please fix the header', versionId, state: 'addressed' },
    ],
  }
  fs.writeFileSync(reviewsPath(canvasId), JSON.stringify(record, null, 2))
  reviewStore._resetCanvasReviewStoreForTest() // force a cold read from disk
}

function renderOwned(sessionId: string, cwd: string | undefined, title: string) {
  canvasStore.setCanvasSessionInfoResolver(() => ({ cwd, conversationUuid: undefined, profileId: undefined }))
  return canvasStore.renderVersion(sessionId, { mode: 'design', title, html: `<!doctype html><p>${title}</p>` })
}

beforeEach(() => {
  handlers.clear()
  listeners.clear()
  vi.clearAllMocks()
  canvasStore._resetCanvasStoreForTest()
  reviewStore._resetCanvasReviewStoreForTest()
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
  sessionLink.canvasCwdForSession.mockImplementation((sid: string) => (sid === SID ? PROJECT : undefined))
  registerCanvasHandlers(() => null)
})

afterAll(() => {
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('the handler must NOT rely on entry fields listAllCanvases never sets', () => {
  it('a freshly rendered owned row has verdictRounds & openReviewCount UNDEFINED', () => {
    const { canvasId } = renderOwned(SID, PROJECT, 'root cause')
    const row = canvasStore.listAllCanvases([], PROJECT, SID).find((e) => e.canvasId === canvasId)!
    expect(row.ownedByThisSession).toBe(true)
    // These two fields are set ONLY by the CANVAS_LIST_ALL join loop, never by
    // listAllCanvases. Dismiss-all is a different call, so it must read counts
    // itself — which the fixed handler does.
    expect(row.verdictRounds).toBeUndefined()
    expect(row.openReviewCount).toBeUndefined()
  })
})

describe('end-to-end: the sweep actually closes verdict rounds and tallies honestly', () => {
  it('a closeable verdict round LIST_ALL reports is the one DISMISS_ALL then closes', async () => {
    const { canvasId, versionId } = renderOwned(SID, PROJECT, 'checkout')
    seedAddressedReview(canvasId, versionId)

    // Ground truth via the same store the queue number uses.
    const counts = reviewStore.getReviewCountsForCanvas(canvasId)
    expect(counts?.verdictRounds).toBe(1)
    expect(counts?.closeableNotes).toBe(1)

    // The LIST_ALL IPC (which does the join) reports the round on the pill.
    const listRow = (
      (await listAll({ sessionId: SID, openTileSessionIds: [] })) as { canvasId: string; verdictRounds?: number }[]
    ).find((e) => e.canvasId === canvasId)!
    expect(listRow.verdictRounds).toBe(1)

    // The gesture: "clear my whole canvas queue".
    const res = (await dismissAll({ sessionId: SID })) as {
      closedNotes: number
      closedReviews: number
      clearedAwaiting: number
      unreadable: number
    }

    // It closed the round it promised, and did not mis-report a readable store.
    expect(res.closedNotes).toBe(1)
    expect(res.closedReviews).toBe(1)
    expect(res.unreadable).toBe(0)

    // The note is now closed (stale), verdict-owed no more.
    reviewStore._resetCanvasReviewStoreForTest()
    expect(reviewStore.getReviewCountsForCanvas(canvasId)?.verdictRounds).toBe(0)
    const onDisk = JSON.parse(fs.readFileSync(reviewsPath(canvasId), 'utf8'))
    expect(onDisk.annotations[0].state).toBe('stale')
    expect(onDisk.annotations[0].closedBy).toBe('user')
  })

  it('open (agent-side) notes are left alone — the sweep clears only what waits on the user', async () => {
    const { canvasId, versionId } = renderOwned(SID, PROJECT, 'open notes')
    // One submitted review with an OPEN note (waiting on the agent): not the
    // user's to clear, so dismiss-all must not touch it.
    const record = {
      canvasId,
      sessionId: SID,
      nextReview: 2,
      nextAnnotation: 2,
      reviews: [
        { id: 'R1', status: 'submitted', versionId, annotationIds: ['a1'], createdAt: '2026-08-24T00:00:00.000Z', canvas: { canvasId, sessionId: SID } },
      ],
      annotations: [{ id: 'a1', reviewId: 'R1', scope: 'general', note: 'still open', versionId, state: 'open' }],
    }
    fs.writeFileSync(reviewsPath(canvasId), JSON.stringify(record, null, 2))
    reviewStore._resetCanvasReviewStoreForTest()

    const res = (await dismissAll({ sessionId: SID })) as { closedNotes: number }
    expect(res.closedNotes).toBe(0)
    reviewStore._resetCanvasReviewStoreForTest()
    const onDisk = JSON.parse(fs.readFileSync(reviewsPath(canvasId), 'utf8'))
    expect(onDisk.annotations[0].state).toBe('open')
  })
})

describe('scope holds: openTileSessionIds cannot widen the sweep', () => {
  it('no openTileSessionIds value flips a foreign canvas to owned/active', () => {
    const { canvasId } = renderOwned(SID_B, PROJECT, 'not mine')
    const row = canvasStore
      .listAllCanvases([SID_B, SID, 'cccc3333cccc3333cccc3333'], PROJECT, SID)
      .find((e) => e.canvasId === canvasId)!
    expect(row.ownedByThisSession).toBeUndefined()
    expect(row.isActiveForThisSession).toBeUndefined()
  })

  it('a foreign canvas with a real verdict round is never swept', async () => {
    const { canvasId, versionId } = renderOwned(SID_B, PROJECT, 'foreign round')
    // Seed a closeable round owned by SID_B.
    const record = {
      canvasId,
      sessionId: SID_B,
      nextReview: 2,
      nextAnnotation: 2,
      reviews: [
        { id: 'R1', status: 'submitted', versionId, annotationIds: ['a1'], createdAt: '2026-08-24T00:00:00.000Z', canvas: { canvasId, sessionId: SID_B } },
      ],
      annotations: [{ id: 'a1', reviewId: 'R1', scope: 'general', note: 'not yours', versionId, state: 'addressed' }],
    }
    fs.writeFileSync(reviewsPath(canvasId), JSON.stringify(record, null, 2))
    reviewStore._resetCanvasReviewStoreForTest()

    // SID sweeps; the foreign round must survive untouched.
    const res = (await dismissAll({ sessionId: SID, openTileSessionIds: [SID_B] })) as { closedNotes: number }
    expect(res.closedNotes).toBe(0)
    reviewStore._resetCanvasReviewStoreForTest()
    expect(JSON.parse(fs.readFileSync(reviewsPath(canvasId), 'utf8')).annotations[0].state).toBe('addressed')
  })
})
