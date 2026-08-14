// Canvas continuity across CCC session identities (2026-08-14, the VM "repush"
// bug): a canvas is keyed to the session id, but that id changes on a fresh
// tile / non-restored relaunch while the WORK (project dir, conversation)
// stays the same. renderVersion stamps the work's identity onto the record;
// adoptCanvasForSession moves an orphaned canvas to the new session; the
// review store follows (rebind + load-time self-heal).
//
// Observed failure being locked out: same conversation resumed the next day →
// pane empty → "repush" minted a second canvas, both called v1.

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { vi } from 'vitest'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-adopt-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const store = await import('../../../src/main/canvas/canvas-store')
const reviews = await import('../../../src/main/canvas/canvas-review-store')

const SID_A = 'aaaa1111aaaa1111aaaa1111'
const SID_B = 'bbbb2222bbbb2222bbbb2222'
const SID_C = 'cccc3333cccc3333cccc3333'
const CONV_1 = '8c25bfdc-57d3-4894-8f4f-e234fb583791'
const CONV_2 = '59596c8b-1270-489b-8970-dcbc51a33e47'

const CWD = path.join(getResourcesDirectory(), 'project')
const OTHER_CWD = path.join(getResourcesDirectory(), 'elsewhere')

const notCurrent = () => false
const allCurrent = () => true

function canvasJson(canvasId: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(getResourcesDirectory(), 'canvas', canvasId, 'canvas.json'), 'utf8'),
  )
}

function reviewsJson(canvasId: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews.json'), 'utf8'),
  )
}

/** Render one design version for a session with the given stamps in place. */
function renderAs(sessionId: string, cwd: string | undefined, conversationUuid: string | undefined, body: string) {
  store.setCanvasSessionInfoResolver(() => ({ cwd, conversationUuid }))
  return store.renderVersion(sessionId, { mode: 'design', html: `<!doctype html><p>${body}</p>` })
}

/** Simulate an app restart: all in-memory state gone, disk untouched. */
function restart() {
  store._resetCanvasStoreForTest()
  reviews._resetCanvasReviewStoreForTest()
}

beforeEach(() => {
  restart()
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
})

afterAll(() => {
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('renderVersion stamps the work identity', () => {
  it('stamps cwd once and refreshes conversationUuid per render', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    let record = canvasJson(canvasId)
    expect(record.cwd).toBe(CWD)
    expect(record.conversationUuid).toBe(CONV_1)

    // Second render under a different resolver cwd + conversation: cwd holds
    // (the canvas belongs to the project it was born in), conversation follows.
    renderAs(SID_A, OTHER_CWD, CONV_2, 'two')
    record = canvasJson(canvasId)
    expect(record.cwd).toBe(CWD)
    expect(record.conversationUuid).toBe(CONV_2)
  })

  it('renders fine with no resolver and with a throwing resolver', () => {
    store.setCanvasSessionInfoResolver(null)
    const first = store.renderVersion(SID_A, { mode: 'design', html: '<!doctype html><p>a</p>' })
    expect(first.versionId).toBe('v1')
    expect(canvasJson(first.canvasId).cwd).toBeUndefined()

    store.setCanvasSessionInfoResolver(() => {
      throw new Error('resolver exploded')
    })
    const second = store.renderVersion(SID_A, { mode: 'design', html: '<!doctype html><p>b</p>' })
    expect(second.versionId).toBe('v2')
  })
})

describe('adoptCanvasForSession', () => {
  it('moves an orphaned canvas to a new session by cwd, and the next render continues its versions', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    restart()

    const adopted = store.adoptCanvasForSession(SID_B, { cwd: CWD, isSessionCurrent: notCurrent })
    expect(adopted).toEqual({ canvasId, activeVersionId: 'v1' })

    // The new session sees the canvas; the old session no longer owns it.
    expect(store.getCanvasStateForSession(SID_B)?.canvasId).toBe(canvasId)
    expect(store.getCanvasStateForSession(SID_A)).toBeNull()
    expect(canvasJson(canvasId).sessionId).toBe(SID_B)

    // THE bug being locked out: the next render is v2 on the SAME canvas, not
    // v1 on a parallel one.
    const next = renderAs(SID_B, CWD, CONV_1, 'two')
    expect(next).toEqual({ canvasId, versionId: 'v2' })
  })

  it('prefers the conversation match over a more recent cwd match', () => {
    // Older canvas under conversation 1; newer canvas in the same cwd under
    // conversation 2. A session resuming conversation 1 wants the FIRST.
    const conv = renderAs(SID_A, CWD, CONV_1, 'conv-match')
    const newer = renderAs(SID_B, CWD, CONV_2, 'newer-cwd-match')
    expect(conv.canvasId).not.toBe(newer.canvasId)
    restart()

    const adopted = store.adoptCanvasForSession(SID_C, {
      cwd: CWD,
      conversationUuid: CONV_1,
      isSessionCurrent: notCurrent,
    })
    expect(adopted?.canvasId).toBe(conv.canvasId)
  })

  it('falls back to the most recently rendered cwd match', async () => {
    const first = renderAs(SID_A, CWD, undefined, 'older')
    // Version timestamps are ISO strings; ensure strict ordering.
    await new Promise((r) => setTimeout(r, 5))
    const second = renderAs(SID_B, CWD, undefined, 'newer')
    restart()

    const adopted = store.adoptCanvasForSession(SID_C, { cwd: CWD, isSessionCurrent: notCurrent })
    expect(adopted?.canvasId).toBe(second.canvasId)
    expect(first.canvasId).not.toBe(second.canvasId)
  })

  it('never touches a canvas whose owner is still current, and never re-homes a session that owns one', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    restart()

    // Owner live or saved → untouchable; the asker gets nothing.
    expect(store.adoptCanvasForSession(SID_B, { cwd: CWD, isSessionCurrent: allCurrent })).toBeNull()
    expect(canvasJson(canvasId).sessionId).toBe(SID_A)

    // A session that already owns a canvas never adopts another.
    renderAs(SID_B, OTHER_CWD, undefined, 'mine')
    const again = store.adoptCanvasForSession(SID_B, { cwd: CWD, isSessionCurrent: notCurrent })
    expect(again).toBeNull()
  })

  it('adopts nothing without a matching stamp (legacy records stay put)', () => {
    // A record from before the stamps existed: strip them off disk.
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'legacy')
    const record = canvasJson(canvasId)
    delete record.cwd
    delete record.conversationUuid
    fs.writeFileSync(
      path.join(getResourcesDirectory(), 'canvas', canvasId, 'canvas.json'),
      JSON.stringify(record, null, 2),
    )
    restart()

    // No stamps → no match → no adoption; but the record itself still loads
    // for its own session (backward compatibility).
    expect(store.adoptCanvasForSession(SID_B, { cwd: CWD, isSessionCurrent: notCurrent })).toBeNull()
    expect(store.getCanvasStateForSession(SID_A)?.canvasId).toBe(canvasId)
  })

  const winIt = process.platform === 'win32' ? it : it.skip
  winIt('matches cwd case-insensitively with trailing separators on Windows', () => {
    const { canvasId } = renderAs(SID_A, CWD, undefined, 'one')
    restart()
    const sloppy = CWD.toUpperCase() + path.sep
    const adopted = store.adoptCanvasForSession(SID_B, { cwd: sloppy, isSessionCurrent: notCurrent })
    expect(adopted?.canvasId).toBe(canvasId)
  })
})

