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
function renderAs(
  sessionId: string,
  cwd: string | undefined,
  conversationUuid: string | undefined,
  body: string,
  profileId?: string,
) {
  store.setCanvasSessionInfoResolver(() => ({ cwd, conversationUuid, profileId }))
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
  it('moves an orphaned canvas to the session resuming its conversation, and the next render continues its versions', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    restart()

    const adopted = store.adoptCanvasForSession(SID_B, { conversationUuid: CONV_1, isSessionCurrent: notCurrent })
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

  // ── The theft vector the 2026-08-14 adversarial pass found ────────────────
  // Adoption on a project-directory match handed one session's canvas AND the
  // user's private review notes to any other session in the same folder, with
  // no attacker involved (two tiles on one repo + a routine PTY exit). The
  // directory is not an identity; the conversation is.

  it('NEVER adopts on a project-directory match alone', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'private work')
    restart()

    // Same cwd, no conversation: a second tile in the same folder gets nothing.
    expect(store.adoptCanvasForSession(SID_B, { isSessionCurrent: notCurrent })).toBeNull()
    // ...and the canvas stays exactly where it was.
    expect(canvasJson(canvasId).sessionId).toBe(SID_A)
    expect(store.getCanvasStateForSession(SID_B)).toBeNull()
    expect(store.getCanvasStateForSession(SID_A)?.canvasId).toBe(canvasId)
  })

  it('refuses a DIFFERENT conversation even in the same directory', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    restart()
    expect(
      store.adoptCanvasForSession(SID_B, { conversationUuid: CONV_2, isSessionCurrent: notCurrent }),
    ).toBeNull()
    expect(canvasJson(canvasId).sessionId).toBe(SID_A)
  })

  it('never crosses accounts: profileId must match exactly, undefined included', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'work account', 'profile-work')
    restart()
    // Same conversation, different account → refused.
    expect(
      store.adoptCanvasForSession(SID_B, {
        conversationUuid: CONV_1,
        profileId: 'profile-personal',
        isSessionCurrent: notCurrent,
      }),
    ).toBeNull()
    // Same conversation, NO account → still refused (a profiled record does
    // not cross out to an unprofiled session).
    expect(store.adoptCanvasForSession(SID_B, { conversationUuid: CONV_1, isSessionCurrent: notCurrent })).toBeNull()
    expect(canvasJson(canvasId).sessionId).toBe(SID_A)
    // The matching account does adopt.
    const ok = store.adoptCanvasForSession(SID_B, {
      conversationUuid: CONV_1,
      profileId: 'profile-work',
      isSessionCurrent: notCurrent,
    })
    expect(ok?.canvasId).toBe(canvasId)
  })

  it('an unprofiled legacy record does not cross into a profiled session', () => {
    renderAs(SID_A, CWD, CONV_1, 'legacy')
    restart()
    expect(
      store.adoptCanvasForSession(SID_B, {
        conversationUuid: CONV_1,
        profileId: 'profile-work',
        isSessionCurrent: notCurrent,
      }),
    ).toBeNull()
  })

  it('takes the most recently rendered canvas when two share a conversation', async () => {
    const first = renderAs(SID_A, CWD, CONV_1, 'older')
    // Version timestamps are ISO strings; ensure strict ordering.
    await new Promise((r) => setTimeout(r, 5))
    const second = renderAs(SID_B, OTHER_CWD, CONV_1, 'newer')
    expect(first.canvasId).not.toBe(second.canvasId)
    restart()

    const adopted = store.adoptCanvasForSession(SID_C, { conversationUuid: CONV_1, isSessionCurrent: notCurrent })
    expect(adopted?.canvasId).toBe(second.canvasId)
  })

  it('never touches a canvas whose owner is still current, and never re-homes a session that owns one', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    restart()

    // Owner live or saved → untouchable; the asker gets nothing.
    expect(
      store.adoptCanvasForSession(SID_B, { conversationUuid: CONV_1, isSessionCurrent: allCurrent }),
    ).toBeNull()
    expect(canvasJson(canvasId).sessionId).toBe(SID_A)

    // A session that already owns a canvas never adopts another.
    renderAs(SID_B, OTHER_CWD, CONV_2, 'mine')
    const again = store.adoptCanvasForSession(SID_B, { conversationUuid: CONV_1, isSessionCurrent: notCurrent })
    expect(again).toBeNull()
  })

  it('fails SAFE when the currency check throws — uncertain means untouchable', () => {
    // The documented property, and previously nothing could trip it: a guard
    // no input can exercise is worse than none (adversarial review).
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    restart()
    const adopted = store.adoptCanvasForSession(SID_B, {
      conversationUuid: CONV_1,
      isSessionCurrent: () => {
        throw new Error('session registry unavailable')
      },
    })
    expect(adopted).toBeNull()
    expect(canvasJson(canvasId).sessionId).toBe(SID_A)
  })

  it('adopts nothing without a conversation stamp (legacy records stay put)', () => {
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
    expect(store.adoptCanvasForSession(SID_B, { conversationUuid: CONV_1, isSessionCurrent: notCurrent })).toBeNull()
    expect(store.getCanvasStateForSession(SID_A)?.canvasId).toBe(canvasId)
  })

  it('leaves the adopted record’s own stamps alone (the adopter does not redefine what the canvas is)', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    restart()
    store.adoptCanvasForSession(SID_B, { conversationUuid: CONV_1, isSessionCurrent: notCurrent })
    const record = canvasJson(canvasId)
    expect(record.sessionId).toBe(SID_B) // only the owner moves
    expect(record.cwd).toBe(CWD)
    expect(record.conversationUuid).toBe(CONV_1)
  })

  it('skips a zero-version record rather than handing over an empty canvas', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    const record = canvasJson(canvasId)
    record.versions = []
    record.activeVersionId = null
    fs.writeFileSync(
      path.join(getResourcesDirectory(), 'canvas', canvasId, 'canvas.json'),
      JSON.stringify(record, null, 2),
    )
    restart()
    expect(store.adoptCanvasForSession(SID_B, { conversationUuid: CONV_1, isSessionCurrent: notCurrent })).toBeNull()
  })

  it('announces the move so the pane can repaint', () => {
    const seen: Array<{ sessionId: string; canvasId: string }> = []
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    restart()
    const off = store.onCanvasChanged((e) => seen.push({ sessionId: e.sessionId, canvasId: e.canvasId }))
    store.adoptCanvasForSession(SID_B, { conversationUuid: CONV_1, isSessionCurrent: notCurrent })
    off()
    expect(seen).toEqual([{ sessionId: SID_B, canvasId }])
  })

  it('fails closed when the durable write fails — memory never moves ahead of disk', () => {
    const { canvasId } = renderAs(SID_A, CWD, CONV_1, 'one')
    restart()
    // Load the record into memory FIRST — the scan reads canvas.json, and the
    // sabotage below makes it unreadable.
    expect(store.getCanvasStateForSession(SID_A)?.canvasId).toBe(canvasId)
    // Same technique as canvas-store-fail-closed: make the atomic write land
    // on a directory so persist() throws.
    const jsonPath = path.join(getResourcesDirectory(), 'canvas', canvasId, 'canvas.json')
    const saved = fs.readFileSync(jsonPath, 'utf8')
    fs.rmSync(jsonPath, { force: true })
    fs.mkdirSync(jsonPath)
    expect(() =>
      store.adoptCanvasForSession(SID_B, { conversationUuid: CONV_1, isSessionCurrent: notCurrent }),
    ).toThrow()
    // Neither session's view moved.
    expect(store.getCanvasStateForSession(SID_B)).toBeNull()
    expect(store.getCanvasStateForSession(SID_A)?.canvasId).toBe(canvasId)
    fs.rmSync(jsonPath, { recursive: true, force: true })
    fs.writeFileSync(jsonPath, saved)
  })
})

