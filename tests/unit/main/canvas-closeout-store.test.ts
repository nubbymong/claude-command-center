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

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
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
 * One submitted review with `count` notes, all marked ADDRESSED just now — a
 * round the agent has finished IN THIS PASS. The agent may not close this yet.
 */
function freshAddressedRound(count: number): { canvasId: string; reviewId: string; ids: string[] } {
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

/**
 * The same round, after enough time has passed that the user could have seen
 * it — the shape the agent may close on their instruction.
 *
 * The clock move is the point: the close-out barrier exists precisely to
 * separate "the agent addressed these and closed them in one breath" from "the
 * agent finished, handed back, and the user said close them".
 */
function addressedRound(count: number): { canvasId: string; reviewId: string; ids: string[] } {
  const round = freshAddressedRound(count)
  vi.advanceTimersByTime(store.MIN_ADDRESSED_DWELL_MS + 1000)
  return round
}

/** A round where one note is still OPEN (the agent has not claimed it). */
function halfDoneRound(): { canvasId: string; reviewId: string; addressed: string[]; open: string[] } {
  const { canvasId, versionId } = renderCanvas()
  const a1 = store.upsertAnnotation(SID, { scope: 'general', note: 'one', versionId }).annotationId
  const a2 = store.upsertAnnotation(SID, { scope: 'general', note: 'two', versionId }).annotationId
  store.submitReview(SID, 'R1', [])
  store.markAnnotationsAddressed(SID, 'R1', [a1])
  vi.advanceTimersByTime(store.MIN_ADDRESSED_DWELL_MS + 1000)
  return { canvasId, reviewId: 'R1', addressed: [a1], open: [a2] }
}

function noteById(canvasId: string, id: string) {
  const state = store.getReviewStateForSession(SID)!
  expect(state.canvasId).toBe(canvasId)
  return state.annotations.find((a) => a.id === id)!
}

beforeEach(() => {
  // The close-out barrier is a clock comparison, so the clock is controlled.
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-08-22T12:00:00.000Z'))
  store._resetCanvasReviewStoreForTest()
  canvasStore._resetCanvasStoreForTest()
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
})

afterEach(() => {
  vi.useRealTimers()
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

describe('closeAnnotationsByAgent — the chaining barrier (Q-2)', () => {
  /**
   * The attack the scope rule alone does not stop: the agent writes its own
   * precondition. canvas_resolve moves every note open -> addressed with no
   * user involvement, so resolve-then-verdict in one pass satisfies "the round
   * is waiting on the user" and takes the round off the pill that would have
   * sent the user to look at it. No user instruction anywhere.
   */
  it('refuses a round the agent addressed moments ago', () => {
    const { canvasId, reviewId, ids } = freshAddressedRound(3)
    let thrown: unknown
    try {
      store.closeAnnotationsByAgent(SID, reviewId, null, 'dismissed')
    } catch (err) {
      thrown = err
    }
    expect((thrown as Error).message).toBe('review was addressed just now')
    expect((thrown as { freshNotes?: number }).freshNotes).toBe(3)
    // Nothing moved, and the round is still on the pill.
    for (const id of ids) expect(noteById(canvasId, id).state).toBe('addressed')
    expect(store.getReviewCountsForCanvas(canvasId)!.openReviewIds).toEqual([reviewId])
  })

  it('refuses the named-ids form of the same chain', () => {
    const { reviewId, ids } = freshAddressedRound(2)
    expect(() => store.closeAnnotationsByAgent(SID, reviewId, [ids[0]], 'stale')).toThrow(/addressed just now/)
  })

  it('allows it once the round has had time to reach the user', () => {
    const { canvasId, reviewId, ids } = freshAddressedRound(2)
    expect(() => store.closeAnnotationsByAgent(SID, reviewId, null, 'stale')).toThrow(/addressed just now/)
    vi.advanceTimersByTime(store.MIN_ADDRESSED_DWELL_MS + 1)
    const result = store.closeAnnotationsByAgent(SID, reviewId, null, 'stale')
    expect(result.closed.sort()).toEqual([...ids].sort())
    expect(noteById(canvasId, ids[0]).state).toBe('stale')
  })

  it('stamps addressedAt at the moment the agent marks a note', () => {
    const { canvasId, ids } = addressedRound(1)
    expect(noteById(canvasId, ids[0]).addressedAt).toBe('2026-08-22T12:00:00.000Z')
  })

  it('keeps the stamp when a note reopens to addressed — the agent really did act', () => {
    const { canvasId, reviewId, ids } = addressedRound(1)
    store.closeAnnotationsByAgent(SID, reviewId, null, 'stale')
    store.reopenAnnotation(SID, ids[0])
    const note = noteById(canvasId, ids[0])
    expect(note.state).toBe('addressed')
    expect(note.addressedAt).toBe('2026-08-22T12:00:00.000Z')
  })

  it('drops the stamp when a note reopens to open — nobody claims to have acted', () => {
    const { canvasId, versionId } = renderCanvas()
    const a1 = store.upsertAnnotation(SID, { scope: 'general', note: 'never touched', versionId }).annotationId
    store.submitReview(SID, 'R1', [])
    store.resolveAnnotation(SID, a1, 'dismiss') // closed straight from 'open'
    store.reopenAnnotation(SID, a1)
    const note = noteById(canvasId, a1)
    expect(note.state).toBe('open')
    expect(note.addressedAt).toBeUndefined()
  })

  it('refuses a note whose stamp is present but unreadable — the fail-closed direction', () => {
    const { canvasId, reviewId } = addressedRound(1)
    const file = path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews.json')
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    record.annotations[0].addressedAt = 'not a date'
    fs.writeFileSync(file, JSON.stringify(record))
    store._resetCanvasReviewStoreForTest()

    expect(() => store.closeAnnotationsByAgent(SID, reviewId, null, 'stale')).toThrow(/addressed just now/)
  })

  it('does not block a note with no stamp at all (a record from before the barrier)', () => {
    const { canvasId, reviewId } = addressedRound(2)
    const file = path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews.json')
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    for (const a of record.annotations) delete a.addressedAt
    fs.writeFileSync(file, JSON.stringify(record))
    store._resetCanvasReviewStoreForTest()

    expect(store.closeAnnotationsByAgent(SID, reviewId, null, 'stale').closed).toHaveLength(2)
  })

  it('does not apply to the USER closing their own notes', () => {
    // The barrier is about the agent chaining its own writes. A user clicking
    // "Accept as built" the instant the agent finishes is exactly the flow the
    // feature is for, and must not be slowed down.
    const { canvasId, ids } = freshAddressedRound(2)
    store.resolveAnnotation(SID, ids[0], 'stale')
    expect(noteById(canvasId, ids[0]).state).toBe('stale')
    expect(store.closeOutCanvasReviews(canvasId)).toEqual({ closed: 1, reviews: ['R1'] })
  })
})

describe('the record proves its two membership views agree (Q-5)', () => {
  it('refuses a record whose review lists a note that does not name it', () => {
    const { canvasId, ids } = addressedRound(2)
    const file = path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews.json')
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    // The drift that made the scope rule and settleReviewStatus disagree: a
    // note carrying reviewId R1 but absent from R1.annotationIds.
    record.reviews[0].annotationIds = [ids[0]]
    fs.writeFileSync(file, JSON.stringify(record))

    store._resetCanvasReviewStoreForTest()
    expect(store.getReviewCountsForCanvas(canvasId)).toBeNull()
    expect(store.getReviewStateForSession(SID)).toMatchObject({ reviews: [], annotations: [] })
  })

  it('refuses a record listing a member twice', () => {
    const { canvasId, ids } = addressedRound(1)
    const file = path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews.json')
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    record.reviews[0].annotationIds = [ids[0], ids[0]]
    fs.writeFileSync(file, JSON.stringify(record))

    store._resetCanvasReviewStoreForTest()
    expect(store.getReviewCountsForCanvas(canvasId)).toBeNull()
  })

  it('accepts every record the API itself produces', () => {
    // The check must never fire on a record this store wrote. Exercise the
    // paths that touch membership: draft, edit, delete, submit, re-annotate.
    const { canvasId, versionId } = renderCanvas()
    const a1 = store.upsertAnnotation(SID, { scope: 'general', note: 'one', versionId }).annotationId
    const a2 = store.upsertAnnotation(SID, { scope: 'general', note: 'two', versionId }).annotationId
    store.upsertAnnotation(SID, { scope: 'general', note: 'reworded', versionId, annotationId: a1 })
    store.deleteAnnotation(SID, a2)
    store.submitReview(SID, 'R1', [])
    store.markAnnotationsAddressed(SID, 'R1', [a1])
    store.resolveAnnotation(SID, a1, 'reannotate')

    store._resetCanvasReviewStoreForTest()
    expect(store.getReviewCountsForCanvas(canvasId)).not.toBeNull()
    expect(store.getReviewStateForSession(SID)!.annotations.length).toBeGreaterThan(0)
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

  // Q-1. The count that LABELS the library button must be the count the button
  // CLEARS. It was `addressedNotes`, which ignores the per-review open gate, so
  // a partial round advertised "Close 1 note", cleared nothing, and -- because
  // the number never moved -- left a button that could never go away. This is
  // the assertion one line from the test above that would have caught it.
  it('reports zero closeable on a partial round, though a note IS addressed', () => {
    const { canvasId } = halfDoneRound()
    const counts = store.getReviewCountsForCanvas(canvasId)!
    expect(counts.addressedNotes).toBe(1) // there is an addressed note
    expect(counts.closeableNotes).toBe(0) // and nothing a close-out would clear
    expect(store.closeOutCanvasReviews(canvasId)!.closed).toBe(counts.closeableNotes)
  })

  it('counts exactly what it clears on a canvas mixing a clean and a partial round', () => {
    // R1 clean (2 addressed), R2 partial (1 addressed, 1 open). The old count
    // said 3; the mutation clears 2.
    const { canvasId, versionId } = renderCanvas()
    const a1 = store.upsertAnnotation(SID, { scope: 'general', note: 'one', versionId }).annotationId
    const a2 = store.upsertAnnotation(SID, { scope: 'general', note: 'two', versionId }).annotationId
    store.submitReview(SID, 'R1', [])
    store.markAnnotationsAddressed(SID, 'R1', [a1, a2])
    const a3 = store.upsertAnnotation(SID, { scope: 'general', note: 'three', versionId }).annotationId
    store.upsertAnnotation(SID, { scope: 'general', note: 'four', versionId })
    store.submitReview(SID, 'R2', [])
    store.markAnnotationsAddressed(SID, 'R2', [a3])

    const counts = store.getReviewCountsForCanvas(canvasId)!
    expect(counts.addressedNotes).toBe(3)
    expect(counts.closeableNotes).toBe(2)
    const result = store.closeOutCanvasReviews(canvasId)!
    expect(result).toEqual({ closed: 2, reviews: ['R1'] })
    expect(result.closed).toBe(counts.closeableNotes)
  })

  it('drops the closeable count to zero once the canvas is cleared', () => {
    const { canvasId } = addressedRound(3)
    expect(store.getReviewCountsForCanvas(canvasId)!.closeableNotes).toBe(3)
    store.closeOutCanvasReviews(canvasId)
    expect(store.getReviewCountsForCanvas(canvasId)!.closeableNotes).toBe(0)
  })

  // Q-4. `readRecordNoRebind` deliberately skips loadRecord's counter repair,
  // and a close-out commits what it read straight into the cache every later
  // load short-circuits on. A skew surviving that mints a duplicate id.
  it('repairs skewed id counters before committing a record it read itself', () => {
    const { canvasId, versionId } = renderCanvas()
    const a1 = store.upsertAnnotation(SID, { scope: 'general', note: 'one', versionId }).annotationId
    const a2 = store.upsertAnnotation(SID, { scope: 'general', note: 'two', versionId }).annotationId
    store.submitReview(SID, 'R1', [])
    store.markAnnotationsAddressed(SID, 'R1', [a1, a2])

    const file = path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews.json')
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    record.nextAnnotation = 1 // below max(id) + 1: hand-edited, older format, torn write
    fs.writeFileSync(file, JSON.stringify(record))

    // Cold cache: the close-out is the first thing to touch this canvas.
    store._resetCanvasReviewStoreForTest()
    expect(store.closeOutCanvasReviews(canvasId)!.closed).toBe(2)

    // The next note must not reuse a1 or a2.
    const { annotationId } = store.upsertAnnotation(SID, { scope: 'general', note: 'after', versionId })
    expect(annotationId).toBe('a3')
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
