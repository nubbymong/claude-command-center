// Pasted images on review notes (item B, Ctrl+V) — the store's half. W15 turned
// the ONE image slot into an ordered LIST, which is the bug this file now pins:
// a second Ctrl+V used to overwrite the first, so a user who pasted three
// screenshots handed the agent one.
//
// Covered here: write on save, keep/reorder/remove on edit, ordering and the
// cap, empty text beside an attachment, delete takes every file, payload egress
// with kinds and per-note image numbers, the composer→note MOVE, the legacy
// `image` → `images[0]` heal, and the restart round-trip. The renderer
// conversion half is canvas-paste-image.test.ts.

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { vi } from 'vitest'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-note-images-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const canvasStore = await import('../../../src/main/canvas/canvas-store')
const store = await import('../../../src/main/canvas/canvas-review-store')

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'

/** Smallest thing the store accepts as a PNG: the magic plus a little body. */
function png(body: string): string {
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(body)]).toString('base64')
}
const PNG_B64 = png('body')
const PNG2_B64 = png('other-body')
const PNG3_B64 = png('third-body')

function renderCanvas(): { canvasId: string; versionId: string } {
  return canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>page</p>' })
}

function pastedFile(canvasId: string, annotationId: string, index: number): string {
  return path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews', 'pasted', `${annotationId}-${index}.png`)
}

function composerFile(canvasId: string, index: number): string {
  return path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews', 'composer', `img-${index}.png`)
}

