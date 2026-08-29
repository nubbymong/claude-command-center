// Agent Canvas — Testing-mode EVIDENCE: the shot, the pending register, the
// pack accounting and the read discipline (M3).
//
// A note written in Testing is a locked evidence record: the framed page is
// screenshotted the instant the user starts writing, and the picture is stored
// beside the state stamp and the action trail taken at the same moment. This
// module owns everything about that picture that is not IPC plumbing, and it
// exists as its own file for two reasons:
//
//   - the review store and the IPC handler BOTH need it (the handler captures,
//     the store locks and deletes), and the store already imports the canvas
//     store — a third party is how the two stay acyclic;
//   - the ladder, the clamp and the pack accounting are the parts worth testing
//     directly, and a function that takes a structural image is testable without
//     an Electron window. An untestable guard is one nobody can prove still
//     works (the same reason the frame-navigation guard takes a structural
//     double).
//
// THE PATH RULE, which everything here serves: an evidence file is only ever
// named from ids this process minted. The capture writes `pending-<randomId>`,
// the lock renames it to `<annotationId>`, and the read channel resolves a
// caller's string against paths RECORDED on the canvas rather than treating it
// as a path. Nothing here ever joins a caller-supplied segment.

import * as fs from 'fs'
import * as path from 'path'
import {
  EVIDENCE_ID_RE,
  EVIDENCE_SHOT_PATH_RE,
  MAX_EVIDENCE_PACK_BYTES,
  MAX_EVIDENCE_SHOT_BYTES,
  MAX_TRAIL_ENTRIES_PER_NOTE,
  type AnnotationEvidence,
  type EvidenceStateStamp,
  type Rect,
  type TrailEntry,
} from '../../shared/canvas'
import { randomId } from '../../shared/id'
import { atomicWriteSecure, mkdirSecure } from '../account-profiles'
import { logInfo } from '../debug-logger'
import { getResourcesDirectory } from '../ipc/setup-handlers'

// ── Paths ───────────────────────────────────────────────────────────────────

/** Local copy for the same reason the review store has one: this module must
 *  not import a store to know where a canvas lives. */
function canvasDir(canvasId: string): string {
  return path.join(getResourcesDirectory(), 'canvas', canvasId)
}

/** The evidence directory, relative to the canvas dir — the prefix every stored
 *  shot path shares, and the only directory this module ever writes into. */
export const EVIDENCE_DIR_REL = 'reviews/evidence'

function evidenceDir(canvasId: string): string {
  return path.join(canvasDir(canvasId), 'reviews', 'evidence')
}

/** A pending capture's file name. `pending-` is a NAMESPACE, not a status flag:
 *  it keeps an uncommitted shot outside `EVIDENCE_SHOT_PATH_RE`, so a pending
 *  file can never be reached through a stored record's path. */
function pendingRel(evidenceId: string, ext: 'png' | 'jpg'): string {
  return `${EVIDENCE_DIR_REL}/pending-${evidenceId}.${ext}`
}

/** Where a LOCKED shot lives — keyed by the note it belongs to, so deleting the
 *  note deletes its evidence by name and no orphan bookkeeping is needed. */
function lockedRel(annotationId: string, ext: 'png' | 'jpg'): string {
  return `${EVIDENCE_DIR_REL}/${annotationId}.${ext}`
}

// ── The capture image, structurally ─────────────────────────────────────────

/**
 * The slice of Electron's `NativeImage` the ladder uses.
 *
 * Structural on purpose: the ladder and the size decisions are the interesting
 * part, and binding them to a real Electron image would make them provable only
 * in an app. Same posture as `CanvasFrameNavigationDetails`.
 */
export interface CaptureImage {
  getSize(): { width: number; height: number }
  resize(options: { width?: number; height?: number; quality?: 'good' | 'better' | 'best' }): CaptureImage
  toPNG(): Buffer
  toJPEG(quality: number): Buffer
  isEmpty(): boolean
}

/**
 * The downscale ladder, longest side first.
 *
 * A review shot has to be READABLE — the user is pointing at a defect in it —
 * so the ladder starts where a laptop viewport still reads cleanly and only
 * steps down when the bytes demand it. Three rungs rather than a continuous
 * search because each rung is a full re-encode, and a binary search over a 30 MB
 * pack's worth of captures is real time on the main process.
 */
export const EVIDENCE_SHOT_LADDER = [1600, 1100, 720] as const

/** Longest side of the composer thumbnail. */
export const EVIDENCE_PREVIEW_MAX_DIM = 320

