/**
 * The open-review COUNT path is a reporting read, and it must not write.
 *
 * The library and the canvas_render / canvas_resolve tool replies both report
 * how many notes are waiting. The obvious reader, `loadRecord`, cannot be used
 * for that: it re-stamps a record whose embedded owner differs from the session
 * it was asked with, and PERSISTS the result — so merely LISTING canvases would
 * rebind ownership of every one it touched, silently, on the main thread. A
 * private no-rebind reader was added instead.
 *
 * Nothing pinned that. Pointing the count path back at `loadRecord` is a
 * one-token change — exactly the change a future "why are there two readers?"
 * simplification proposes — and the whole suite stayed green through it
 * (adversarial review of #308). These tests are that fence.
 *
 * NOTE ON METHOD: the re-stamp writes BYTE-IDENTICAL content when the owner is
 * the only field that changes, so a content comparison misses it entirely. What
 * catches it is the inode and mtime, which an atomic write-then-rename replaces.
 * The positive control at the bottom proves this file can actually fail.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-counts-ro-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const canvasStore = await import('../../../src/main/canvas/canvas-store')
const store = await import('../../../src/main/canvas/canvas-review-store')

const OWNER = 'a1b2c3d4e5f6a7b8c9d0e1f2'
/** The session the record on disk does NOT belong to. */
const OTHER = 'f9e8d7c6b5a4f3e2d1c0b9a8'

const reviewsPath = (canvasId: string) =>
  path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews.json')

/** Everything a write would disturb: content, size, mtime, and the inode an
 *  atomic replace necessarily changes. */
function snapshot(file: string) {
  const st = fs.statSync(file)
  return {
    content: fs.readFileSync(file, 'utf8'),
    size: st.size,
    mtimeMs: st.mtimeMs,
    ino: st.ino,
  }
}

/** A canvas with one submitted review carrying two open notes, plus a draft. */
function seed(): string {
  const { canvasId, versionId } = canvasStore.renderVersion(OWNER, {
    mode: 'design',
    html: '<!doctype html><p>page</p>',
  })
  const note = (text: string) => ({
    scope: 'general' as const,
    note: text,
    versionId,
  })
  store.upsertAnnotation(OWNER, note('first'))
  store.upsertAnnotation(OWNER, note('second'))
  const state = store.upsertAnnotation(OWNER, note('third')).state
  const draftId = state.reviews.find((r) => r.status === 'draft')?.id
  store.submitReview(OWNER, draftId as string, [], 'reject')
  // A second, still-draft review so both counters are non-zero.
  store.upsertAnnotation(OWNER, note('still drafting'))
  return canvasId
}

/**
 * Move the CANVAS to another session without rebinding its reviews, then drop
 * the cache so the next read must come from disk.
 *
 * This is the real shape of the dangerous state, and it is reached entirely
 * through the store's own API: a resume transfers the canvas record, and
 * `rebindReviewsToSession` (which the resume path calls separately) is what
 * catches reviews.json up. In between, reviews.json names a session that no
 * longer owns the canvas — which is exactly when `loadRecord` re-stamps and
 * persists. Hand-editing the file instead would not do: the per-review owner
 * fields would disagree and the record would simply fail validation, so the
 * test would pass for the wrong reason.
 */
function detachReviewsOwner(canvasId: string): void {
  const moved = canvasStore.resumeCanvasForSession(OTHER, canvasId, OWNER, {
    isSessionLive: () => false,
  })
  expect(moved).toMatchObject({ ok: true, canvasId })
  expect(JSON.parse(fs.readFileSync(reviewsPath(canvasId), 'utf8')).sessionId).toBe(OWNER)
  store._resetCanvasReviewStoreForTest()
}

beforeEach(() => {
  store._resetCanvasReviewStoreForTest()
  canvasStore._resetCanvasStoreForTest()
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
})

