// Testing-mode EVIDENCE (M3), main-side: the ladder, the clamp, the rate gate,
// the pack cap, the pending → lock → delete cascade, the read allow-list, the
// pack name, and the run trail at submit.
//
// The security shape this file exists to pin, in one line each:
//   - the capture RECT is clamped in main, never trusted;
//   - the stamp and trail a note ends up wearing are the ones MAIN took with the
//     picture, so a save cannot dress a note in another screen's description;
//   - the read channel resolves a caller's string against paths RECORDED on the
//     canvas — a path that is not on the record answers null, traversal included;
//   - deleting a note (or its artefact, or the run) deletes its evidence.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

vi.mock('../../../src/main/ipc/setup-handlers', () => {
  const nodeFs = require('node:fs') as typeof import('node:fs')
  const nodeOs = require('node:os') as typeof import('node:os')
  const nodePath = require('node:path') as typeof import('node:path')
  const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'ccc-evidence-'))
  return { getResourcesDirectory: () => dir }
})

const { getResourcesDirectory } = await import('../../../src/main/ipc/setup-handlers')
const canvasStore = await import('../../../src/main/canvas/canvas-store')
const store = await import('../../../src/main/canvas/canvas-review-store')
const evidence = await import('../../../src/main/canvas/canvas-evidence')
const shared = await import('../../../src/shared/canvas')

const SID = 'a1b2c3d4e5f6a7b8c9d0e1f2'
const OTHER_SID = 'b1b2c3d4e5f6a7b8c9d0e1f2'

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

/** A structural NativeImage. The ladder is what is under test, so the fake
 *  reports whatever byte counts a case needs at each rung. */
function fakeImage(opts: {
  width: number
  height: number
  /** PNG byte length as a function of the longest side. */
  pngBytes: (longest: number) => number
  jpegBytes?: (longest: number) => number
  empty?: boolean
}): typeof evidence extends never ? never : Parameters<typeof evidence.encodeEvidenceShot>[0] {
  const make = (w: number, h: number): Parameters<typeof evidence.encodeEvidenceShot>[0] => ({
    getSize: () => ({ width: w, height: h }),
    isEmpty: () => opts.empty === true,
    resize: ({ width, height }) => {
      const scale = width !== undefined ? width / w : height !== undefined ? height / h : 1
      return make(Math.round(w * scale), Math.round(h * scale))
    },
    toPNG: () => Buffer.concat([PNG_MAGIC, Buffer.alloc(Math.max(0, opts.pngBytes(Math.max(w, h)) - 8))]),
    toJPEG: () =>
      Buffer.concat([JPEG_MAGIC, Buffer.alloc(Math.max(0, (opts.jpegBytes ?? ((l) => l))(Math.max(w, h)) - 3))]),
  })
  return make(opts.width, opts.height)
}

function uatVersion(): { canvasId: string; versionId: string; dist: string } {
  const dist = tmpDir('ccc-evidence-dist-')
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><body>build</body>')
  expect(canvasStore.registerCanvasUatRoot(SID, dist)).toBe(true)
  const rendered = canvasStore.renderVersion(SID, { mode: 'uat', distRoot: dist, buildLabel: '5', title: 'Checkout flow' })
  return { canvasId: rendered.canvasId, versionId: rendered.versionId, dist }
}

function stamp(overrides: Partial<import('../../../src/shared/canvas').EvidenceStateStamp> = {}) {
  return {
    capturedAt: new Date('2026-08-29T16:43:52.000Z').toISOString(),
    title: 'Checkout',
    route: '/checkout',
    viewport: { width: 1200, height: 800, scrollX: 0, scrollY: 240, dpr: 2, zoom: 1 },
    dialogs: [],
    fields: [],
    ...overrides,
  }
}

function captureFor(canvasId: string, versionId: string, trail: import('../../../src/shared/canvas').TrailEntry[] = []): string {
  const shot = evidence.encodeEvidenceShot(fakeImage({ width: 1200, height: 800, pngBytes: () => 1000 }))!
  return evidence.storePendingEvidence({ canvasId, versionId, shot, stamp: stamp(), trail })
}

function evidenceFile(canvasId: string, name: string): string {
  return path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews', 'evidence', name)
}