/** Ceiling on the preview data URL handed back over IPC. The thumbnail rides
 *  the capture reply and lives in React state; it is a 320px picture, so
 *  anything past this is an encoder having a bad day, not a screenshot. */
export const MAX_EVIDENCE_PREVIEW_BYTES = 40 * 1024

/** JPEG quality the ladder falls back to when even the smallest PNG is over
 *  cap. 80 is where a screenshot of text stops showing ringing. */
const EVIDENCE_JPEG_QUALITY = 80

/**
 * Resize so the LONGEST edge is at most `maxDim`, preserving aspect ratio.
 *
 * Only one dimension is passed. Passing both distorts a non-square image —
 * measured and commented in screenshot-capture.ts, repeated here because the
 * two have no common helper and the mistake is invisible until someone looks at
 * a squashed screenshot.
 */
function constrainLongestSide(image: CaptureImage, maxDim: number): CaptureImage {
  const size = image.getSize()
  if (size.width <= maxDim && size.height <= maxDim) return image
  return size.width >= size.height
    ? image.resize({ width: maxDim, quality: 'good' })
    : image.resize({ height: maxDim, quality: 'good' })
}

export interface EncodedShot {
  bytes: Buffer
  ext: 'png' | 'jpg'
  width: number
  height: number
}

/**
 * Encode one capture down to MAX_EVIDENCE_SHOT_BYTES.
 *
 * PNG at each rung of the ladder, then — if the smallest rung is STILL over —
 * JPEG at that rung. The order is deliberate: a screenshot of a UI is mostly
 * flat colour and text, which PNG encodes both smaller and sharper than JPEG, so
 * lossy is the last resort rather than the first. The extension travels in the
 * stored path (`EVIDENCE_SHOT_PATH_RE` admits both), because the reader has to
 * know what it is looking at without sniffing.
 *
 * Returns null when there is nothing to encode — an empty image is a capture
 * that did not happen, and storing a zero-byte file would give the note a
 * picture that renders as a broken box.
 */
export function encodeEvidenceShot(image: CaptureImage): EncodedShot | null {
  if (image.isEmpty()) return null
  let smallest: CaptureImage = image
  for (const maxDim of EVIDENCE_SHOT_LADDER) {
    smallest = constrainLongestSide(image, maxDim)
    const png = smallest.toPNG()
    if (png.length > 0 && png.length <= MAX_EVIDENCE_SHOT_BYTES) {
      const size = smallest.getSize()
      return { bytes: png, ext: 'png', width: size.width, height: size.height }
    }
  }
  const jpeg = smallest.toJPEG(EVIDENCE_JPEG_QUALITY)
  if (jpeg.length === 0) return null
  const size = smallest.getSize()
  return { bytes: jpeg, ext: 'jpg', width: size.width, height: size.height }
}

/**
 * The composer thumbnail, as a data URL — or '' when even a 320px picture will
 * not fit the reply.
 *
 * '' rather than a throw: the thumbnail is a courtesy (the shot is already
 * safely on disk by then), and failing the whole capture because a preview did
 * not compress would cost the user their evidence to save them a picture.
 */