describe('reviews follow the adoption', () => {
  function submitOneReview(sessionId: string): { reviewId: string } {
    const { annotationId, state } = reviews.upsertAnnotation(sessionId, {
      scope: 'general',
      note: 'the header wraps at 1280',
      versionId: 'v1',
    })
    const draft = state.reviews.find((r) => r.status === 'draft')!
    reviews.submitReview(sessionId, draft.id, [])
    expect(annotationId).toBeTruthy()
    return { reviewId: draft.id }
  }

  it('rebindReviewsToSession moves reviews.json to the new owner', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    const { reviewId } = submitOneReview(SID_A)
    restart()

    const adopted = store.adoptCanvasForSession(SID_B, { cwd: CWD, isSessionCurrent: notCurrent })
    expect(adopted?.canvasId).toBe(canvasId)
    reviews.rebindReviewsToSession(canvasId, SID_B)

    const onDisk = reviewsJson(canvasId)
    expect(onDisk.sessionId).toBe(SID_B)
    expect((onDisk.reviews as Array<{ canvas: { sessionId: string } }>)[0].canvas.sessionId).toBe(SID_B)

    // The adopted session reads its review history; the store is NOT broken.
    const state = reviews.getReviewStateForSession(SID_B)
    expect(state?.reviews.map((r) => r.id)).toEqual([reviewId])
    expect(reviews.getReviewPayload(SID_B, reviewId).payload.review.id).toBe(reviewId)
  })

  it('self-heals a stale owner on load (crash between the two rebind persists)', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    const { reviewId } = submitOneReview(SID_A)
    restart()

    // Canvas re-binds, then the app dies before the review rebind runs.
    store.adoptCanvasForSession(SID_B, { cwd: CWD, isSessionCurrent: notCurrent })
    restart()

    // Next launch: the canvas record says SID_B, reviews.json still says SID_A.
    // A plain read under the new owner self-heals instead of marking broken.
    expect(store.getCanvasStateForSession(SID_B)?.canvasId).toBe(canvasId)
    const state = reviews.getReviewStateForSession(SID_B)
    expect(state?.reviews.map((r) => r.id)).toEqual([reviewId])
    expect(reviewsJson(canvasId).sessionId).toBe(SID_B)

    // And mutations under the new owner work (the store never went broken).
    const upserted = reviews.upsertAnnotation(SID_B, {
      scope: 'general',
      note: 'second round note',
      versionId: 'v1',
    })
    expect(upserted.annotationId).toBeTruthy()
  })

  it('a genuinely corrupt reviews.json still refuses (adoption does not soften BROKEN)', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    submitOneReview(SID_A)
    fs.writeFileSync(
      path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews.json'),
      '{"canvasId": "someone-else", "sessionId": "x"}',
    )
    restart()

    store.adoptCanvasForSession(SID_B, { cwd: CWD, isSessionCurrent: notCurrent })
    reviews.rebindReviewsToSession(canvasId, SID_B)
    // Broken store: reads answer empty, mutations refuse, file untouched.
    expect(reviews.getReviewStateForSession(SID_B)?.reviews).toEqual([])
    expect(() =>
      reviews.upsertAnnotation(SID_B, { scope: 'general', note: 'x', versionId: 'v1' }),
    ).toThrow(/unreadable/i)
    expect((reviewsJson(canvasId) as { canvasId: string }).canvasId).toBe('someone-else')
  })
})
