// Pasted images on review notes (item B, Ctrl+V): the store's half — write on
// save, keep/replace/remove on edit, the one-attachment rule, empty text only
// beside an image, delete takes the file, payload/attachment egress, restart
// round-trip. The renderer conversion half is canvas-paste-image.test.ts.

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
const PNG_B64 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('body'),
]).toString('base64')
const PNG2_B64 = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('other-body'),
]).toString('base64')

function renderCanvas(): { canvasId: string; versionId: string } {
  return canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>page</p>' })
}

function pastedFile(canvasId: string, annotationId: string): string {
  return path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews', 'pasted', `${annotationId}.png`)
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
  it('writes the PNG at save time and records the minted path', () => {
    const { canvasId, versionId } = renderCanvas()
    const r = store.upsertAnnotation(SID, { scope: 'general', note: 'see this', versionId, image: { pngBase64: PNG_B64 } })
    const note = r.state.annotations.find((a) => a.id === r.annotationId)!
    expect(note.image).toEqual({ pngPath: `reviews/pasted/${r.annotationId}.png` })
    expect(fs.readFileSync(pastedFile(canvasId, r.annotationId)).subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  })

  it('allows empty text only when an image rides the note', () => {
    const { versionId } = renderCanvas()
    expect(() => store.upsertAnnotation(SID, { scope: 'general', note: '', versionId })).toThrow(/invalid draft note/)
    const r = store.upsertAnnotation(SID, { scope: 'general', note: '', versionId, image: { pngBase64: PNG_B64 } })
    expect(r.state.annotations.find((a) => a.id === r.annotationId)!.note).toBe('')
  })

  it('refuses a note carrying both a sketch and an image', () => {
    const { versionId } = renderCanvas()
    expect(() =>
      store.upsertAnnotation(SID, {
        scope: 'general',
        note: 'both',
        versionId,
        sketch: { excalidrawElementIds: ['e1'], bboxPage: { x: 0, y: 0, width: 1, height: 1 } },
        image: { pngBase64: PNG_B64 },
      }),
    ).toThrow(/one attachment/)
  })

  it('refuses non-PNG bytes and keep-on-a-new-note', () => {
    const { versionId } = renderCanvas()
    expect(() =>
      store.upsertAnnotation(SID, { scope: 'general', note: 'x', versionId, image: { pngBase64: Buffer.from('not a png').toString('base64') } }),
    ).toThrow(/not a png/)
    expect(() => store.upsertAnnotation(SID, { scope: 'general', note: 'x', versionId, image: 'keep' })).toThrow(/no image to keep/)
  })
})

describe('edit', () => {
  it("'keep' preserves, fresh bytes replace, absent removes and unlinks", () => {
    const { canvasId, versionId } = renderCanvas()
    const r = store.upsertAnnotation(SID, { scope: 'general', note: 'v1', versionId, image: { pngBase64: PNG_B64 } })
    const id = r.annotationId
    const file = pastedFile(canvasId, id)

    const kept = store.upsertAnnotation(SID, { annotationId: id, scope: 'general', note: 'v2', versionId, image: 'keep' })
    expect(kept.state.annotations.find((a) => a.id === id)!.image).toEqual({ pngPath: `reviews/pasted/${id}.png` })

    store.upsertAnnotation(SID, { annotationId: id, scope: 'general', note: 'v3', versionId, image: { pngBase64: PNG2_B64 } })
    expect(fs.readFileSync(file).toString()).toContain('other-body')

    const removed = store.upsertAnnotation(SID, { annotationId: id, scope: 'general', note: 'v4', versionId })
    expect(removed.state.annotations.find((a) => a.id === id)!.image).toBeUndefined()
    expect(fs.existsSync(file)).toBe(false)
  })

  it("'keep' on a note that has no image is refused", () => {
    const { versionId } = renderCanvas()
    const r = store.upsertAnnotation(SID, { scope: 'general', note: 'plain', versionId })
    expect(() =>
      store.upsertAnnotation(SID, { annotationId: r.annotationId, scope: 'general', note: 'plain', versionId, image: 'keep' }),
    ).toThrow(/no image to keep/)
  })
})

describe('delete + egress + restart', () => {
  it('deleting the draft note takes its file with it', () => {
    const { canvasId, versionId } = renderCanvas()
    const r = store.upsertAnnotation(SID, { scope: 'general', note: '', versionId, image: { pngBase64: PNG_B64 } })
    expect(fs.existsSync(pastedFile(canvasId, r.annotationId))).toBe(true)
    store.deleteAnnotation(SID, r.annotationId)
    expect(fs.existsSync(pastedFile(canvasId, r.annotationId))).toBe(false)
  })

  it('submit needs no export for an image note, and the payload lists the PNG as an attachment', () => {
    const { canvasId, versionId } = renderCanvas()
    const r = store.upsertAnnotation(SID, { scope: 'general', note: 'shot attached', versionId, image: { pngBase64: PNG_B64 } })
    store.submitReview(SID, 'R1', [])
    const payload = store.getReviewPayload(SID, 'R1')
    expect(payload.payload.attachments).toEqual([{ annotationId: r.annotationId, pngPath: `reviews/pasted/${r.annotationId}.png` }])
    expect(payload.attachmentFiles).toEqual([
      { annotationId: r.annotationId, absPath: path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews', 'pasted', `${r.annotationId}.png`) },
    ])
  })

  it('survives a restart: the image field round-trips through reviews.json', () => {
    const { versionId } = renderCanvas()
    const r = store.upsertAnnotation(SID, { scope: 'general', note: 'persisted', versionId, image: { pngBase64: PNG_B64 } })
    store._resetCanvasReviewStoreForTest()
    const state = store.getReviewStateForSession(SID)!
    expect(state.annotations.find((a) => a.id === r.annotationId)!.image).toEqual({ pngPath: `reviews/pasted/${r.annotationId}.png` })
  })
})