beforeEach(() => {
  store._resetCanvasReviewStoreForTest()
  canvasStore._resetCanvasStoreForTest()
  evidence._resetCanvasEvidenceForTest()
  fs.rmSync(path.join(getResourcesDirectory(), 'canvas'), { recursive: true, force: true })
})

afterAll(() => {
  try {
    fs.rmSync(getResourcesDirectory(), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

// ---------------------------------------------------------------------------

describe('the downscale ladder', () => {
  it('keeps PNG at the first rung that fits the cap', () => {
    // Under cap at 1600 already: nothing is resized and nothing is re-encoded.
    const shot = evidence.encodeEvidenceShot(fakeImage({ width: 1600, height: 900, pngBytes: () => 1024 }))
    expect(shot).toMatchObject({ ext: 'png', width: 1600, height: 900 })
  })

  it('steps DOWN the ladder until the bytes fit', () => {
    // Only the 720 rung is under the cap.
    const shot = evidence.encodeEvidenceShot(
      fakeImage({
        width: 3200,
        height: 1800,
        pngBytes: (longest) => (longest > 720 ? shared.MAX_EVIDENCE_SHOT_BYTES + 1 : 1000),
      }),
    )
    expect(shot?.ext).toBe('png')
    // Longest side is the width; the aspect ratio survives.
    expect(shot?.width).toBe(720)
    expect(shot?.height).toBe(405)
  })

  it('falls back to JPEG at the smallest rung rather than shipping something over cap', () => {
    const shot = evidence.encodeEvidenceShot(
      fakeImage({
        width: 3200,
        height: 1800,
        pngBytes: () => shared.MAX_EVIDENCE_SHOT_BYTES + 1,
        jpegBytes: () => 4096,
      }),
    )
    expect(shot?.ext).toBe('jpg')
    expect(shot?.bytes.length).toBe(4096)
    expect(shot!.bytes.subarray(0, 3).equals(JPEG_MAGIC)).toBe(true)
  })

  it('refuses an empty capture rather than storing a zero-byte picture', () => {
    expect(evidence.encodeEvidenceShot(fakeImage({ width: 0, height: 0, pngBytes: () => 0, empty: true }))).toBeNull()
  })

  it('caps the composer preview, and answers empty rather than failing the capture', () => {
    const ok = evidence.evidencePreviewDataUrl(fakeImage({ width: 1200, height: 800, pngBytes: () => 512 }))
    expect(ok.startsWith('data:image/png;base64,')).toBe(true)
    const jpegFallback = evidence.evidencePreviewDataUrl(
      fakeImage({ width: 1200, height: 800, pngBytes: () => 999_999, jpegBytes: () => 900 }),
    )
    expect(jpegFallback.startsWith('data:image/jpeg;base64,')).toBe(true)
    const hopeless = evidence.evidencePreviewDataUrl(
      fakeImage({ width: 1200, height: 800, pngBytes: () => 999_999, jpegBytes: () => 999_999 }),
    )
    expect(hopeless).toBe('')
  })
})

describe('the capture rectangle is clamped in main', () => {
  const bounds = { width: 1440, height: 900 }

  it('clamps a rect that runs off the window', () => {
    expect(evidence.clampCaptureRect({ x: 1200, y: 800, width: 9999, height: 9999 }, bounds)).toEqual({
      x: 1200,
      y: 800,
      width: 240,
      height: 100,
    })
  })

  it('refuses a negative, non-finite or sliver rect rather than photographing a corner', () => {
    expect(evidence.clampCaptureRect({ x: 0, y: 0, width: 4, height: 400 }, bounds)).toBeNull()
    expect(evidence.clampCaptureRect({ x: 0, y: 0, width: Number.NaN, height: 400 }, bounds)).toBeNull()
    expect(evidence.clampCaptureRect({ x: -50, y: -50, width: 8, height: 8 }, bounds)).toBeNull()
    expect(evidence.clampCaptureRect({ x: 10, y: 10, width: 100, height: 100 }, { width: 8, height: 8 })).toBeNull()
  })

  it('produces integers — the encoder and the ladder assume whole pixels', () => {
    const rect = evidence.clampCaptureRect({ x: 10.7, y: 3.2, width: 100.9, height: 50.5 }, bounds)!
    expect(Number.isInteger(rect.x) && Number.isInteger(rect.y)).toBe(true)
    expect(Number.isInteger(rect.width) && Number.isInteger(rect.height)).toBe(true)
  })
})

describe('the rate gate', () => {
  it('refuses a second capture inside the minimum interval, per session', () => {
    const t0 = 1_000_000
    expect(evidence.claimCaptureSlot(SID, t0)).toBe(true)
    expect(evidence.claimCaptureSlot(SID, t0 + 100)).toBe(false)
    // Another session is not held back by this one's gesture.
    expect(evidence.claimCaptureSlot(OTHER_SID, t0 + 100)).toBe(true)
    expect(evidence.claimCaptureSlot(SID, t0 + evidence.EVIDENCE_CAPTURE_MIN_INTERVAL_MS)).toBe(true)
  })
})

describe('the pack cap', () => {
  it('measures the DIRECTORY, and reports full at the ceiling', () => {
    const { canvasId, versionId } = uatVersion()
    expect(evidence.evidencePackBytes(canvasId)).toBe(0)
    captureFor(canvasId, versionId)
    expect(evidence.evidencePackBytes(canvasId)).toBeGreaterThan(0)
    expect(evidence.evidencePackIsFull(canvasId)).toBe(false)

    // A file the record knows nothing about still counts: the cap bounds DISK.
    fs.writeFileSync(evidenceFile(canvasId, 'pending-deadbeefdeadbeefdeadbeef.png'), Buffer.alloc(shared.MAX_EVIDENCE_PACK_BYTES))
    expect(evidence.evidencePackIsFull(canvasId)).toBe(true)
  })
})

describe('pending → lock → delete', () => {
  it('locks the capture onto the note, with the stamp and trail MAIN took', () => {
    const { canvasId, versionId } = uatVersion()
    const trail: import('../../../src/shared/canvas').TrailEntry[] = [
      { at: '2026-08-29T16:43:52.000Z', gapMs: 0, kind: 'click', target: { role: 'button', name: 'Checkout' } },
      { at: '2026-08-29T16:43:55.100Z', gapMs: 3100, kind: 'typed', target: { role: 'textbox', name: 'Email' } },
    ]
    const evidenceId = captureFor(canvasId, versionId, trail)
    expect(fs.existsSync(evidenceFile(canvasId, `pending-${evidenceId}.png`))).toBe(true)

    const saved = store.upsertAnnotation(SID, { scope: 'general', note: '', versionId, evidenceId })
    const note = saved.state.annotations.find((a) => a.id === saved.annotationId)!
    expect(note.evidence).toBeDefined()
    expect(note.evidence!.shotPath).toBe(`reviews/evidence/${saved.annotationId}.png`)
    expect(note.evidence!.stamp.route).toBe('/checkout')
    expect(note.evidence!.trail).toHaveLength(2)
    // The pending file has MOVED, not been copied.
    expect(fs.existsSync(evidenceFile(canvasId, `pending-${evidenceId}.png`))).toBe(false)
    expect(fs.existsSync(evidenceFile(canvasId, `${saved.annotationId}.png`))).toBe(true)
  })

  it('lets the evidence BE the note — empty text is legal beside it', () => {
    const { canvasId, versionId } = uatVersion()
    // Without a capture, an empty note is refused, exactly as before.
    expect(() => store.upsertAnnotation(SID, { scope: 'general', note: '', versionId })).toThrow(/invalid draft note/)
    const evidenceId = captureFor(canvasId, versionId)
    expect(() => store.upsertAnnotation(SID, { scope: 'general', note: '', versionId, evidenceId })).not.toThrow()
  })

  it('refuses a capture that belongs to another canvas — the note simply gets none', () => {
    const first = uatVersion()
    const stolen = captureFor(first.canvasId, first.versionId)
    // A second canvas, owned by the same session.
    canvasStore.renderVersion(SID, { mode: 'design', html: '<!doctype html><p>other</p>', title: 'Another subject' })
    const other = canvasStore.getCanvasStateForSession(SID)!
    expect(other.canvasId).not.toBe(first.canvasId)
    const saved = store.upsertAnnotation(SID, {
      scope: 'general',
      note: 'a note on the other canvas',
      versionId: other.versions[0].id,
      evidenceId: stolen,
    })
    expect(saved.state.annotations.find((a) => a.id === saved.annotationId)!.evidence).toBeUndefined()
    // And the first canvas's pending file is untouched.
    expect(fs.existsSync(evidenceFile(first.canvasId, `pending-${stolen}.png`))).toBe(true)
  })

  it('refuses an evidence id that is not one main minted', () => {
    const { canvasId, versionId } = uatVersion()
    expect(() =>
      store.upsertAnnotation(SID, { scope: 'general', note: 'x', versionId, evidenceId: '../../etc/passwd' }),
    ).toThrow(/invalid evidence id/)
    expect(canvasId).toBeTruthy()
  })

  it('discard deletes the pending file, and only for the caller’s own canvas', () => {
    const { canvasId, versionId } = uatVersion()
    const evidenceId = captureFor(canvasId, versionId)
    expect(evidence.discardPendingEvidence('someotherbcanvasid0000aa', evidenceId)).toBe(false)
    expect(fs.existsSync(evidenceFile(canvasId, `pending-${evidenceId}.png`))).toBe(true)
    expect(evidence.discardPendingEvidence(canvasId, evidenceId)).toBe(true)
    expect(fs.existsSync(evidenceFile(canvasId, `pending-${evidenceId}.png`))).toBe(false)
  })

  it('sweeps a pending capture nobody locked within the TTL', () => {
    const { canvasId, versionId } = uatVersion()
    const evidenceId = captureFor(canvasId, versionId)
    expect(evidence.sweepStalePendingEvidence(Date.now())).toBe(0)
    expect(evidence.sweepStalePendingEvidence(Date.now() + evidence.PENDING_EVIDENCE_TTL_MS + 1)).toBe(1)
    expect(fs.existsSync(evidenceFile(canvasId, `pending-${evidenceId}.png`))).toBe(false)
  })

  it('deleting the note deletes its evidence', () => {
    const { canvasId, versionId } = uatVersion()
    const saved = store.upsertAnnotation(SID, {
      scope: 'general',
      note: 'defect',
      versionId,
      evidenceId: captureFor(canvasId, versionId),
    })
    const file = evidenceFile(canvasId, `${saved.annotationId}.png`)
    expect(fs.existsSync(file)).toBe(true)
    store.deleteAnnotation(SID, saved.annotationId)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('deleting the artefact deletes every note’s evidence with it', () => {
    const { canvasId, versionId } = uatVersion()
    const saved = store.upsertAnnotation(SID, {
      scope: 'general',
      note: 'defect',
      versionId,
      evidenceId: captureFor(canvasId, versionId),
    })
    const file = evidenceFile(canvasId, `${saved.annotationId}.png`)
    expect(store.deleteAnnotationsForVersions(canvasId, [versionId])).toBe(1)
    expect(fs.existsSync(file)).toBe(false)
  })

  it('clearing the composer discards the capture it was holding', () => {
    const { canvasId, versionId } = uatVersion()
    const evidenceId = captureFor(canvasId, versionId)
    store.setComposerDraft(SID, canvasId, { versionId, text: 'half a note', images: [], evidenceId })
    expect(store.getReviewStateForSession(SID)!.composer!.evidenceId).toBe(evidenceId)
    store.clearComposerDraft(SID, canvasId)
    expect(fs.existsSync(evidenceFile(canvasId, `pending-${evidenceId}.png`))).toBe(false)
  })

  it('sweeps orphaned evidence on load — including pending files from a dead run', () => {
    const { canvasId, versionId } = uatVersion()
    const saved = store.upsertAnnotation(SID, {
      scope: 'general',
      note: 'keep me',
      versionId,
      evidenceId: captureFor(canvasId, versionId),
    })
    // A shot whose note went away while the app was closed, and a pending file
    // left behind by a run that ended long enough ago to be past the TTL.
    fs.writeFileSync(evidenceFile(canvasId, 'a999.png'), PNG_MAGIC)
    const stale = evidenceFile(canvasId, 'pending-0123456789abcdef01234567.png')
    fs.writeFileSync(stale, PNG_MAGIC)
    const longAgo = new Date(Date.now() - evidence.PENDING_EVIDENCE_TTL_MS - 60_000)
    fs.utimesSync(stale, longAgo, longAgo)
    // Cold start: the register is memory, so nothing here is claimed.
    store._resetCanvasReviewStoreForTest()
    evidence._resetCanvasEvidenceForTest()
    expect(store.getReviewStateForSession(SID)).not.toBeNull()
    expect(fs.existsSync(evidenceFile(canvasId, 'a999.png'))).toBe(false)
    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.existsSync(evidenceFile(canvasId, `${saved.annotationId}.png`))).toBe(true)
  })

  it('NEVER sweeps a live pending capture — the note being written right now', () => {
    // The sweep runs on the first load of ANY canvas's review record, which is
    // reachable mid-note: opening a second canvas, or reclaiming one, while the
    // shield is up. An unconditional sweep deleted the user's screenshot out
    // from under them.
    const { canvasId, versionId } = uatVersion()
    const evidenceId = captureFor(canvasId, versionId)
    const pendingFile = evidenceFile(canvasId, `pending-${evidenceId}.png`)
    // The register still holds it: the sweep must leave it alone even though
    // nothing references it (which is what "pending" means).
    expect(evidence.sweepOrphanEvidence(canvasId, new Set())).toBe(0)
    expect(fs.existsSync(pendingFile)).toBe(true)

    // And with the register gone (a fresh process), the file's own age is what
    // answers — still young, still kept.
    evidence._resetCanvasEvidenceForTest()
    expect(evidence.sweepOrphanEvidence(canvasId, new Set())).toBe(0)
    expect(fs.existsSync(pendingFile)).toBe(true)

    // Past the TTL it is exactly what sweepStalePendingEvidence would take.
    expect(evidence.sweepOrphanEvidence(canvasId, new Set(), Date.now() + evidence.PENDING_EVIDENCE_TTL_MS + 1)).toBe(1)
    expect(fs.existsSync(pendingFile)).toBe(false)
  })

  it('a FORCE close deletes the evidence of the unsent notes it removes', () => {
    // A force DELETES draft notes — an unsent note is the user's own scratch —
    // so the screenshot taken for a claim they never filed goes with it.
    const { canvasId, versionId } = uatVersion()
    const saved = store.upsertAnnotation(SID, {
      scope: 'general',
      note: 'never sent',
      versionId,
      evidenceId: captureFor(canvasId, versionId),
    })
    const file = evidenceFile(canvasId, `${saved.annotationId}.png`)
    expect(fs.existsSync(file)).toBe(true)
    const report = store.forceCloseCanvasReviews(canvasId)
    expect(report?.unsentNotes).toBe(1)
    expect(fs.existsSync(file)).toBe(false)
  })
})

describe('the read channel resolves against the RECORD, never the string', () => {
  it('answers a path the canvas records', () => {
    const { canvasId, versionId } = uatVersion()
    const saved = store.upsertAnnotation(SID, {
      scope: 'general',
      note: 'defect',
      versionId,
      evidenceId: captureFor(canvasId, versionId),
    })
    const image = store.readRecordedCanvasImage(canvasId, `reviews/evidence/${saved.annotationId}.png`)
    expect(image?.mime).toBe('image/png')
  })

  it('answers null for a path that is not on the record, however well-shaped', () => {
    const { canvasId, versionId } = uatVersion()
    store.upsertAnnotation(SID, { scope: 'general', note: 'defect', versionId, evidenceId: captureFor(canvasId, versionId) })
    // A real file, in the right directory, with a legal shape — and not recorded.
    fs.writeFileSync(evidenceFile(canvasId, 'a4242.png'), PNG_MAGIC)
    expect(store.readRecordedCanvasImage(canvasId, 'reviews/evidence/a4242.png')).toBeNull()
  })

  it('refuses a reparse point, a directory, an oversized file and a non-image', () => {
    // The path is store-minted; the FILE at it is not. Anything with write
    // access to the resources directory can swap a shot between the write and
    // the read, so the reader asks an open HANDLE what it has.
    const dir = path.join(getResourcesDirectory(), 'canvas', 'readcheck')
    fs.mkdirSync(dir, { recursive: true })

    const notAnImage = path.join(dir, 'text.png')
    fs.writeFileSync(notAnImage, Buffer.from('not a png at all'))
    expect(evidence.readImageFileChecked(notAnImage)).toBeNull()

    const oversized = path.join(dir, 'huge.png')
    fs.writeFileSync(oversized, Buffer.concat([PNG_MAGIC, Buffer.alloc(evidence.MAX_EVIDENCE_READ_BYTES)]))
    expect(evidence.readImageFileChecked(oversized)).toBeNull()

    const asDirectory = path.join(dir, 'shot.png')
    fs.mkdirSync(asDirectory, { recursive: true })
    expect(evidence.readImageFileChecked(asDirectory)).toBeNull()

    const real = path.join(dir, 'real.png')
    fs.writeFileSync(real, Buffer.concat([PNG_MAGIC, Buffer.from('body')]))
    expect(evidence.readImageFileChecked(real)?.mime).toBe('image/png')

    // The symlink half needs a privilege Windows does not grant by default. Its
    // absence is REPORTED rather than silently skipped — a test that quietly
    // checks nothing is worse than one that says so.
    const link = path.join(dir, 'link.png')
    let linked = false
    try {
      fs.symlinkSync(real, link, 'file')
      linked = true
    } catch {
      linked = false
    }
    if (linked) {
      expect(evidence.readImageFileChecked(link)).toBeNull()
    } else {
      console.warn('[canvas-evidence-store.test] symlink creation unavailable on this host; reparse-point case not exercised')
    }
  })

  it('answers null for traversal, absolute paths and the record file itself', () => {
    const { canvasId, versionId } = uatVersion()
    store.upsertAnnotation(SID, { scope: 'general', note: 'defect', versionId, evidenceId: captureFor(canvasId, versionId) })
    for (const attempt of [
      '../reviews.json',
      '../../canvas.json',
      'reviews/evidence/../../reviews.json',
      'reviews.json',
      path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews.json'),
      'reviews/evidence/',
      '',
    ]) {
      expect(store.readRecordedCanvasImage(canvasId, attempt)).toBeNull()
    }
  })
})

describe('the pack name', () => {
  it('is owner-scoped, cleaned, and cleared by null', () => {
    const { canvasId, versionId } = uatVersion()
    const named = canvasStore.setPackName(SID, canvasId, versionId, '  Checkout   flow  ')
    expect('error' in named).toBe(false)
    expect((named as import('../../../src/shared/canvas').CanvasState).versions[0].packName).toBe('Checkout flow')

    // A session that does not hold this canvas cannot rename it.
    expect(canvasStore.setPackName(OTHER_SID, canvasId, versionId, 'mine now')).toMatchObject({ error: expect.any(String) })

    const cleared = canvasStore.setPackName(SID, canvasId, versionId, null)
    expect((cleared as import('../../../src/shared/canvas').CanvasState).versions[0].packName).toBeUndefined()
  })

  it('refuses an unknown version and survives a reload', () => {
    const { canvasId, versionId } = uatVersion()
    expect(canvasStore.setPackName(SID, canvasId, 'v99', 'nope')).toMatchObject({ error: expect.any(String) })
    canvasStore.setPackName(SID, canvasId, versionId, 'Checkout flow')
    canvasStore._resetCanvasStoreForTest()
    expect(canvasStore.getCanvasStateById(canvasId)!.versions[0].packName).toBe('Checkout flow')
  })

  it('drops a hand-edited name that is not the sanitiser’s own output', () => {
    const { canvasId, versionId } = uatVersion()
    canvasStore.setPackName(SID, canvasId, versionId, 'Checkout flow')
    const file = path.join(getResourcesDirectory(), 'canvas', canvasId, 'canvas.json')
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    // A bidi override in the name would let one Library row read as another.
    record.versions[0].packName = 'Check\u202eout'
    // Re-MAC it, so the record still authenticates and the VERSION rule is what
    // is under test rather than the record's signature.
    delete record.mac
    record.mac = canvasStore._canvasRecordMacForTest(record)
    fs.writeFileSync(file, JSON.stringify(record, null, 2))
    canvasStore._resetCanvasStoreForTest()
    // The version is dropped whole rather than shown with a laundered name.
    expect(canvasStore.getCanvasStateById(canvasId)?.versions.some((v) => v.id === versionId)).toBeFalsy()
  })
})

describe('the run trail at submit', () => {
  function trailOf(count: number): import('../../../src/shared/canvas').TrailEntry[] {
    return Array.from({ length: count }, (_, i) => ({
      at: new Date(1_700_000_000_000 + i * 1000).toISOString(),
      gapMs: 1000,
      kind: 'scroll' as const,
      scrollY: i,
    }))
  }

  it('stores the run trail on the round, capped, newest kept', () => {
    const { canvasId, versionId } = uatVersion()
    store.upsertAnnotation(SID, { scope: 'general', note: 'defect', versionId })
    const reviewId = store.getReviewStateForSession(SID)!.reviews[0].id
    const state = store.submitReview(SID, reviewId, [], 'reject', trailOf(shared.MAX_TRAIL_ENTRIES_PER_RUN + 25))
    const round = state.reviews.find((r) => r.id === reviewId)!
    expect(round.trail).toHaveLength(shared.MAX_TRAIL_ENTRIES_PER_RUN)
    // The TAIL survives: what led up to the submit is what the trail is for.
    expect((round.trail![round.trail!.length - 1] as { scrollY: number }).scrollY).toBe(
      shared.MAX_TRAIL_ENTRIES_PER_RUN + 24,
    )
    expect(canvasId).toBeTruthy()
  })

  it('records NO trail for a round that carried none, rather than an empty one', () => {
    const { versionId } = uatVersion()
    store.upsertAnnotation(SID, { scope: 'general', note: 'defect', versionId })
    const reviewId = store.getReviewStateForSession(SID)!.reviews[0].id
    const state = store.submitReview(SID, reviewId, [], 'reject')
    expect(state.reviews.find((r) => r.id === reviewId)!.trail).toBeUndefined()
  })

  it('drops trail lines this build does not understand instead of refusing the submit', () => {
    const { versionId } = uatVersion()
    store.upsertAnnotation(SID, { scope: 'general', note: 'defect', versionId })
    const reviewId = store.getReviewStateForSession(SID)!.reviews[0].id
    const mixed = [
      ...trailOf(2),
      { at: 'x', gapMs: 0, kind: 'exfiltrate', payload: 'secret' } as unknown as import('../../../src/shared/canvas').TrailEntry,
    ]
    const state = store.submitReview(SID, reviewId, [], 'reject', mixed)
    expect(state.reviews.find((r) => r.id === reviewId)!.trail).toHaveLength(2)
  })
})

describe('the payload carries evidence apart from the attachments', () => {
  it('lists evidence shots in evidenceFiles, never in attachmentFiles', () => {
    const { canvasId, versionId } = uatVersion()
    const saved = store.upsertAnnotation(SID, {
      scope: 'general',
      note: 'defect',
      versionId,
      evidenceId: captureFor(canvasId, versionId),
    })
    const reviewId = store.getReviewStateForSession(SID)!.reviews[0].id
    store.submitReview(SID, reviewId, [], 'reject')
    const result = store.getReviewPayload(SID, reviewId)
    expect(result.attachmentFiles).toHaveLength(0)
    expect(result.evidenceFiles).toEqual([
      { annotationId: saved.annotationId, absPath: evidenceFile(canvasId, `${saved.annotationId}.png`) },
    ])
  })
})

describe('the load heal', () => {
  it('drops malformed evidence rather than condemning the canvas', () => {
    const { canvasId, versionId } = uatVersion()
    const saved = store.upsertAnnotation(SID, {
      scope: 'general',
      note: 'defect',
      versionId,
      evidenceId: captureFor(canvasId, versionId),
    })
    const file = path.join(getResourcesDirectory(), 'canvas', canvasId, 'reviews.json')
    const record = JSON.parse(fs.readFileSync(file, 'utf8'))
    record.annotations[0].evidence.stamp = { nonsense: true }
    fs.writeFileSync(file, JSON.stringify(record, null, 2))
    store._resetCanvasReviewStoreForTest()
    const state = store.getReviewStateForSession(SID)!
    const note = state.annotations.find((a) => a.id === saved.annotationId)
    expect(note).toBeDefined()
    expect(note!.note).toBe('defect')
    expect(note!.evidence).toBeUndefined()
  })

  it('leaves a legacy uat note with no evidence alone', () => {
    const { versionId } = uatVersion()
    const saved = store.upsertAnnotation(SID, { scope: 'general', note: 'written before evidence existed', versionId })
    store._resetCanvasReviewStoreForTest()
    const note = store.getReviewStateForSession(SID)!.annotations.find((a) => a.id === saved.annotationId)
    expect(note?.note).toBe('written before evidence existed')
  })
})