afterAll(() => {
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('getReviewCountsForCanvas does not write', () => {
  it('leaves the file untouched when the record on disk names a DIFFERENT session', () => {
    const canvasId = seed()
    detachReviewsOwner(canvasId)
    const file = reviewsPath(canvasId)
    const before = snapshot(file)

    // Repeatedly, and from cold each time: nothing may be warmed either.
    for (let i = 0; i < 5; i++) {
      const counts = store.getReviewCountsForCanvas(canvasId)
      expect(counts).not.toBeNull()
      expect(counts?.openNotes).toBe(3)
      expect(counts?.draftNotes).toBe(1)
      store._resetCanvasReviewStoreForTest()
    }

    expect(snapshot(file)).toEqual(before)
    // ...and the owner was not rebound to the session that now holds the canvas.
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).sessionId).toBe(OWNER)
  })

  it('does not WARM the record cache, which would disable the rebind entirely', () => {
    // Deliberately no reset between the two calls — the test above goes cold
    // each time, and going cold is exactly what hides a cache warm.
    //
    // `loadRecord` returns a cached record BEFORE it compares owners, so a
    // count read that seeded the cache would make the re-stamp unreachable: the
    // session that now owns the canvas would write its notes into a record
    // still stamped with the previous owner. Same defect as the one the
    // two-reader split exists to prevent, pointing the other way.
    const canvasId = seed()
    detachReviewsOwner(canvasId)

    expect(store.getReviewCountsForCanvas(canvasId)).not.toBeNull()

    const state = store.getReviewStateForSession(OTHER)
    expect(state?.canvasId).toBe(canvasId)
    expect(JSON.parse(fs.readFileSync(reviewsPath(canvasId), 'utf8')).sessionId).toBe(OTHER)
  })

  it('never CREATES a record for a canvas that has none', () => {
    const { canvasId } = canvasStore.renderVersion(OWNER, {
      mode: 'design',
      html: '<!doctype html><p>no reviews yet</p>',
    })
    expect(fs.existsSync(reviewsPath(canvasId))).toBe(false)
    expect(store.getReviewCountsForCanvas(canvasId)).toBeNull()
    expect(fs.existsSync(reviewsPath(canvasId))).toBe(false)
    // An unknown id must not mint a directory either.
    expect(store.getReviewCountsForCanvas('deadbeefdeadbeefdeadbeef')).toBeNull()
    expect(fs.existsSync(path.join(getResourcesDirectory(), 'canvas', 'deadbeefdeadbeefdeadbeef'))).toBe(false)
  })

  it('reports nothing, rather than zero, for a record it cannot read', () => {
    const canvasId = seed()
    fs.writeFileSync(reviewsPath(canvasId), '{"reviews":[')
    store._resetCanvasReviewStoreForTest()
    // null, not {openNotes: 0}: "could not tell" and "nothing waiting" are
    // different answers and the UI renders them differently.
    expect(store.getReviewCountsForCanvas(canvasId)).toBeNull()
    // ...and it did not "repair" the file on the way past.
    expect(fs.readFileSync(reviewsPath(canvasId), 'utf8')).toBe('{"reviews":[')
  })

  it('refuses to read an oversized reviews.json instead of blocking the main thread', () => {
    // The sweep runs once per canvas on every library open, and a session's own
    // canvases are swept without the MAX_REVIEW_SWEEP bound. Whatever is sitting
    // at that path is not necessarily a record.
    const canvasId = seed()
    const before = store.getReviewCountsForCanvas(canvasId)
    expect(before).not.toBeNull()

    // The oversized file must remain a VALID record, or the ceiling is not what
    // refuses it — JSON.parse is, and the test proves nothing. Whitespace
    // between tokens is insignificant to JSON, so padding after the opening
    // brace produces a file that still parses to exactly the same record.
    const original = fs.readFileSync(reviewsPath(canvasId), 'utf8')
    expect(original.startsWith('{')).toBe(true)
    const padded = `{${' '.repeat(9 * 1024 * 1024)}${original.slice(1)}`
    expect(JSON.parse(padded)).toEqual(JSON.parse(original))

    fs.writeFileSync(reviewsPath(canvasId), padded)
    store._resetCanvasReviewStoreForTest()
    expect(store.getReviewCountsForCanvas(canvasId)).toBeNull()
  })
})

describe('positive control — the snapshot method can detect a write', () => {
  it('sees the rebind that the SESSION-keyed reader performs on the same file', () => {
    // getReviewStateForSession is the reader the count path must not be. Given
    // the same stale-owner file it re-stamps and persists, which is precisely
    // why a second reader exists. If this test ever stops seeing a write, the
    // tests above have stopped proving anything.
    const canvasId = seed()
    detachReviewsOwner(canvasId)
    const file = reviewsPath(canvasId)
    const before = snapshot(file)

    const state = store.getReviewStateForSession(OTHER)
    expect(state?.canvasId).toBe(canvasId)

    const after = snapshot(file)
    expect(after.ino === before.ino && after.mtimeMs === before.mtimeMs).toBe(false)
    expect(JSON.parse(after.content).sessionId).toBe(OTHER)
  })
})