export function evidencePreviewDataUrl(image: CaptureImage): string {
  if (image.isEmpty()) return ''
  const small = constrainLongestSide(image, EVIDENCE_PREVIEW_MAX_DIM)
  const png = small.toPNG()
  if (png.length > 0 && png.length <= MAX_EVIDENCE_PREVIEW_BYTES) {
    return `data:image/png;base64,${png.toString('base64')}`
  }
  const jpeg = small.toJPEG(EVIDENCE_JPEG_QUALITY)
  if (jpeg.length > 0 && jpeg.length <= MAX_EVIDENCE_PREVIEW_BYTES) {
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`
  }
  return ''
}

// ── The capture rectangle ───────────────────────────────────────────────────

/** Smallest capture the pane will take. Below this there is no page in the
 *  picture, only a sliver — and a 1x1 "screenshot" attached to a defect note is
 *  worse than no screenshot, because it looks like evidence. */
export const MIN_CAPTURE_EDGE = 16

/**
 * Clamp a renderer-reported rectangle to the window's own content box.
 *
 * THE RECT IS THE ONE PIECE OF THE CAPTURE THE RENDERER CHOOSES, so it is
 * clamped in main rather than trusted: `capturePage` reads whatever region of
 * the window it is handed, and the window holds the user's terminals, their
 * transcripts and every other pane. A rect the renderer got wrong (a stale
 * layout, a pane mid-animation) would silently photograph the wrong thing; a
 * rect a compromised renderer chose would photograph it on purpose. Clamping to
 * the content box does not stop the second — the frame is inside that box — but
 * it keeps a capture to the region the app is actually drawing, integral and
 * finite, which is what the encoder and the ladder assume.
 *
 * Returns null when nothing usable is left, which the handler reports as
 * `capture-failed` rather than silently photographing a corner.
 */
export function clampCaptureRect(rect: Rect, bounds: { width: number; height: number }): Rect | null {
  const maxW = Math.max(0, Math.floor(bounds.width))
  const maxH = Math.max(0, Math.floor(bounds.height))
  if (maxW < MIN_CAPTURE_EDGE || maxH < MIN_CAPTURE_EDGE) return null
  const finite = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0)
  const x = Math.min(Math.max(0, Math.floor(finite(rect.x))), maxW)
  const y = Math.min(Math.max(0, Math.floor(finite(rect.y))), maxH)
  const width = Math.min(Math.max(0, Math.floor(finite(rect.width))), maxW - x)
  const height = Math.min(Math.max(0, Math.floor(finite(rect.height))), maxH - y)
  if (width < MIN_CAPTURE_EDGE || height < MIN_CAPTURE_EDGE) return null
  return { x, y, width, height }
}

// ── Rate limit ──────────────────────────────────────────────────────────────

/** Shortest gap between two captures from one session. A capture is a full
 *  window read plus up to three encodes on the main process; the gesture that
 *  triggers it (starting a note) cannot legitimately repeat faster than this. */
export const EVIDENCE_CAPTURE_MIN_INTERVAL_MS = 500

const lastCaptureAt = new Map<string, number>()

/** True when this session may capture NOW; records the attempt when it may. */
export function claimCaptureSlot(sessionId: string, now = Date.now()): boolean {
  const previous = lastCaptureAt.get(sessionId)
  if (previous !== undefined && now - previous < EVIDENCE_CAPTURE_MIN_INTERVAL_MS) return false
  lastCaptureAt.set(sessionId, now)
  return true
}

// ── The pending register ────────────────────────────────────────────────────

/**
 * A capture that has happened but is not yet locked to a note.
 *
 * THE STAMP AND THE TRAIL LIVE HERE, not on the save call, and that is the whole
 * security shape of the lock: they were taken at the same instant as the
 * picture, so a later save cannot dress a note in a stamp describing some other
 * screen. `upsertAnnotation` supplies an id and gets back the record that id
 * stands for.
 *
 * In memory only. A pending capture is a modal that is open right now; a restart
 * ends the gesture, and the file it left behind is swept as an orphan on the
 * next load of that canvas.
 */
interface PendingEvidence {
  canvasId: string
  versionId: string
  ext: 'png' | 'jpg'
  width: number
  height: number
  stamp: EvidenceStateStamp
  trail: TrailEntry[]
  createdAt: number
}

const pending = new Map<string, PendingEvidence>()

/** How long an unlocked capture survives. Long enough for a note the user
 *  wandered away from mid-write, short enough that an abandoned modal does not
 *  leave a 300 KB file in the pack forever. */
export const PENDING_EVIDENCE_TTL_MS = 30 * 60 * 1000

/** Drop (and delete) every pending capture older than the TTL. Cheap and
 *  bounded — the map holds one entry per composer, not per note. */
export function sweepStalePendingEvidence(now = Date.now()): number {
  let swept = 0
  for (const [id, entry] of pending) {
    if (now - entry.createdAt < PENDING_EVIDENCE_TTL_MS) continue
    pending.delete(id)
    unlinkQuietly(path.join(canvasDir(entry.canvasId), pendingRel(id, entry.ext)))
    swept++
  }
  return swept
}

/**
 * Write a captured shot as a pending file and register what it means.
 *
 * Files first, register second — the same order every other write in this
 * subsystem uses: a throw leaves at worst an orphan file that the next load
 * sweeps, never a register entry pointing at a file that was never written.
 */
export function storePendingEvidence(args: {
  canvasId: string
  versionId: string
  shot: EncodedShot
  stamp: EvidenceStateStamp
  trail: TrailEntry[]
}): string {
  const evidenceId = randomId()
  mkdirSecure(evidenceDir(args.canvasId))
  atomicWriteSecure(path.join(canvasDir(args.canvasId), pendingRel(evidenceId, args.shot.ext)), args.shot.bytes)
  pending.set(evidenceId, {
    canvasId: args.canvasId,
    versionId: args.versionId,
    ext: args.shot.ext,
    width: args.shot.width,
    height: args.shot.height,
    stamp: args.stamp,
    trail: args.trail.slice(-MAX_TRAIL_ENTRIES_PER_NOTE),
    createdAt: Date.now(),
  })
  return evidenceId
}

/** The pending capture's own canvas, or null when this id names nothing. Read
 *  only — used to answer "is this id even mine" before anything is moved. */
export function pendingEvidenceCanvas(evidenceId: string): string | null {
  if (typeof evidenceId !== 'string' || !EVIDENCE_ID_RE.test(evidenceId)) return null
  return pending.get(evidenceId)?.canvasId ?? null
}

/**
 * The user cancelled: forget the capture and delete its file.
 *
 * Scoped to the caller's canvas — an id alone must not be able to reach into
 * another canvas's pending capture, even to destroy it.
 */
export function discardPendingEvidence(canvasId: string, evidenceId: string): boolean {
  if (typeof evidenceId !== 'string' || !EVIDENCE_ID_RE.test(evidenceId)) return false
  const entry = pending.get(evidenceId)
  if (!entry || entry.canvasId !== canvasId) return false
  pending.delete(evidenceId)
  unlinkQuietly(path.join(canvasDir(canvasId), pendingRel(evidenceId, entry.ext)))
  return true
}

/**
 * LOCK a pending capture onto a note: move the file to the note's own name and
 * return the record the store stores.
 *
 * Refuses anything it cannot prove: an id from another canvas, a version other
 * than the one the note is on, a source file that is not a regular file (a
 * reparse point planted between the write and now — the resources directory is
 * user-selectable and writable by anything with access to it), or a target that
 * already exists as something other than a plain file.
 *
 * Returns undefined rather than throwing when the capture is simply gone: the
 * note is still worth saving, and a save that failed because a screenshot
 * expired would lose the user's words to keep a picture.
 */
export function lockEvidenceToNote(
  canvasId: string,
  versionId: string,
  annotationId: string,
  evidenceId: string,
): AnnotationEvidence | undefined {
  if (typeof evidenceId !== 'string' || !EVIDENCE_ID_RE.test(evidenceId)) return undefined
  const entry = pending.get(evidenceId)
  if (!entry || entry.canvasId !== canvasId || entry.versionId !== versionId) return undefined

  const from = path.join(canvasDir(canvasId), pendingRel(evidenceId, entry.ext))
  const shotPath = lockedRel(annotationId, entry.ext)
  const to = path.join(canvasDir(canvasId), shotPath)
  try {
    const link = fs.lstatSync(from)
    if (!link.isFile()) return undefined
    // A note being re-saved may already own a shot — with the OTHER extension,
    // if a later capture landed on a different ladder rung. Both are removed so
    // the note can never end up with two pictures and a record naming one.
    unlinkQuietly(path.join(canvasDir(canvasId), lockedRel(annotationId, 'png')))
    unlinkQuietly(path.join(canvasDir(canvasId), lockedRel(annotationId, 'jpg')))
    fs.renameSync(from, to)
  } catch (err) {
    logInfo(`[canvas-evidence] could not lock ${evidenceId} onto ${annotationId}: ${err}`)
    return undefined
  }
  pending.delete(evidenceId)
  return {
    shotPath,
    width: entry.width,
    height: entry.height,
    stamp: entry.stamp,
    trail: entry.trail,
  }
}

/** Forget this canvas's pending captures (its directory is going away). */
export function dropPendingEvidenceForCanvas(canvasId: string): void {
  for (const [id, entry] of pending) if (entry.canvasId === canvasId) pending.delete(id)
}

// ── Pack accounting ─────────────────────────────────────────────────────────

/**
 * Bytes this canvas's evidence pack currently holds.
 *
 * Measured from the DIRECTORY rather than summed from the record, deliberately:
 * the cap exists to bound disk, and the files are what occupy it — a record that
 * has lost track of a file (a crash between the write and the commit) would
 * under-report exactly when the truth matters. Unreadable answers 0, which is
 * the fail-open side and the right one: refusing every capture because a
 * directory could not be listed would break the feature over a transient.
 */
export function evidencePackBytes(canvasId: string): number {
  let total = 0
  let names: fs.Dirent[]
  try {
    names = fs.readdirSync(evidenceDir(canvasId), { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of names) {
    if (!entry.isFile()) continue
    try {
      total += fs.statSync(path.join(evidenceDir(canvasId), entry.name)).size
    } catch {
      /* vanished between the listing and the stat — it is not in the pack */
    }
  }
  return total
}

/** True when this canvas has no room for another capture. */
export function evidencePackIsFull(canvasId: string): boolean {
  return evidencePackBytes(canvasId) >= MAX_EVIDENCE_PACK_BYTES
}

// ── Deletion + orphan sweep ─────────────────────────────────────────────────

function unlinkQuietly(abs: string): void {
  try {
    fs.unlinkSync(abs)
  } catch {
    /* already gone, or locked — the record is the truth */
  }
}

/**
 * Delete one note's shot. The path is re-validated at unlink time even though
 * the record validator already checked it — the same guard
 * `deleteAnnotationsForVersions` puts on a sketch path, and for the same reason:
 * an unlink that trusts a stored string is one warm cache away from being a
 * delete-by-path primitive (ADR-009).
 */
export function deleteEvidenceShot(canvasId: string, shotPath: string | undefined): void {
  if (typeof shotPath !== 'string' || !EVIDENCE_SHOT_PATH_RE.test(shotPath)) return
  unlinkQuietly(path.join(canvasDir(canvasId), shotPath))
}

/**
 * Delete every file in the evidence directory that no note references.
 *
 * Runs ONCE per canvas per process, from the review store's load. Two things end
 * up here: shots whose note was deleted while the app was closed, and `pending-`
 * files whose gesture died with a previous run — the pending register is memory,
 * so on a fresh load every one of them is stale by definition.
 *
 * The count is logged rather than returned to a user surface: it is a
 * housekeeping fact, and a number the user cannot act on is noise in the UI and
 * signal in the log.
 */
export function sweepOrphanEvidence(canvasId: string, referenced: ReadonlySet<string>, now = Date.now()): number {
  let names: fs.Dirent[]
  try {
    names = fs.readdirSync(evidenceDir(canvasId), { withFileTypes: true })
  } catch {
    return 0
  }
  let removed = 0
  for (const entry of names) {
    if (!entry.isFile()) continue
    const rel = `${EVIDENCE_DIR_REL}/${entry.name}`
    if (referenced.has(rel)) continue
    // A LIVE PENDING CAPTURE IS NOT AN ORPHAN. It is unreferenced by
    // construction — that is what pending means — so an unconditional sweep
    // deletes the screenshot out from under a note the user is writing right
    // now. And this is reachable in an ordinary session, not only at boot: the
    // sweep runs on the FIRST load of any canvas's review record, so opening a
    // second canvas (or reclaiming one) while a note is half-written was enough.
    //
    // Two tests, because they answer for different lifetimes: the register
    // answers for a capture this process took, and the mtime answers for one
    // left behind by a run whose register died with it. Past the TTL a pending
    // file is exactly what `sweepStalePendingEvidence` would have removed
    // anyway, so the sweep may take it.
    if (entry.name.startsWith('pending-')) {
      const id = entry.name.replace(/^pending-/, '').replace(/\.(png|jpg)$/, '')
      if (pending.has(id)) continue
      let mtimeMs = 0
      try {
        mtimeMs = fs.statSync(path.join(evidenceDir(canvasId), entry.name)).mtimeMs
      } catch {
        /* vanished between the listing and the stat — nothing left to keep */
      }
      if (mtimeMs > 0 && now - mtimeMs < PENDING_EVIDENCE_TTL_MS) continue
    }
    unlinkQuietly(path.join(evidenceDir(canvasId), entry.name))
    removed++
  }
  if (removed > 0) logInfo(`[canvas-evidence] swept ${removed} orphaned evidence file(s) from ${canvasId}`)
  return removed
}

// ── Reading a recorded image back ───────────────────────────────────────────

/** PNG magic: the eight bytes every real PNG starts with. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
/** JPEG's SOI marker plus the first byte of the next one. */
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])

/** Ceiling on one image handed back over the read channel. Every file it can
 *  name is already capped at write time (300 KiB for a shot, 2 MiB for an
 *  attachment); this is the READ side saying so about the file it actually
 *  opened, which is not the file that was written. */
export const MAX_EVIDENCE_READ_BYTES = 2 * 1024 * 1024

export interface EvidenceImage {
  bytes: Buffer
  mime: 'image/png' | 'image/jpeg'
}

/**
 * Read one already-recorded image, held to atomic-write.ts's discipline about
 * WHAT it is reading — the same three steps `readAttachmentFile` takes, and for
 * the same reason: the canvas directory lives under a user-selectable resources
 * root, so anything with write access there can replace a file with a reparse
 * point aimed at a 4 GB file between the write and this read.
 *
 *   1. `lstat` — refuse a symlink or junction outright, never chase it;
 *   2. open a HANDLE and ask the handle what it is (`fstat`), so the size and
 *      the kind describe the inode actually opened;
 *   3. refuse anything that is not a regular file, is empty, or is past the cap,
 *      BEFORE allocating for it.
 *
 * The caller has already proved the path is one the canvas RECORDS. This
 * function never decides that question — it takes a relative path it is told is
 * legitimate and refuses to be a general file reader anyway.
 */
export function readCanvasImageFile(canvasId: string, relPath: string): EvidenceImage | null {
  // Belt and braces on the join: a path that resolves OUTSIDE the canvas
  // directory is not one this process minted, whatever the caller believes.
  // `path.resolve` normalises, so `..` is collapsed before the comparison — and
  // an absolute `relPath` would discard `base` entirely, which this catches.
  const base = canvasDir(canvasId)
  const abs = path.resolve(base, relPath)
  if (!abs.startsWith(base + path.sep)) return null
  return readImageFileChecked(abs)
}

/**
 * The same discipline, addressed by ABSOLUTE path — for callers that already
 * hold one the store resolved (the MCP tool's evidence shots).
 *
 * Split out because the alternative was `fs.readFileSync(absPath)`, which is
 * what the ordinary attachment path does and is exactly the read this module
 * exists to not perform: no reparse-point refusal, no size check before the
 * allocation, no answer to "is this still a regular file". The path being
 * store-derived is not the same as the FILE being what was written.
 */
export function readImageFileChecked(abs: string): EvidenceImage | null {
  let fd: number | null = null
  try {
    const link = fs.lstatSync(abs)
    if (link.isSymbolicLink()) return null
    fd = fs.openSync(abs, 'r')
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) return null
    // A HARD LINK defeats realpath entirely: a second name for an inode resolves
    // to ITSELF, not to the file it shares bytes with, so `mklink /H` — which
    // needs no privilege and no Developer Mode — plants a name inside the canvas
    // directory that reads back whatever that inode holds. The symlink refusal
    // above cannot see it. `readCheckedFile` has refused these since 2026-08-15;
    // this reader was written without the check.
    //
    // FAIL CLOSED when the count is unavailable, for the reason stated there: a
    // guard spelled `nlink !== undefined && nlink !== 1` skips itself entirely on
    // any volume that does not report link counts, which is exactly where its
    // absence is hardest to notice.
    const nlink = typeof stat.nlink === 'number' && Number.isFinite(stat.nlink) ? stat.nlink : null
    if (nlink !== 1) return null
    if (stat.size === 0 || stat.size > MAX_EVIDENCE_READ_BYTES) return null
    const bytes = Buffer.allocUnsafe(stat.size)
    const read = fs.readSync(fd, bytes, 0, stat.size, 0)
    if (read !== stat.size) return null
    if (bytes.length >= PNG_MAGIC.length && bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
      return { bytes, mime: 'image/png' }
    }
    if (bytes.length >= JPEG_MAGIC.length && bytes.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
      return { bytes, mime: 'image/jpeg' }
    }
    return null
  } catch {
    return null
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        /* nothing further to do */
      }
    }
  }
}

/**
 * One SKETCH or PASTED attachment, for `canvas_review` — the same discipline an
 * evidence shot gets, and it is here because it did not have it.
 *
 * The MCP server read these with a bare `fs.readFileSync`: no reparse-point
 * refusal, no link count, no size check before the allocation, no magic. Same
 * directory, same user-selectable resources root, same swap — the only
 * difference was which of the two readers happened to be wired to it.
 *
 * PNG ONLY: the store writes these having enforced PNG magic, so a JPEG at that
 * path is not a lenient encoder, it is a file that changed identity. Throws
 * rather than answering null, because the tool's attachment loop already treats
 * a throw as "this one could not be loaded" and reports the count — and its
 * catch never relays the message, so nothing about the path escapes.
 */
export function readAttachmentChecked(abs: string): Buffer {
  const image = readImageFileChecked(abs)
  if (!image || image.mime !== 'image/png') throw new Error('attachment refused')
  return image.bytes
}

/** Test seam: drop the in-memory registers so each test starts cold. */
export function _resetCanvasEvidenceForTest(): void {
  pending.clear()
  lastCaptureAt.clear()
}
