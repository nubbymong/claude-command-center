// The P3 review/annotation store: draft lifecycle, submit freeze, resolution
// state machine, restart round-trip (the acceptance-gate requirement), and the
// two fail-closed properties (persist-before-commit; a corrupt reviews.json
// refuses mutations rather than being overwritten).

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { vi } from 'vitest'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-review-store-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const canvasStore = await import('../../../src/main/canvas/canvas-store')
const store = await import('../../../src/main/canvas/canvas-review-store')

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'

/**
 * The user's verdict, addressed to the canvas the session is on RIGHT NOW.
 *
 * `resolveAnnotation` takes the canvas the caller composed the verdict against
 * and refuses a mismatch — note ids restart at a1 on every canvas, so an id
 * alone names a note only while the canvas holds still. Every test that is not
 * about that race goes through here; the ones that are call the store directly
 * with a canvas id of their own choosing.
 */
function resolveNow(annotationId: string, action: import('../../../src/main/canvas/canvas-review-store').ResolveAction) {
  const canvasId = store.getReviewStateForSession(SID)?.canvasId ?? ''
  return store.resolveAnnotation(SID, annotationId, action, canvasId)
}

/** A tiny real PNG (8-byte magic + nothing anyone parses here). */
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('x'.repeat(32))])
const PNG_B64 = PNG_BYTES.toString('base64')

function renderCanvas(): { canvasId: string; versionId: string } {
  return canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>page</p>' })
}

