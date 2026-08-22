// Close-out (#365) in the review store: the agent's `canvas_verdict` write, the
// user's own 'stale' verdict, Reopen, and the library's per-canvas bulk.
//
// What these pin, in order of how much they matter:
//
//  1. NEVER APPROVED. No argument reaching `closeAnnotationsByAgent` — the
//     word itself, its variants, a prototype key, a non-string — can produce
//     the 'approved' state. This is the property the whole feature rests on,
//     and it is enforced HERE rather than in the tool, because tool arguments
//     are model-generated and the store is the single mutation point.
//  2. THE SCOPE RULE. Only a round already waiting on the USER can be closed by
//     the agent. A round holding even one 'open' note is refused whole — that
//     is the difference between closing work the user signed off in chat and an
//     agent quietly deleting feedback it never acted on.
//  3. CLEARED, NOT DELETED. Every closed note keeps its text and comes back
//     exactly where it was, which is what makes a one-click bulk close safe.
//  4. The counts the pill is drawn from drop accordingly, and a review with
//     nothing live left is 'resolved' — with the reverse true on Reopen.

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { vi } from 'vitest'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-closeout-store-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const canvasStore = await import('../../../src/main/canvas/canvas-store')
const store = await import('../../../src/main/canvas/canvas-review-store')

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'

function renderCanvas(): { canvasId: string; versionId: string } {
  return canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>page</p>' })
}

/**
 * One submitted review with `count` notes, all marked ADDRESSED — i.e. a round
 * waiting on the user, which is the only shape the agent may close.
 */
function addressedRound(count: number): { canvasId: string; reviewId: string; ids: string[] } {
  const { canvasId, versionId } = renderCanvas()
  const ids: string[] = []
  for (let i = 0; i < count; i++) {
    const { annotationId } = store.upsertAnnotation(SID, { scope: 'general', note: `note ${i}`, versionId })
    ids.push(annotationId)
  }
  const state = store.submitReview(SID, 'R1', [])
  expect(state.reviews[0].status).toBe('submitted')
  const marked = store.markAnnotationsAddressed(SID, 'R1', ids)
  expect(marked.addressed).toEqual(ids)
  return { canvasId, reviewId: 'R1', ids }
}

/** A round where one note is still OPEN (the agent has not claimed it). */
function halfDoneRound(): { canvasId: string; reviewId: string; addressed: string[]; open: string[] } {
  const { canvasId, versionId } = renderCanvas()
  const a1 = store.upsertAnnotation(SID, { scope: 'general', note: 'one', versionId }).annotationId
  const a2 = store.upsertAnnotation(SID, { scope: 'general', note: 'two', versionId }).annotationId
  store.submitReview(SID, 'R1', [])
  store.markAnnotationsAddressed(SID, 'R1', [a1])
  return { canvasId, reviewId: 'R1', addressed: [a1], open: [a2] }
}

function noteById(canvasId: string, id: string) {
  const state = store.getReviewStateForSession(SID)!
  expect(state.canvasId).toBe(canvasId)
  return state.annotations.find((a) => a.id === id)!
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

describe('closeAnnotationsByAgent — never approved', () => {
  // The headline property. Parameterised over every spelling an argument could
  // arrive as, including the two that defeat an object-literal lookup.
  const rejected = [
    'approved',
    'approve',
    'Approved',
    'APPROVED',
    'Stale', // right word, wrong case: the Map is exact, and that is deliberate
    'STALE',
    'staleness',
    '',
    'constructor',
    'toString',
    '__proto__',
    'hasOwnProperty',
  ]
  for (const verdict of rejected) {
    it(`refuses the verdict ${JSON.stringify(verdict)} and writes nothing`, () => {
      const { canvasId, reviewId, ids } = addressedRound(2)
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        store.closeAnnotationsByAgent(SID, reviewId, null, verdict as any),
      ).toThrow(/invalid verdict/)
      // Not merely refused — nothing moved.
      for (const id of ids) expect(noteById(canvasId, id).state).toBe('addressed')
    })
  }

  for (const verdict of [null, undefined, 42, {}, [], ['stale'], { toString: () => 'stale' }]) {
    it(`refuses the non-string verdict ${JSON.stringify(verdict) ?? String(verdict)}`, () => {
      const { canvasId, reviewId, ids } = addressedRound(1)
      expect(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        store.closeAnnotationsByAgent(SID, reviewId, null, verdict as any),
      ).toThrow(/invalid verdict/)
      expect(noteById(canvasId, ids[0]).state).toBe('addressed')
    })
  }

  it('writes exactly the verdict asked for, and neither accepted one is an approval', () => {
    for (const verdict of ['stale', 'dismissed'] as const) {
      store._resetCanvasReviewStoreForTest()
      canvasStore._resetCanvasStoreForTest()
      fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })

      const { canvasId, reviewId, ids } = addressedRound(2)
      store.closeAnnotationsByAgent(SID, reviewId, null, verdict)
      for (const id of ids) {
        expect(noteById(canvasId, id).state).toBe(verdict)
      }
    }
  })
})