describe('resolveInsideCanvasRoot (the htmlPath confinement)', () => {
  it('refuses everything when no root is registered, and confines to a registered one', () => {
    const projectDir = path.join(getResourcesDirectory(), 'confine-proj')
    const outsideDir = path.join(getResourcesDirectory(), 'confine-outside')
    fs.mkdirSync(projectDir, { recursive: true })
    fs.mkdirSync(outsideDir, { recursive: true })
    const inside = path.join(projectDir, 'mockup.html')
    const outside = path.join(outsideDir, 'secret.txt')
    fs.writeFileSync(inside, '<!doctype html><p>ok</p>')
    fs.writeFileSync(outside, 'PRIVATE KEY')

    // Default-empty allowlist: nothing resolves.
    expect(() => store.resolveInsideCanvasRoot(inside)).toThrow(/registered canvas root/i)

    store.registerCanvasUatRoot(projectDir)
    expect(store.resolveInsideCanvasRoot(inside)).toBe(fs.realpathSync.native(inside))
    // The read that the adversarial pass drove to a private key.
    expect(() => store.resolveInsideCanvasRoot(outside)).toThrow(/registered canvas root/i)
    // Traversal out of a registered root, and a relative path.
    expect(() => store.resolveInsideCanvasRoot(path.join(projectDir, '..', 'confine-outside', 'secret.txt'))).toThrow(
      /registered canvas root/i,
    )
    expect(() => store.resolveInsideCanvasRoot('mockup.html')).toThrow(/registered canvas root/i)
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

    const adopted = store.adoptCanvasForSession(SID_B, { conversationUuid: CONV_1, isSessionCurrent: notCurrent })
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
    store.adoptCanvasForSession(SID_B, { conversationUuid: CONV_1, isSessionCurrent: notCurrent })
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

    store.adoptCanvasForSession(SID_B, { conversationUuid: CONV_1, isSessionCurrent: notCurrent })
    reviews.rebindReviewsToSession(canvasId, SID_B)
    // Broken store: reads answer empty, mutations refuse, file untouched.
    expect(reviews.getReviewStateForSession(SID_B)?.reviews).toEqual([])
    expect(() =>
      reviews.upsertAnnotation(SID_B, { scope: 'general', note: 'x', versionId: 'v1' }),
    ).toThrow(/unreadable/i)
    expect((reviewsJson(canvasId) as { canvasId: string }).canvasId).toBe('someone-else')
  })
})