function elementDraft(versionId: string, note = 'make this readable') {
  return {
    scope: 'element' as const,
    note,
    focus: {
      targets: [
        { kind: 'ux-id' as const, id: 'save-button' },
        { kind: 'fingerprint' as const, role: 'button', name: 'Save', ancestorPath: 'main>form', ordinal: 0 },
      ],
      bboxPage: { x: 10, y: 20, width: 100, height: 30 },
      label: 'button "Save"',
      versionId,
    },
    versionId,
  }
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

describe('draft lifecycle', () => {
  it('creates the draft review with the first note and updates/deletes only drafts', () => {
    const { versionId } = renderCanvas()
    const { state, annotationId } = store.upsertAnnotation(SID, elementDraft(versionId))
    expect(annotationId).toBe('a1')
    expect(state.reviews).toHaveLength(1)
    expect(state.reviews[0]).toMatchObject({ id: 'R1', status: 'draft', annotationIds: ['a1'] })
    expect(state.annotations[0]).toMatchObject({ id: 'a1', reviewId: 'R1', state: 'open', scope: 'element' })

    // Update in place: same id, new wording.
    const updated = store.upsertAnnotation(SID, { ...elementDraft(versionId, 'reworded'), annotationId: 'a1' })
    expect(updated.annotationId).toBe('a1')
    expect(updated.state.annotations).toHaveLength(1)
    expect(updated.state.annotations[0].note).toBe('reworded')

    // Deleting the last note removes the empty draft; the number is not reused.
    const afterDelete = store.deleteAnnotation(SID, 'a1')
    expect(afterDelete.reviews).toHaveLength(0)
    expect(afterDelete.annotations).toHaveLength(0)
    const again = store.upsertAnnotation(SID, elementDraft(versionId))
    expect(again.state.reviews[0].id).toBe('R2')
    expect(again.annotationId).toBe('a2')
  })

  it('refuses a general note with focus, an element note without anchors, and unknown versions', () => {
    const { versionId } = renderCanvas()
    expect(() =>
      store.upsertAnnotation(SID, { scope: 'general', note: 'x', focus: elementDraft(versionId).focus, versionId }),
    ).toThrow(/focus/)
    expect(() =>
      store.upsertAnnotation(SID, {
        scope: 'element',
        note: 'x',
        focus: { targets: [], bboxPage: { x: 0, y: 0, width: 1, height: 1 }, label: 'l', versionId },
        versionId,
      }),
    ).toThrow(/anchor/)
    expect(() => store.upsertAnnotation(SID, { scope: 'general', note: 'x', versionId: 'v99' })).toThrow(/unknown version/)
  })

  it('rejects control characters in labels but keeps newlines in notes', () => {
    const { versionId } = renderCanvas()
    const bad = elementDraft(versionId)
    bad.focus.label = 'button \u0007bell'
    expect(() => store.upsertAnnotation(SID, bad)).toThrow(/focus/)
    const ok = store.upsertAnnotation(SID, { scope: 'general', note: 'line one\nline two', versionId })
    expect(ok.state.annotations[0].note).toBe('line one\nline two')
  })
})

describe('submit (freeze + sketch exports)', () => {
  it('freezes the draft against the active version and writes sketch PNGs', () => {
    const { canvasId, versionId } = renderCanvas()
    const draft = elementDraft(versionId)
    const withSketch = {
      ...draft,
      sketch: { excalidrawElementIds: ['el-1', 'el-2'], bboxPage: { x: 5, y: 5, width: 50, height: 40 } },
    }
    const { annotationId } = store.upsertAnnotation(SID, withSketch)
    store.upsertAnnotation(SID, { scope: 'general', note: 'overall fine', versionId })

    const state = store.submitReview(SID, 'R1', [{ annotationId, pngBase64: PNG_B64 }])
    const review = state.reviews[0]
    expect(review.status).toBe('submitted')
    expect(review.submittedAt).toBeTruthy()
    expect(review.versionId).toBe(versionId)

    const sketchNote = state.annotations.find((a) => a.id === annotationId)!
    expect(sketchNote.sketch?.pngPath).toBe(`reviews/R1/${annotationId}.png`)
    const abs = path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews', 'R1', `${annotationId}.png`)
    expect(fs.readFileSync(abs).equals(PNG_BYTES)).toBe(true)

    // Frozen: the note can no longer be edited or deleted.
    expect(() => store.upsertAnnotation(SID, { ...draft, annotationId })).toThrow(/draft/)
    expect(() => store.deleteAnnotation(SID, annotationId)).toThrow(/draft/)
  })

  it('refuses a submit whose sketch pairing is wrong, and nothing changes', () => {
    const { versionId } = renderCanvas()
    const withSketch = {
      ...elementDraft(versionId),
      sketch: { excalidrawElementIds: ['el-1'], bboxPage: { x: 0, y: 0, width: 10, height: 10 } },
    }
    const { annotationId } = store.upsertAnnotation(SID, withSketch)

    // Missing export for a sketch-carrying note.
    expect(() => store.submitReview(SID, 'R1', [])).toThrow(/sketch export missing/)
    // Export for a note without a sketch.
    store.upsertAnnotation(SID, { scope: 'general', note: 'plain', versionId })
    expect(() =>
      store.submitReview(SID, 'R1', [
        { annotationId, pngBase64: PNG_B64 },
        { annotationId: 'a2', pngBase64: PNG_B64 },
      ]),
    ).toThrow(/without a sketch/)
    // Not a PNG.
    expect(() => store.submitReview(SID, 'R1', [{ annotationId, pngBase64: Buffer.from('GIF89a').toString('base64') }])).toThrow(/not a png/)

    // All refused: still a draft, still editable.
    const state = store.getReviewStateForSession(SID)!
    expect(state.reviews[0].status).toBe('draft')
  })
})

describe('resolution state machine', () => {
  function submitted(): { versionId: string } {
    const { versionId } = renderCanvas()
    store.upsertAnnotation(SID, elementDraft(versionId))
    store.upsertAnnotation(SID, { scope: 'general', note: 'second note', versionId })
    store.submitReview(SID, 'R1', [])
    return { versionId }
  }

  it('approve/dismiss close notes; the review resolves when the last open note closes', () => {
    submitted()
    let out = resolveNow('a1', 'approve')
    expect(out.state.annotations.find((a) => a.id === 'a1')!.state).toBe('approved')
    expect(out.state.reviews[0].status).toBe('submitted')

    out = resolveNow('a2', 'dismiss')
    expect(out.state.annotations.find((a) => a.id === 'a2')!.state).toBe('dismissed')
    expect(out.state.reviews[0].status).toBe('resolved')

    // A closed note cannot be resolved again.
    expect(() => resolveNow('a1', 'approve')).toThrow(/open/)
  })

  it('reannotate mints the linked replacement in a fresh draft: focus carried, sketch not', () => {
    const { versionId } = renderCanvas()
    store.upsertAnnotation(SID, {
      ...elementDraft(versionId),
      sketch: { excalidrawElementIds: ['el-1'], bboxPage: { x: 0, y: 0, width: 10, height: 10 } },
    })
    store.submitReview(SID, 'R1', [{ annotationId: 'a1', pngBase64: PNG_B64 }])

    const { state, reannotationId } = resolveNow('a1', 'reannotate')
    expect(reannotationId).toBe('a2')
    const old = state.annotations.find((a) => a.id === 'a1')!
    expect(old.state).toBe('reannotated')
    expect(old.supersededBy).toBe('a2')

    const replacement = state.annotations.find((a) => a.id === 'a2')!
    expect(replacement).toMatchObject({ state: 'open', scope: 'element', reviewId: 'R2', note: old.note })
    expect(replacement.focus?.label).toBe(old.focus?.label)
    expect(replacement.sketch).toBeUndefined()

    const draft = state.reviews.find((r) => r.id === 'R2')!
    expect(draft.status).toBe('draft')
    // R1 had one note, now reannotated → resolved.
    expect(state.reviews.find((r) => r.id === 'R1')!.status).toBe('resolved')
  })

  it('never resolves a draft note', () => {
    const { versionId } = renderCanvas()
    store.upsertAnnotation(SID, elementDraft(versionId))
    expect(() => resolveNow('a1', 'approve')).toThrow(/submitted/)
  })
})

describe('persistence', () => {
  it('round-trips an app restart: reviews, annotations, and counters all survive', () => {
    const { versionId } = renderCanvas()
    store.upsertAnnotation(SID, elementDraft(versionId))
    store.upsertAnnotation(SID, { scope: 'general', note: 'general one', versionId })
    store.submitReview(SID, 'R1', [])
    resolveNow('a1', 'reannotate') // opens draft R2 with a3

    // "Restart": drop all in-memory state; the next read must come from disk.
    store._resetCanvasReviewStoreForTest()
    canvasStore._resetCanvasStoreForTest()

    const state = store.getReviewStateForSession(SID)!
    // a2 (the general note) is still open, so R1 is still 'submitted'.
    expect(state.reviews.map((r) => [r.id, r.status])).toEqual([
      ['R1', 'submitted'],
      ['R2', 'draft'],
    ])
    expect(state.annotations.map((a) => a.id).sort()).toEqual(['a1', 'a2', 'a3'])
    expect(state.annotations.find((a) => a.id === 'a1')!.supersededBy).toBe('a3')

    // The reloaded record is fully live: closing the last open note resolves
    // the review, and the counters continue where they left off.
    const resolved = resolveNow('a2', 'approve')
    expect(resolved.state.reviews.find((r) => r.id === 'R1')!.status).toBe('resolved')
    const next = store.upsertAnnotation(SID, { scope: 'general', note: 'post-restart', versionId })
    expect(next.annotationId).toBe('a4')
  })

  it('fails closed when the durable write cannot land: memory stays behind disk', () => {
    const { canvasId, versionId } = renderCanvas()
    store.upsertAnnotation(SID, { scope: 'general', note: 'first', versionId })

    // Make the next persist fail: reviews.json becomes a directory.
    const jsonPath = path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews.json')
    fs.rmSync(jsonPath, { force: true })
    fs.mkdirSync(jsonPath)

    expect(() => store.upsertAnnotation(SID, { scope: 'general', note: 'second', versionId })).toThrow()

    // The rejected note is nowhere; the counter did not skew.
    fs.rmSync(jsonPath, { recursive: true, force: true })
    // (memory still holds the committed first note; the failed write left it untouched)
    const state = store.getReviewStateForSession(SID)!
    expect(state.annotations.map((a) => a.note)).toEqual(['first'])
    const retry = store.upsertAnnotation(SID, { scope: 'general', note: 'second-b', versionId })
    expect(retry.annotationId).toBe('a2')
  })

  it('treats a corrupt reviews.json as BROKEN: reads answer empty, writes refuse, the file survives', () => {
    const { canvasId, versionId } = renderCanvas()
    store.upsertAnnotation(SID, { scope: 'general', note: 'precious history', versionId })

    const jsonPath = path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews.json')
    fs.writeFileSync(jsonPath, '{ definitely not valid json')
    store._resetCanvasReviewStoreForTest() // fresh process, corrupt file on disk

    const state = store.getReviewStateForSession(SID)
    expect(state).not.toBeNull()
    expect(state!.reviews).toHaveLength(0)

    expect(() => store.upsertAnnotation(SID, { scope: 'general', note: 'new', versionId })).toThrow(/unreadable/)
    // The corrupt file was preserved, not clobbered with a fresh record.
    expect(fs.readFileSync(jsonPath, 'utf8')).toBe('{ definitely not valid json')
  })
})

describe('getReviewPayload (the canvas_review read)', () => {
  it('refuses drafts, lists fetchable ids for unknowns, and splits the payload correctly', () => {
    const { canvasId, versionId } = renderCanvas()
    store.upsertAnnotation(SID, {
      ...elementDraft(versionId),
      sketch: { excalidrawElementIds: ['el-1'], bboxPage: { x: 0, y: 0, width: 10, height: 10 } },
    })
    store.upsertAnnotation(SID, { scope: 'general', note: 'a general note', versionId })

    expect(() => store.getReviewPayload(SID, 'R1')).toThrow(/draft/)

    store.submitReview(SID, 'R1', [{ annotationId: 'a1', pngBase64: PNG_B64 }])

    try {
      store.getReviewPayload(SID, 'R9')
      expect.unreachable('unknown review must throw')
    } catch (err) {
      expect((err as Error).message).toMatch(/unknown review/)
      expect((err as { submittedReviewIds?: string[] }).submittedReviewIds).toEqual(['R1'])
    }

    const result = store.getReviewPayload(SID, 'R1')
    expect(result.payload.review.id).toBe('R1')
    expect(result.payload.annotations.map((a) => a.id)).toEqual(['a1'])
    expect(result.payload.generalNotes.map((a) => a.id)).toEqual(['a2'])
    expect(result.payload.envelope).toBe('untrusted-content')
    expect(result.payload.attachments).toEqual([{ annotationId: 'a1', pngPath: 'reviews/R1/a1.png' }])
    expect(result.attachmentFiles[0].absPath).toBe(
      path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews', 'R1', 'a1.png'),
    )
  })
})

describe('markAnnotationsAddressed — the agent closes its side of the loop', () => {
  // canvas_review hands the agent the user's notes; until this existed nothing
  // let the agent say "done with these", so a review the user finished in chat
  // rather than in the pane sat as N open notes forever and rode forward onto
  // the next render as if unanswered.
  function submitted(): { versionId: string; rid: string; a1: string; a2: string; a3: string } {
    const { versionId } = renderCanvas()
    const one = store.upsertAnnotation(SID, elementDraft(versionId, 'first'))
    const two = store.upsertAnnotation(SID, elementDraft(versionId, 'second'))
    const three = store.upsertAnnotation(SID, { scope: 'general', note: 'third', versionId })
    const reviewId = one.state.reviews.find((r) => r.status === 'draft')!.id
    store.submitReview(SID, reviewId, [])
    return { versionId, rid: reviewId, a1: one.annotationId, a2: two.annotationId, a3: three.annotationId }
  }

  it('moves open notes on a submitted review to addressed', () => {
    const { rid, a1, a2, a3 } = submitted()
    const r = store.markAnnotationsAddressed(SID, rid, [a1, a3])
    expect(r.addressed).toEqual([a1, a3])
    expect(r.skipped).toEqual([])
    const by = Object.fromEntries(r.state.annotations.map((a) => [a.id, a.state]))
    expect(by[a1]).toBe('addressed')
    expect(by[a2]).toBe('open')
    expect(by[a3]).toBe('addressed')
  })

  it('never touches what the user has already resolved', () => {
    const { rid, a1, a2 } = submitted()
    resolveNow(a1, 'approve')
    resolveNow(a2, 'dismiss')
    const r = store.markAnnotationsAddressed(SID, rid, [a1, a2])
    expect(r.addressed).toEqual([])
    expect(r.skipped).toEqual(expect.arrayContaining([a1, a2]))
    const by = Object.fromEntries(r.state.annotations.map((a) => [a.id, a.state]))
    // The user's words stand.
    expect(by[a1]).toBe('approved')
    expect(by[a2]).toBe('dismissed')
  })

  it('refuses a review the user is still drafting', () => {
    const { versionId } = renderCanvas()
    const { state, annotationId } = store.upsertAnnotation(SID, elementDraft(versionId))
    const draftId = state.reviews.find((r) => r.status === 'draft')!.id
    expect(() => store.markAnnotationsAddressed(SID, draftId, [annotationId])).toThrow(/still a draft/)
  })

  it('skips unknown and malformed ids rather than failing the whole call', () => {
    const { rid, a1 } = submitted()
    const r = store.markAnnotationsAddressed(SID, rid, [a1, 'a999', 'not-an-id', '../x'])
    expect(r.addressed).toEqual([a1])
    // Malformed ids never even reach the record; unknown-but-well-formed are
    // reported so the agent knows.
    expect(r.skipped).toEqual(['a999'])
  })

  it('does not write when nothing changed', () => {
    const { rid, a1 } = submitted()
    resolveNow(a1, 'approve')
    const canvas = canvasStore.getCanvasStateForSession(SID)!
    const file = path.join(getResourcesDirectory(), 'canvas', canvas.canvasId, 'reviews.json')
    const before = fs.statSync(file).mtimeMs
    store.markAnnotationsAddressed(SID, rid, [a1])
    expect(fs.statSync(file).mtimeMs).toBe(before)
  })

  it('the user can still approve or dismiss an ADDRESSED note — the verdict is theirs', () => {
    const { rid, a1 } = submitted()
    store.markAnnotationsAddressed(SID, rid, [a1])
    const r = resolveNow(a1, 'approve')
    expect(r.state.annotations.find((a) => a.id === a1)!.state).toBe('approved')
  })

  it('an addressed note keeps its review OPEN until the user gives a verdict', () => {
    // "Addressed" is the agent's claim; the review closes on the user's word.
    const { rid, a1, a2, a3 } = submitted()
    store.markAnnotationsAddressed(SID, rid, [a1, a2, a3])
    let review = store.getReviewStateForSession(SID)!.reviews.find((r) => r.status !== 'draft')!
    expect(review.status).toBe('submitted')
    resolveNow(a1, 'approve')
    resolveNow(a2, 'approve')
    resolveNow(a3, 'dismiss')
    review = store.getReviewStateForSession(SID)!.reviews.find((r) => r.id === review.id)!
    expect(review.status).toBe('resolved')
  })

  it('survives a reload with the addressed state intact', () => {
    const { rid, a1 } = submitted()
    store.markAnnotationsAddressed(SID, rid, [a1])
    store._resetCanvasReviewStoreForTest()
    const st = store.getReviewStateForSession(SID)!
    // A record carrying an 'addressed' note must still VALIDATE on load, or the
    // whole review store for that canvas is marked broken and answers empty.
    expect(st.annotations.length).toBeGreaterThan(0)
    expect(st.annotations.find((a) => a.id === a1)!.state).toBe('addressed')
  })

  it('resolves against the CURRENT canvas, and says so when the review is not there', () => {
    // Annotation ids restart per canvas and the session's canvas can change
    // between review and resolve (a render naming a different subject files
    // the current one). Round-4 attack: fetch B's review, re-render naming A's
    // subject, resolve — and A's a1 went addressed while B's stayed open. The
    // review id now scopes the write; it cannot tell R1-on-A from R1-on-B by
    // id alone, so the guarantee is: the review must exist on the canvas the
    // agent is currently looking at, and only its own notes move.
    const cs = canvasStore
    cs.renderVersion(SID, { mode: 'design', html: '<p>login</p>', title: 'Login page' })
    const login = cs.getCanvasStateForSession(SID)!
    const l1 = store.upsertAnnotation(SID, { scope: 'general', note: 'login note', versionId: login.activeVersionId! })
    const loginReview = l1.state.reviews.find((r) => r.status === 'draft')!.id
    store.submitReview(SID, loginReview, [])

    cs.renderVersion(SID, { mode: 'design', html: '<p>checkout</p>', title: 'Checkout flow' })
    const checkout = cs.getCanvasStateForSession(SID)!
    expect(checkout.canvasId).not.toBe(login.canvasId)
    const c1 = store.upsertAnnotation(SID, { scope: 'general', note: 'checkout note', versionId: checkout.activeVersionId! })
    const checkoutReview = c1.state.reviews.find((r) => r.status === 'draft')!.id
    store.submitReview(SID, checkoutReview, [])
    expect(loginReview).toBe(checkoutReview)
    expect(l1.annotationId).toBe(c1.annotationId)

    // Agent is on checkout; resolves checkout's note. Lands on checkout.
    const r = store.markAnnotationsAddressed(SID, checkoutReview, [c1.annotationId])
    expect(r.addressed).toEqual([c1.annotationId])
    expect(r.state.canvasId).toBe(checkout.canvasId)

    // Now the login canvas — its note must be untouched.
    cs.renderVersion(SID, { mode: 'design', html: '<p>login v2</p>', title: 'Login page' })
    const st = store.getReviewStateForSession(SID)!
    expect(st.canvasId).toBe(login.canvasId)
    expect(st.annotations.find((a) => a.id === l1.annotationId)!.state).toBe('open')
  })

  it('refuses a review id that does not exist on the current canvas', () => {
    const { rid } = submitted()
    expect(() => store.markAnnotationsAddressed(SID, 'R99', ['a1'])).toThrow(/not on this canvas/)
    expect(store.markAnnotationsAddressed(SID, rid, ['a1']).addressed).toEqual(['a1'])
  })

  it('only moves notes that BELONG to the named review', () => {
    // Two submitted reviews on one canvas; resolving R1 with R2's note id must
    // not touch R2's note (it is well-formed and open, but not a member).
    const { versionId, rid, a1 } = submitted()
    const extra = store.upsertAnnotation(SID, { scope: 'general', note: 'later', versionId })
    const r2 = extra.state.reviews.find((r) => r.status === 'draft')!.id
    store.submitReview(SID, r2, [])
    const r = store.markAnnotationsAddressed(SID, rid, [a1, extra.annotationId])
    expect(r.addressed).toEqual([a1])
    expect(r.skipped).toEqual([extra.annotationId])
    expect(r.state.annotations.find((a) => a.id === extra.annotationId)!.state).toBe('open')
  })
})

describe('drafts and the ready round (#366)', () => {
  it('submitting a review CLEARS the canvas-level review-needed state', () => {
    const { canvasId, versionId } = canvasStore.renderVersion(SID, {
      mode: 'design', html: '<!doctype html><p>ready page</p>', ready: true,
    })
    expect(canvasStore.getCanvasStateForSession(SID)?.awaitingReview?.versionId).toBe(versionId)

    store.upsertAnnotation(SID, elementDraft(versionId))
    store.submitReview(SID, 'R1', [])
    expect(canvasStore.getCanvasStateForSession(SID)?.awaitingReview).toBeUndefined()
    // ...and the clear persisted with the canvas record, not only in memory.
    canvasStore._resetCanvasStoreForTest()
    expect(canvasStore.getCanvasStateForSession(SID)?.canvasId).toBe(canvasId)
    expect(canvasStore.getCanvasStateForSession(SID)?.awaitingReview).toBeUndefined()
  })

  it('a submit while the agent is DRAFTING freezes against the version the user saw, never the draft', () => {
    const ready = canvasStore.renderVersion(SID, {
      mode: 'design', html: '<!doctype html><p>round one</p>', ready: true,
    })
    store.upsertAnnotation(SID, elementDraft(ready.versionId))
    // The agent starts the next round before the user hits Send: the active
    // version moves onto a draft the pane deliberately does not show.
    const draft = canvasStore.renderVersion(SID, {
      mode: 'design', html: '<!doctype html><p>round two draft</p>', ready: false,
    })
    expect(draft.versionId).not.toBe(ready.versionId)

    const state = store.submitReview(SID, 'R1', [])
    expect(state.reviews[0].versionId).toBe(ready.versionId)
  })

  it('verdictRounds counts rounds waiting on the USER and nothing else', () => {
    const { canvasId, versionId } = renderCanvas()
    store.upsertAnnotation(SID, elementDraft(versionId, 'note one'))
    store.upsertAnnotation(SID, elementDraft(versionId, 'note two'))
    store.submitReview(SID, 'R1', [])
    // Both notes open: the round waits on the AGENT.
    expect(store.getReviewCountsForCanvas(canvasId)?.verdictRounds).toBe(0)

    store.markAnnotationsAddressed(SID, 'R1', ['a1'])
    // One addressed, one still open: still the agent's round.
    expect(store.getReviewCountsForCanvas(canvasId)?.verdictRounds).toBe(0)

    store.markAnnotationsAddressed(SID, 'R1', ['a2'])
    // Every remaining note addressed: the round is the user's.
    expect(store.getReviewCountsForCanvas(canvasId)?.verdictRounds).toBe(1)

    resolveNow('a1', 'approve')
    resolveNow('a2', 'dismiss')
    // Ruled on: nothing waits on anyone.
    expect(store.getReviewCountsForCanvas(canvasId)?.verdictRounds).toBe(0)
  })
})

describe('drafts and the notes the user can write (#366, review round 2)', () => {
  it("a user note may not name a DRAFT version — even one whose id collides with a page they saw", () => {
    canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>seen</p>', ready: true })
    canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>wip</p>', ready: false })
    const state = canvasStore.getCanvasStateForSession(SID)!
    const draftVersion = state.versions.find((v) => v.draft)!
    expect(() => store.upsertAnnotation(SID, elementDraft(draftVersion.id))).toThrow(/has not been shown/)
  })

  it('re-annotate anchors to the version the user SAW, not the agent draft the active id points at', () => {
    const ready = canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>round one</p>', ready: true })
    store.upsertAnnotation(SID, elementDraft(ready.versionId))
    store.submitReview(SID, 'R1', [])
    store.markAnnotationsAddressed(SID, 'R1', ['a1'])
    // The agent drafts the next round: activeVersionId moves onto the draft.
    canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>round two wip</p>', ready: false })

    const { state, reannotationId } = store.resolveAnnotation(SID, 'a1', 'reannotate', ready.canvasId)
    const replacement = state.annotations.find((a) => a.id === reannotationId)!
    expect(replacement.versionId).toBe(ready.versionId)
    expect(state.reviews.find((r) => r.status === 'draft')!.versionId).toBe(ready.versionId)
  })
})