describe('closeAnnotationsByAgent — the scope rule', () => {
  it('refuses a round that still has a note waiting on the agent, and says how many', () => {
    const { canvasId, reviewId, addressed, open } = halfDoneRound()
    let thrown: unknown
    try {
      store.closeAnnotationsByAgent(SID, reviewId, null, 'stale')
    } catch (err) {
      thrown = err
    }
    expect((thrown as Error).message).toBe('review is still with the agent')
    expect((thrown as { openNotes?: number }).openNotes).toBe(1)
    // Nothing moved — not even the note that WAS addressed.
    expect(noteById(canvasId, addressed[0]).state).toBe('addressed')
    expect(noteById(canvasId, open[0]).state).toBe('open')
  })

  it('refuses even when the agent names only the addressed notes of a half-done round', () => {
    // The tempting partial: "close the two I finished". A round is not waiting
    // on the user until all of it is, so this is refused whole.
    const { canvasId, reviewId, addressed } = halfDoneRound()
    expect(() => store.closeAnnotationsByAgent(SID, reviewId, addressed, 'stale')).toThrow(/still with the agent/)
    expect(noteById(canvasId, addressed[0]).state).toBe('addressed')
  })

  it('refuses a round with nothing left waiting on the user', () => {
    const { reviewId, ids } = addressedRound(1)
    store.resolveAnnotation(SID, ids[0], 'approve')
    expect(() => store.closeAnnotationsByAgent(SID, reviewId, null, 'stale')).toThrow(/nothing waiting on the user/)
  })

  it('refuses a draft, an unknown review, and a malformed id', () => {
    const { versionId } = renderCanvas()
    store.upsertAnnotation(SID, { scope: 'general', note: 'draft note', versionId })
    expect(() => store.closeAnnotationsByAgent(SID, 'R1', null, 'stale')).toThrow(/still a draft/)
    expect(() => store.closeAnnotationsByAgent(SID, 'R9', null, 'stale')).toThrow(/not on this canvas/)
    expect(() => store.closeAnnotationsByAgent(SID, 'nonsense', null, 'stale')).toThrow(/invalid review id/)
  })
})