function bodyOf(file: string): string {
  return fs.readFileSync(file).subarray(8).toString()
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

describe('save', () => {
  it('writes every PNG at save time, in order, and records the minted paths', () => {
    const { canvasId, versionId } = renderCanvas()
    const r = store.upsertAnnotation(SID, {
      scope: 'general',
      note: 'see Image 1 and Image 2',
      versionId,
      images: [{ pngBase64: PNG_B64 }, { pngBase64: PNG2_B64 }],
    })
    const note = r.state.annotations.find((a) => a.id === r.annotationId)!
    expect(note.images).toEqual([
      { pngPath: `reviews/pasted/${r.annotationId}-0.png` },
      { pngPath: `reviews/pasted/${r.annotationId}-1.png` },
    ])
    // The ORDER is the contract: "Image 2" in the text is the second file.
    expect(bodyOf(pastedFile(canvasId, r.annotationId, 0))).toBe('body')
    expect(bodyOf(pastedFile(canvasId, r.annotationId, 1))).toBe('other-body')
  })

  it('allows empty text when an attachment IS the note — an image or a drawing', () => {
    const { versionId } = renderCanvas()
    expect(() => store.upsertAnnotation(SID, { scope: 'general', note: '', versionId })).toThrow(/invalid draft note/)
    const shot = store.upsertAnnotation(SID, { scope: 'general', note: '', versionId, images: [{ pngBase64: PNG_B64 }] })
    expect(shot.state.annotations.find((a) => a.id === shot.annotationId)!.note).toBe('')
    const drawn = store.upsertAnnotation(SID, {
      scope: 'general',
      note: '',
      versionId,
      sketch: { excalidrawElementIds: ['e1'], bboxPage: { x: 0, y: 0, width: 1, height: 1 } },
    })
    expect(drawn.state.annotations.find((a) => a.id === drawn.annotationId)!.note).toBe('')
  })

  it('accepts a sketch AND images on one note — the drawing rides it', () => {
    // The old rule was one attachment, sketch OR image. It is gone: a drawing
    // now rides whatever note the user writes next, so it can never be in
    // competition with a paste for a single slot.
    const { versionId } = renderCanvas()
    const r = store.upsertAnnotation(SID, {
      scope: 'general',
      note: 'both',
      versionId,
      sketch: { excalidrawElementIds: ['e1'], bboxPage: { x: 0, y: 0, width: 1, height: 1 } },
      images: [{ pngBase64: PNG_B64 }],
    })
    const note = r.state.annotations.find((a) => a.id === r.annotationId)!
    expect(note.sketch?.excalidrawElementIds).toEqual(['e1'])
    expect(note.images).toHaveLength(1)
  })

  it('caps the list and refuses non-PNG bytes', () => {
    const { versionId } = renderCanvas()
    expect(() =>
      store.upsertAnnotation(SID, { scope: 'general', note: 'x', versionId, images: [{ pngBase64: Buffer.from('not a png').toString('base64') }] }),
    ).toThrow(/not a png/)
    expect(() =>
      store.upsertAnnotation(SID, {
        scope: 'general',
        note: 'x',
        versionId,
        images: Array.from({ length: 9 }, () => ({ pngBase64: PNG_B64 })),
      }),
    ).toThrow(/too many images/)
  })

  it('refuses a reference to a composer image that is not there', () => {
    const { versionId } = renderCanvas()
    expect(() =>
      store.upsertAnnotation(SID, { scope: 'general', note: 'x', versionId, images: [{ fromComposer: 0 }] }),
    ).toThrow(/composer image is gone/)
  })
})

describe('edit', () => {
  it('keeps by SOURCE index, so removing the first renumbers without losing the rest', () => {
    const { canvasId, versionId } = renderCanvas()
    const r = store.upsertAnnotation(SID, {
      scope: 'general',
      note: 'Image 1 Image 2 Image 3',
      versionId,
      images: [{ pngBase64: PNG_B64 }, { pngBase64: PNG2_B64 }, { pngBase64: PNG3_B64 }],
    })
    const id = r.annotationId

    // Drop the FIRST. Under a destination-indexed scheme this silently keeps
    // the deleted image and drops the last one.
    const after = store.upsertAnnotation(SID, {
      annotationId: id,
      scope: 'general',
      note: 'Image 1 Image 2',
      versionId,
      images: [{ fromNote: 1 }, { fromNote: 2 }],
    })
    expect(after.state.annotations.find((a) => a.id === id)!.images).toEqual([
      { pngPath: `reviews/pasted/${id}-0.png` },
      { pngPath: `reviews/pasted/${id}-1.png` },
    ])
    expect(bodyOf(pastedFile(canvasId, id, 0))).toBe('other-body')
    expect(bodyOf(pastedFile(canvasId, id, 1))).toBe('third-body')
    // The third slot is gone with the note that no longer names it.
    expect(fs.existsSync(pastedFile(canvasId, id, 2))).toBe(false)
  })

  it('reorders without clobbering — a swap reads every source before it writes', () => {
    const { canvasId, versionId } = renderCanvas()
    const r = store.upsertAnnotation(SID, {
      scope: 'general',
      note: 'two',
      versionId,
      images: [{ pngBase64: PNG_B64 }, { pngBase64: PNG2_B64 }],
    })
    const id = r.annotationId
    store.upsertAnnotation(SID, {
      annotationId: id,
      scope: 'general',
      note: 'two',
      versionId,
      images: [{ fromNote: 1 }, { fromNote: 0 }],
    })
    expect(bodyOf(pastedFile(canvasId, id, 0))).toBe('other-body')
    expect(bodyOf(pastedFile(canvasId, id, 1))).toBe('body')
  })

  it('absent removes every image and unlinks the files', () => {
    const { canvasId, versionId } = renderCanvas()
    const r = store.upsertAnnotation(SID, {
      scope: 'general',
      note: 'shots',
      versionId,
      images: [{ pngBase64: PNG_B64 }, { pngBase64: PNG2_B64 }],
    })
    const id = r.annotationId
    const removed = store.upsertAnnotation(SID, { annotationId: id, scope: 'general', note: 'no shots', versionId })
    expect(removed.state.annotations.find((a) => a.id === id)!.images).toBeUndefined()
    expect(fs.existsSync(pastedFile(canvasId, id, 0))).toBe(false)
    expect(fs.existsSync(pastedFile(canvasId, id, 1))).toBe(false)
  })

  it('refuses a fromNote index the note does not have', () => {
    const { versionId } = renderCanvas()
    const r = store.upsertAnnotation(SID, { scope: 'general', note: 'plain', versionId })
    expect(() =>
      store.upsertAnnotation(SID, { annotationId: r.annotationId, scope: 'general', note: 'plain', versionId, images: [{ fromNote: 0 }] }),
    ).toThrow(/note image is gone/)
  })
})

describe('the composer draft (W14)', () => {
  it('persists text, decision, target, images and the scene, and hands them back', () => {
    const { canvasId, versionId } = renderCanvas()
    const state = store.setComposerDraft(SID, canvasId, {
      versionId,
      decision: 'reject',
      text: 'half a thought, see Image 1',
      images: [{ pngBase64: PNG_B64 }],
      sketch: { scene: '[{"id":"e1"}]', versions: { e1: versionId } },
    })
    expect(state.composer).toMatchObject({
      versionId,
      decision: 'reject',
      text: 'half a thought, see Image 1',
      images: [{ pngPath: 'reviews/composer/img-0.png' }],
      sketch: { scene: '[{"id":"e1"}]', versions: { e1: versionId } },
    })
    expect(bodyOf(composerFile(canvasId, 0))).toBe('body')
  })

  it("'keep' costs no bytes, and a removal names its SOURCE so the right file survives", () => {
    const { canvasId, versionId } = renderCanvas()
    store.setComposerDraft(SID, canvasId, {
      versionId,
      text: 'two shots',
      images: [{ pngBase64: PNG_B64 }, { pngBase64: PNG2_B64 }],
    })
    const after = store.setComposerDraft(SID, canvasId, {
      versionId,
      text: 'one shot',
      images: [{ keepIndex: 1 }],
    })
    expect(after.composer!.images).toEqual([{ pngPath: 'reviews/composer/img-0.png' }])
    expect(bodyOf(composerFile(canvasId, 0))).toBe('other-body')
    expect(fs.existsSync(composerFile(canvasId, 1))).toBe(false)
  })

  it('MOVES its images onto the note that takes them, and forgets them', () => {
    const { canvasId, versionId } = renderCanvas()
    store.setComposerDraft(SID, canvasId, { versionId, text: 'draft', images: [{ pngBase64: PNG_B64 }] })
    const r = store.upsertAnnotation(SID, { scope: 'general', note: 'Image 1 is wrong', versionId, images: [{ fromComposer: 0 }] })
    const note = r.state.annotations.find((a) => a.id === r.annotationId)!
    expect(note.images).toEqual([{ pngPath: `reviews/pasted/${r.annotationId}-0.png` }])
    expect(bodyOf(pastedFile(canvasId, r.annotationId, 0))).toBe('body')
    // Moved, not copied: the composer no longer lists it and the file is gone,
    // so nothing draws a tile for a picture that is not there.
    expect(r.state.composer?.images ?? []).toEqual([])
    expect(fs.existsSync(composerFile(canvasId, 0))).toBe(false)
  })

  it('refuses a canvas this session does not own, and a version the user never saw', () => {
    const { canvasId, versionId } = renderCanvas()
    expect(() => store.setComposerDraft(SID, 'someone-elses-canvas', { versionId, text: 'x', images: [] })).toThrow(
      /not this session/,
    )
    expect(() => store.setComposerDraft(SID, canvasId, { versionId: 'v99', text: 'x', images: [] })).toThrow(/unknown version/)
  })

  it('is cleared on submit, with its files', () => {
    const { canvasId, versionId } = renderCanvas()
    store.upsertAnnotation(SID, { scope: 'general', note: 'the real note', versionId })
    store.setComposerDraft(SID, canvasId, { versionId, text: 'still typing', images: [{ pngBase64: PNG_B64 }] })
    const after = store.submitReview(SID, 'R1', [], 'reject')
    expect(after.composer).toBeUndefined()
    expect(fs.existsSync(composerFile(canvasId, 0))).toBe(false)
  })

  it('is cleared on demand, with its files', () => {
    const { canvasId, versionId } = renderCanvas()
    store.setComposerDraft(SID, canvasId, { versionId, text: 'never mind', images: [{ pngBase64: PNG_B64 }] })
    const after = store.clearComposerDraft(SID, canvasId)
    expect(after.composer).toBeUndefined()
    expect(fs.existsSync(composerFile(canvasId, 0))).toBe(false)
  })

  it('refuses a scene past the byte cap — main never parses it, so bytes are the only bound', () => {
    const { canvasId, versionId } = renderCanvas()
    expect(() =>
      store.setComposerDraft(SID, canvasId, { versionId, text: 'x', images: [], sketch: { scene: 'a'.repeat(512 * 1024 + 1), versions: {} } }),
    ).toThrow(/too large/)
  })

  it('survives a restart', () => {
    const { canvasId, versionId } = renderCanvas()
    store.setComposerDraft(SID, canvasId, { versionId, decision: 'approve', text: 'kept', images: [{ pngBase64: PNG_B64 }] })
    store._resetCanvasReviewStoreForTest()
    const state = store.getReviewStateForSession(SID)!
    expect(state.composer).toMatchObject({ decision: 'approve', text: 'kept', images: [{ pngPath: 'reviews/composer/img-0.png' }] })
  })
})

describe('delete + egress + restart', () => {
  it('deleting the draft note takes every one of its files with it', () => {
    const { canvasId, versionId } = renderCanvas()
    const r = store.upsertAnnotation(SID, {
      scope: 'general',
      note: '',
      versionId,
      images: [{ pngBase64: PNG_B64 }, { pngBase64: PNG2_B64 }],
    })
    expect(fs.existsSync(pastedFile(canvasId, r.annotationId, 1))).toBe(true)
    store.deleteAnnotation(SID, r.annotationId)
    expect(fs.existsSync(pastedFile(canvasId, r.annotationId, 0))).toBe(false)
    expect(fs.existsSync(pastedFile(canvasId, r.annotationId, 1))).toBe(false)
  })

  it('submit needs no export for image notes, and the payload numbers them per note', () => {
    const { canvasId, versionId } = renderCanvas()
    const r = store.upsertAnnotation(SID, {
      scope: 'general',
      note: 'Image 1 then Image 2',
      versionId,
      images: [{ pngBase64: PNG_B64 }, { pngBase64: PNG2_B64 }],
    })
    store.submitReview(SID, 'R1', [], 'reject')
    const payload = store.getReviewPayload(SID, 'R1')
    expect(payload.payload.attachments).toEqual([
      { annotationId: r.annotationId, pngPath: `reviews/pasted/${r.annotationId}-0.png`, kind: 'image', imageIndex: 1 },
      { annotationId: r.annotationId, pngPath: `reviews/pasted/${r.annotationId}-1.png`, kind: 'image', imageIndex: 2 },
    ])
    expect(payload.attachmentFiles.map((f) => f.absPath)).toEqual([
      path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews', 'pasted', `${r.annotationId}-0.png`),
      path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews', 'pasted', `${r.annotationId}-1.png`),
    ])
  })

  it('survives a restart: the image list round-trips through reviews.json', () => {
    const { versionId } = renderCanvas()
    const r = store.upsertAnnotation(SID, {
      scope: 'general',
      note: 'persisted',
      versionId,
      images: [{ pngBase64: PNG_B64 }, { pngBase64: PNG2_B64 }],
    })
    store._resetCanvasReviewStoreForTest()
    const state = store.getReviewStateForSession(SID)!
    expect(state.annotations.find((a) => a.id === r.annotationId)!.images).toEqual([
      { pngPath: `reviews/pasted/${r.annotationId}-0.png` },
      { pngPath: `reviews/pasted/${r.annotationId}-1.png` },
    ])
  })
})

describe('the legacy single image heals into the list', () => {
  const reviewsPath = (canvasId: string) => path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews.json')

  it('lifts `image` to `images[0]`, keeping the same file', () => {
    // A record written before W15: one image, at the un-suffixed path. The heal
    // must not MOVE the file — it runs in memory, and a failed move would leave
    // the record pointing at nothing.
    const { canvasId, versionId } = renderCanvas()
    const r = store.upsertAnnotation(SID, { scope: 'general', note: 'old shape', versionId, images: [{ pngBase64: PNG_B64 }] })
    const rec = JSON.parse(fs.readFileSync(reviewsPath(canvasId), 'utf8'))
    delete rec.annotations[0].images
    rec.annotations[0].image = { pngPath: `reviews/pasted/${r.annotationId}.png` }
    fs.writeFileSync(reviewsPath(canvasId), JSON.stringify(rec))

    store._resetCanvasReviewStoreForTest()
    const healed = store.getReviewStateForSession(SID)!.annotations.find((a) => a.id === r.annotationId)!
    expect(healed.images).toEqual([{ pngPath: `reviews/pasted/${r.annotationId}.png` }])
    expect((healed as { image?: unknown }).image).toBeUndefined()
  })

  it('drops a malformed one rather than condemning the canvas', () => {
    const { canvasId, versionId } = renderCanvas()
    const r = store.upsertAnnotation(SID, { scope: 'general', note: 'still readable', versionId })
    const rec = JSON.parse(fs.readFileSync(reviewsPath(canvasId), 'utf8'))
    rec.annotations[0].image = { pngPath: 'reviews/pasted/../../../evil.png' }
    fs.writeFileSync(reviewsPath(canvasId), JSON.stringify(rec))

    store._resetCanvasReviewStoreForTest()
    const healed = store.getReviewStateForSession(SID)!.annotations.find((a) => a.id === r.annotationId)!
    expect(healed.note).toBe('still readable')
    expect(healed.images).toBeUndefined()
  })
})

// The paste change adds a new way for a stored record to fail the file
// validator (a hand-edited / cross-process-torn images[] path the
// IMAGE_PNG_PATH_RE rejects), which surfaced a pre-existing fail-open:
// requireHealthy runs BEFORE the load that populates `broken`, so the FIRST
// mutation after a cold start used to overwrite a corrupt reviews.json with a
// fresh empty record — destroying preserved review history. recordFor now
// re-asserts health after the load.
describe('a corrupt reviews.json is never overwritten on first touch (adversarial F2)', () => {
  const reviewsPath = (canvasId: string) => path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews.json')

  it('the FIRST mutation after a cold start refuses, leaving the corrupt file intact', () => {
    const { canvasId, versionId } = renderCanvas()
    // A real prior review, with a real pasted image, on disk.
    store.upsertAnnotation(SID, { scope: 'general', note: 'prior feedback', versionId, images: [{ pngBase64: PNG_B64 }] })
    // Corrupt it the way the new path makes reachable: a traversal pngPath the
    // load validator (IMAGE_PNG_PATH_RE) rejects → the whole record is invalid.
    const rec = JSON.parse(fs.readFileSync(reviewsPath(canvasId), 'utf8'))
    rec.annotations[0].images[0].pngPath = 'reviews/pasted/../../../evil.png'
    const corruptText = JSON.stringify(rec)
    fs.writeFileSync(reviewsPath(canvasId), corruptText)

    // Cold start: no prior read, so `broken` is empty and requireHealthy alone
    // would pass. This first mutation is the dangerous one.
    store._resetCanvasReviewStoreForTest()
    expect(() =>
      store.upsertAnnotation(SID, { scope: 'general', note: 'new note on a corrupt store', versionId }),
    ).toThrow(/review store unreadable/)

    // The corrupt file is preserved byte-for-byte — evidence, not free space.
    expect(fs.readFileSync(reviewsPath(canvasId), 'utf8')).toBe(corruptText)
  })

  it('still heals a genuinely ABSENT store to a fresh empty record (no over-refusal)', () => {
    // The fix must distinguish "file exists but invalid" (refuse) from "no file
    // yet" (heal). A brand-new canvas has no reviews.json; the first note must
    // still land.
    const { canvasId, versionId } = renderCanvas()
    expect(fs.existsSync(reviewsPath(canvasId))).toBe(false)
    const r = store.upsertAnnotation(SID, { scope: 'general', note: 'first ever note', versionId })
    expect(r.state.annotations.find((a) => a.id === r.annotationId)!.note).toBe('first ever note')
  })
})

describe('reading an attachment back is held to the atomic-write discipline', () => {
  it('refuses a reparse point where an attachment should be, before reading it', () => {
    // The canvas dir lives under a user-selectable resources root, so anything
    // with write access there can swap an attachment for a link aimed at a huge
    // file — or at something outside the canvas. readFileSync would follow it.
    const { canvasId, versionId } = renderCanvas()
    store.setComposerDraft(SID, canvasId, { versionId, text: 'draft', images: [{ pngBase64: PNG_B64 }] })
    const real = composerFile(canvasId, 0)
    const elsewhere = path.join(getResourcesDirectory(), 'outside.png')
    fs.writeFileSync(elsewhere, Buffer.from(PNG_B64, 'base64'))
    fs.rmSync(real)
    let linked = true
    try {
      fs.symlinkSync(elsewhere, real, 'file')
    } catch {
      // Windows without developer mode refuses to create the link at all, which
      // is the same protection by a different route.
      linked = false
    }
    if (!linked) return
    expect(() =>
      store.upsertAnnotation(SID, { scope: 'general', note: 'take it', versionId, images: [{ fromComposer: 0 }] }),
    ).toThrow(/reparse point/)
  })

  it('refuses a directory standing in for an attachment', () => {
    const { canvasId, versionId } = renderCanvas()
    store.setComposerDraft(SID, canvasId, { versionId, text: 'draft', images: [{ pngBase64: PNG_B64 }] })
    const real = composerFile(canvasId, 0)
    fs.rmSync(real)
    fs.mkdirSync(real)
    expect(() =>
      store.upsertAnnotation(SID, { scope: 'general', note: 'take it', versionId, images: [{ fromComposer: 0 }] }),
    ).toThrow()
  })
})

describe('the drawing caps are keyed by what they bound', () => {
  it('accepts a scene with far more stamps than a single note may carry', () => {
    // The old bound was a per-NOTE element limit multiplied by four, which sat
    // well below what half a megabyte of scene legitimately holds — so a large
    // drawing was refused by the stamps long before its bytes came near.
    const { canvasId, versionId } = renderCanvas()
    const versions: Record<string, string> = {}
    for (let i = 0; i < 900; i++) versions['e' + i] = versionId
    const state = store.setComposerDraft(SID, canvasId, {
      versionId,
      text: 'a big drawing',
      images: [],
      sketch: { scene: '[]', versions },
    })
    expect(Object.keys(state.composer!.sketch!.versions)).toHaveLength(900)
  })

  it('still refuses past the element cap', () => {
    const { canvasId, versionId } = renderCanvas()
    const versions: Record<string, string> = {}
    for (let i = 0; i <= 2000; i++) versions['e' + i] = versionId
    expect(() =>
      store.setComposerDraft(SID, canvasId, { versionId, text: 'x', images: [], sketch: { scene: '[]', versions } }),
    ).toThrow(/too many drawing elements/)
  })
})