describe('closeAnnotationsByAgent — what it writes', () => {
  it('closes a whole round as stale, stamps the agent, and resolves the review', () => {
    const { canvasId, reviewId, ids } = addressedRound(3)
    const result = store.closeAnnotationsByAgent(SID, reviewId, null, 'stale')

    expect(result.closed.sort()).toEqual([...ids].sort())
    expect(result.skipped).toEqual([])
    expect(result.reviewClosed).toBe(true)
    for (const id of ids) {
      const note = noteById(canvasId, id)
      expect(note.state).toBe('stale')
      expect(note.closedBy).toBe('agent')
      expect(note.closedFrom).toBe('addressed')
      // Cleared, not deleted: the text is still there.
      expect(note.note).toMatch(/^note /)
    }
    expect(result.state.reviews.find((r) => r.id === reviewId)!.status).toBe('resolved')
  })

  it('closes only the notes named, and leaves the round open when some remain', () => {
    const { canvasId, reviewId, ids } = addressedRound(3)
    const result = store.closeAnnotationsByAgent(SID, reviewId, [ids[0]], 'dismissed')

    expect(result.closed).toEqual([ids[0]])
    expect(result.reviewClosed).toBe(false)
    expect(noteById(canvasId, ids[0]).state).toBe('dismissed')
    expect(noteById(canvasId, ids[1]).state).toBe('addressed')
    expect(result.state.reviews.find((r) => r.id === reviewId)!.status).toBe('submitted')
  })

  it('skips ids that are unknown or already ruled on rather than failing the call', () => {
    const { canvasId, reviewId, ids } = addressedRound(2)
    // The user got to one of them first, from the pane.
    store.resolveAnnotation(SID, ids[0], 'approve')
    const result = store.closeAnnotationsByAgent(SID, reviewId, [ids[0], ids[1], 'a999'], 'stale')

    expect(result.closed).toEqual([ids[1]])
    expect(result.skipped.sort()).toEqual([ids[0], 'a999'].sort())
    // The user's own verdict is untouched — and still theirs.
    const theirs = noteById(canvasId, ids[0])
    expect(theirs.state).toBe('approved')
    expect(theirs.closedBy).toBe('user')
  })

  it('makes the pill counts drop', () => {
    const { canvasId, reviewId } = addressedRound(3)
    expect(store.getReviewCountsForCanvas(canvasId)).toMatchObject({
      addressedNotes: 3,
      openNotes: 0,
      openReviewIds: [reviewId],
    })
    store.closeAnnotationsByAgent(SID, reviewId, null, 'stale')
    expect(store.getReviewCountsForCanvas(canvasId)).toMatchObject({
      addressedNotes: 0,
      openNotes: 0,
      openReviewIds: [],
    })
  })

  it('survives a reload from disk with its provenance intact', () => {
    const { canvasId, reviewId, ids } = addressedRound(2)
    store.closeAnnotationsByAgent(SID, reviewId, null, 'stale')

    // Drop every in-memory trace; the next read parses and re-validates the file.
    store._resetCanvasReviewStoreForTest()
    const reloaded = store.getReviewStateForSession(SID)!
    expect(reloaded.canvasId).toBe(canvasId)
    for (const id of ids) {
      const note = reloaded.annotations.find((a) => a.id === id)!
      expect(note.state).toBe('stale')
      expect(note.closedBy).toBe('agent')
      expect(note.closedFrom).toBe('addressed')
    }
  })

  it('refuses to load a record that claims the agent approved something', () => {
    // Not reachable through the API — this is the hand-edited-file case. A
    // record making a claim only the user can make is corrupt, and a corrupt
    // record is preserved evidence, not free space.
    const { canvasId, reviewId, ids } = addressedRound(1)
    store.closeAnnotationsByAgent(SID, reviewId, null, 'stale')
    const file = path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews.json')
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    record.annotations.find((a: { id: string }) => a.id === ids[0]).state = 'approved'
    fs.writeFileSync(file, JSON.stringify(record))

    store._resetCanvasReviewStoreForTest()
    // Broken store: reads answer empty, and mutations refuse rather than
    // overwrite.
    expect(store.getReviewStateForSession(SID)).toMatchObject({ reviews: [], annotations: [] })
    expect(store.getReviewCountsForCanvas(canvasId)).toBeNull()
  })
})

describe("the user's own close-out", () => {
  it("records 'stale' as the user's, distinct from an approval", () => {
    const { canvasId, ids } = addressedRound(1)
    store.resolveAnnotation(SID, ids[0], 'stale')
    const note = noteById(canvasId, ids[0])
    expect(note.state).toBe('stale')
    expect(note.closedBy).toBe('user')
    expect(note.closedFrom).toBe('addressed')
  })

  it("remembers that a note closed from 'open' was never addressed", () => {
    const { canvasId, versionId } = renderCanvas()
    const a1 = store.upsertAnnotation(SID, { scope: 'general', note: 'never touched', versionId }).annotationId
    store.submitReview(SID, 'R1', [])
    store.resolveAnnotation(SID, a1, 'stale')
    expect(noteById(canvasId, a1).closedFrom).toBe('open')
  })

  it('refuses an unknown action', () => {
    const { ids } = addressedRound(1)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => store.resolveAnnotation(SID, ids[0], 'approved' as any)).toThrow(/invalid action/)
  })
})

describe('reopenAnnotation', () => {
  it('puts an agent-closed note back exactly where it was, and reopens the review', () => {
    const { canvasId, reviewId, ids } = addressedRound(2)
    store.closeAnnotationsByAgent(SID, reviewId, null, 'stale')
    expect(store.getReviewStateForSession(SID)!.reviews[0].status).toBe('resolved')

    const state = store.reopenAnnotation(SID, ids[0])
    const note = state.annotations.find((a) => a.id === ids[0])!
    expect(note.state).toBe('addressed')
    expect(note.closedBy).toBeUndefined()
    expect(note.closedFrom).toBeUndefined()
    // The round is live again, which is what brings the pill back.
    expect(state.reviews.find((r) => r.id === reviewId)!.status).toBe('submitted')
    expect(store.getReviewCountsForCanvas(canvasId)).toMatchObject({ addressedNotes: 1, openReviewIds: [reviewId] })
  })

  it("returns a note closed from 'open' to open, not to addressed", () => {
    const { canvasId, versionId } = renderCanvas()
    const a1 = store.upsertAnnotation(SID, { scope: 'general', note: 'x', versionId }).annotationId
    store.submitReview(SID, 'R1', [])
    store.resolveAnnotation(SID, a1, 'dismiss')
    store.reopenAnnotation(SID, a1)
    expect(noteById(canvasId, a1).state).toBe('open')
  })

  it('reopens an approval too — it is the user undoing their own click', () => {
    const { canvasId, ids } = addressedRound(1)
    store.resolveAnnotation(SID, ids[0], 'approve')
    store.reopenAnnotation(SID, ids[0])
    expect(noteById(canvasId, ids[0]).state).toBe('addressed')
  })

  it('refuses a live note and a superseded one', () => {
    const { ids } = addressedRound(2)
    expect(() => store.reopenAnnotation(SID, ids[0])).toThrow(/only a closed note/)
    store.resolveAnnotation(SID, ids[0], 'reannotate')
    // 'reannotated' has a live successor; reopening it would duplicate the issue.
    expect(() => store.reopenAnnotation(SID, ids[0])).toThrow(/only a closed note/)
  })

  it('refuses an unknown or malformed id', () => {
    addressedRound(1)
    expect(() => store.reopenAnnotation(SID, 'a999')).toThrow(/unknown annotation/)
    expect(() => store.reopenAnnotation(SID, 'nope')).toThrow(/invalid annotation id/)
  })
})

describe('closeOutCanvasReviews (the library bulk)', () => {
  it('clears the rounds waiting on the user and reports how many', () => {
    const { canvasId, reviewId } = addressedRound(3)
    const result = store.closeOutCanvasReviews(canvasId)
    expect(result).toEqual({ closed: 3, reviews: [reviewId] })
    expect(store.getReviewCountsForCanvas(canvasId)).toMatchObject({ addressedNotes: 0, openReviewIds: [] })
  })

  it('stamps the USER, because a library click is the user acting', () => {
    const { canvasId, ids } = addressedRound(1)
    store.closeOutCanvasReviews(canvasId)
    const note = noteById(canvasId, ids[0])
    expect(note.state).toBe('stale')
    expect(note.closedBy).toBe('user')
  })

  it('leaves a round still holding an open note completely alone', () => {
    const { canvasId, addressed, open } = halfDoneRound()
    expect(store.closeOutCanvasReviews(canvasId)).toEqual({ closed: 0, reviews: [] })
    expect(noteById(canvasId, addressed[0]).state).toBe('addressed')
    expect(noteById(canvasId, open[0]).state).toBe('open')
  })

  it('answers null for a canvas it cannot read, and never a zero', () => {
    // "nothing to close" and "could not tell" must not look the same.
    expect(store.closeOutCanvasReviews('nosuchcanvasid')).toBeNull()
    expect(store.closeOutCanvasReviews('NOT A CANVAS ID')).toBeNull()
  })

  it('is a no-op on a canvas whose notes are already all ruled on', () => {
    const { canvasId, reviewId } = addressedRound(2)
    store.closeOutCanvasReviews(canvasId)
    expect(store.closeOutCanvasReviews(canvasId)).toEqual({ closed: 0, reviews: [] })
    expect(store.getReviewStateForSession(SID)!.reviews.find((r) => r.id === reviewId)!.status).toBe('resolved')
  })
})
