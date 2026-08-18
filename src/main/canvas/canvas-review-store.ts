// Agent Canvas — main-process store of reviews and annotations (P3, spec §4/§6).
//
// One reviews.json per canvas (`<resources>/canvas/<canvasId>/reviews.json`),
// beside the canvas.json the version store keeps; sketch PNGs are real files
// under `reviews/<reviewId>/`. Same discipline as the version store:
//
//   - the store is the SINGLE mutation point (IPC handlers and the
//     canvas_review MCP tool both come through here),
//   - every write goes mkdirSecure + atomicWriteSecure,
//   - every mutation builds the next record OFF TO THE SIDE, persists it, and
//     only then commits it to memory (fail closed — the renderVersion lesson:
//     a persist throw must never leave memory ahead of disk),
//   - ids are minted here and never accepted from a caller.
//
// A reviews.json that exists but does not validate marks that canvas's review
// store BROKEN: reads answer empty, mutations refuse. Treating it as absent
// instead would let the next note quietly overwrite the whole review history
// with a fresh record — a corrupt file is preserved evidence, not free space.

import * as fs from 'fs'
import * as path from 'path'
import {
  CANVAS_ANNOTATION_ID_RE,
  CANVAS_REVIEW_ID_RE,
  CANVAS_VERSION_ID_RE,
  type AnchorRef,
  type Annotation,
  type AnnotationSketch,
  type CanvasAnnotationDraft,
  type CanvasReviewChangedEvent,
  type CanvasReviewState,
  type CanvasSketchExport,
  type FocusObject,
  type Rect,
  type Review,
  type ReviewPayload,
} from '../../shared/canvas'
import { atomicWriteSecure, mkdirSecure } from '../account-profiles'
import { getResourcesDirectory } from '../ipc/setup-handlers'
import { getCanvasStateForSession } from './canvas-store'

// ── Bounds (shared intent with the IPC schemas; the store re-checks because it
//    is the last line, and the MCP tool reads through it) ────────────────────

const NOTE_MAX_CHARS = 4000
const LABEL_MAX_CHARS = 120
const ANCHOR_STRING_MAX = 512
const MAX_TARGETS_PER_FOCUS = 8
const MAX_ANNOTATIONS_PER_REVIEW = 100
const MAX_REVIEWS_PER_CANVAS = 200
const MAX_SKETCH_ELEMENT_IDS = 100
const SKETCH_ELEMENT_ID_MAX = 128
/** One exported sketch PNG. Far beyond any real annotation sketch; small
 *  enough that a submit can't be turned into a disk-filling primitive. */
export const MAX_SKETCH_PNG_BYTES = 2 * 1024 * 1024

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
/** The one shape a stored pngPath may have — minted here, revalidated on load
 *  so a hand-edited record cannot point the MCP tool at an arbitrary file. */
const PNG_PATH_RE = /^reviews\/R[0-9]{1,9}\/a[0-9]{1,9}\.png$/

// ── Record shape on disk ────────────────────────────────────────────────────

interface ReviewFileRecord {
  canvasId: string
  sessionId: string
  nextReview: number
  nextAnnotation: number
  reviews: Review[]
  annotations: Annotation[]
}

const records = new Map<string, ReviewFileRecord>()
/** Canvases whose reviews.json exists but does not validate. */
const broken = new Set<string>()

type ReviewChangedListener = (event: CanvasReviewChangedEvent) => void
const changeListeners = new Set<ReviewChangedListener>()

export function onReviewChanged(listener: ReviewChangedListener): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function emitChanged(record: ReviewFileRecord): void {
  const event: CanvasReviewChangedEvent = { sessionId: record.sessionId, canvasId: record.canvasId }
  for (const listener of changeListeners) {
    try {
      listener(event)
    } catch (err) {
      console.warn('[canvas-review-store] change listener failed:', err)
    }
  }
}

// ── Paths ───────────────────────────────────────────────────────────────────

function canvasDir(canvasId: string): string {
  return path.join(getResourcesDirectory(), 'canvas', canvasId)
}

function reviewsJsonPath(canvasId: string): string {
  return path.join(canvasDir(canvasId), 'reviews.json')
}

function persist(record: ReviewFileRecord): void {
  const dir = canvasDir(record.canvasId)
  mkdirSecure(dir)
  atomicWriteSecure(reviewsJsonPath(record.canvasId), JSON.stringify(record, null, 2))
}

// ── Validation ──────────────────────────────────────────────────────────────

/** Strings that will be displayed or serialized: bounded, and no control
 *  characters. `note` alone may hold newlines/tabs (it is the one multi-line
 *  field a user types). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_INCL_NEWLINES = /[\u0000-\u001F\u007F]/

function isCleanString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max && !CONTROL_CHARS_INCL_NEWLINES.test(value)
}

function isCleanNote(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= NOTE_MAX_CHARS && !CONTROL_CHARS.test(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isValidRect(value: unknown): value is Rect {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Partial<Rect>
  return isFiniteNumber(r.x) && isFiniteNumber(r.y) && isFiniteNumber(r.width) && isFiniteNumber(r.height) && r.width >= 0 && r.height >= 0
}

function isValidAnchor(value: unknown): value is AnchorRef {
  if (typeof value !== 'object' || value === null) return false
  const a = value as Record<string, unknown>
  if (a.kind === 'ux-id' || a.kind === 'plan-step') {
    return isCleanString(a.id, ANCHOR_STRING_MAX) && (a.id as string).length > 0
  }
  if (a.kind === 'fingerprint') {
    return (
      isCleanString(a.role, ANCHOR_STRING_MAX) &&
      isCleanString(a.name, ANCHOR_STRING_MAX) &&
      isCleanString(a.ancestorPath, ANCHOR_STRING_MAX) &&
      typeof a.ordinal === 'number' &&
      Number.isInteger(a.ordinal) &&
      a.ordinal >= 0 &&
      a.ordinal <= 1_000_000
    )
  }
  return false
}

function isValidFocus(value: unknown): value is FocusObject {
  if (typeof value !== 'object' || value === null) return false
  const f = value as Partial<FocusObject> & Record<string, unknown>
  if (!Array.isArray(f.targets) || f.targets.length > MAX_TARGETS_PER_FOCUS) return false
  if (!f.targets.every(isValidAnchor)) return false
  if (!isValidRect(f.bboxPage)) return false
  if (!isCleanString(f.label, LABEL_MAX_CHARS)) return false
  return typeof f.versionId === 'string' && CANVAS_VERSION_ID_RE.test(f.versionId)
}

function isValidSketchMeta(value: unknown): value is { excalidrawElementIds: string[]; bboxPage: Rect } {
  if (typeof value !== 'object' || value === null) return false
  const s = value as Record<string, unknown>
  if (!Array.isArray(s.excalidrawElementIds) || s.excalidrawElementIds.length === 0 || s.excalidrawElementIds.length > MAX_SKETCH_ELEMENT_IDS) return false
  if (!s.excalidrawElementIds.every((id) => isCleanString(id, SKETCH_ELEMENT_ID_MAX) && id.length > 0)) return false
  return isValidRect(s.bboxPage)
}

function isValidStoredSketch(value: unknown): value is AnnotationSketch {
  if (!isValidSketchMeta(value)) return false
  const pngPath = (value as unknown as Record<string, unknown>).pngPath
  return pngPath === '' || (typeof pngPath === 'string' && PNG_PATH_RE.test(pngPath))
}

const ANNOTATION_STATES = new Set(['open', 'approved', 'reannotated', 'dismissed'])
const REVIEW_STATUSES = new Set(['draft', 'submitted', 'resolved'])
const ANNOTATION_SCOPES = new Set(['element', 'region', 'general'])

function isValidAnnotation(value: unknown): value is Annotation {
  if (typeof value !== 'object' || value === null) return false
  const a = value as Partial<Annotation> & Record<string, unknown>
  if (typeof a.id !== 'string' || !CANVAS_ANNOTATION_ID_RE.test(a.id)) return false
  if (typeof a.reviewId !== 'string' || !CANVAS_REVIEW_ID_RE.test(a.reviewId)) return false
  if (typeof a.scope !== 'string' || !ANNOTATION_SCOPES.has(a.scope)) return false
  if (!isCleanNote(a.note)) return false
  if (typeof a.versionId !== 'string' || !CANVAS_VERSION_ID_RE.test(a.versionId)) return false
  if (typeof a.state !== 'string' || !ANNOTATION_STATES.has(a.state)) return false
  if (a.scope === 'general') {
    if (a.focus !== undefined) return false
  } else if (!isValidFocus(a.focus)) return false
  if (a.sketch !== undefined && !isValidStoredSketch(a.sketch)) return false
  if (a.supersededBy !== undefined && (typeof a.supersededBy !== 'string' || !CANVAS_ANNOTATION_ID_RE.test(a.supersededBy))) return false
  return true
}

function isValidReview(value: unknown, canvasId: string, sessionId: string): value is Review {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Partial<Review> & Record<string, unknown>
  if (typeof r.id !== 'string' || !CANVAS_REVIEW_ID_RE.test(r.id)) return false
  if (typeof r.status !== 'string' || !REVIEW_STATUSES.has(r.status)) return false
  if (typeof r.versionId !== 'string' || !CANVAS_VERSION_ID_RE.test(r.versionId)) return false
  if (!Array.isArray(r.annotationIds) || r.annotationIds.length > MAX_ANNOTATIONS_PER_REVIEW) return false
  if (!r.annotationIds.every((id) => typeof id === 'string' && CANVAS_ANNOTATION_ID_RE.test(id))) return false
  if (typeof r.createdAt !== 'string') return false
  const canvas = r.canvas as Record<string, unknown> | undefined
  return !!canvas && canvas.canvasId === canvasId && canvas.sessionId === sessionId
}

function isValidRecord(value: unknown, canvasId: string): value is ReviewFileRecord {
  if (typeof value !== 'object' || value === null) return false
  const rec = value as Partial<ReviewFileRecord>
  if (rec.canvasId !== canvasId) return false
  if (typeof rec.sessionId !== 'string' || !SESSION_ID_RE.test(rec.sessionId)) return false
  if (!Number.isInteger(rec.nextReview) || (rec.nextReview as number) < 1) return false
  if (!Number.isInteger(rec.nextAnnotation) || (rec.nextAnnotation as number) < 1) return false
  if (!Array.isArray(rec.reviews) || rec.reviews.length > MAX_REVIEWS_PER_CANVAS) return false
  if (!Array.isArray(rec.annotations)) return false
  if (!rec.reviews.every((r) => isValidReview(r, canvasId, rec.sessionId as string))) return false
  if (!rec.annotations.every(isValidAnnotation)) return false
  // At most one draft, and every annotation belongs to a review that exists.
  const drafts = rec.reviews.filter((r) => r.status === 'draft')
  if (drafts.length > 1) return false
  const reviewIds = new Set(rec.reviews.map((r) => r.id))
  return rec.annotations.every((a) => reviewIds.has(a.reviewId))
}

// ── Load / access ───────────────────────────────────────────────────────────

/** The record re-stamped onto a new owner session — every review's embedded
 *  handle moves with it, so the strict validation stays satisfiable. */
function reboundRecord(record: ReviewFileRecord, sessionId: string): ReviewFileRecord {
  return {
    ...record,
    sessionId,
    reviews: record.reviews.map((r) => ({
      ...r,
      canvas: { ...r.canvas, sessionId },
      annotationIds: [...r.annotationIds],
    })),
    annotations: record.annotations.map(cloneAnnotation),
  }
}

function loadRecord(canvasId: string, sessionId: string): ReviewFileRecord | null {
  const existing = records.get(canvasId)
  if (existing) return existing
  if (broken.has(canvasId)) return null
  let raw: string
  try {
    raw = fs.readFileSync(reviewsJsonPath(canvasId), 'utf8')
  } catch {
    return null // no file yet — a fresh, healthy, empty store
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isValidRecord(parsed, canvasId)) {
      broken.add(canvasId)
      return null
    }
    let record: ReviewFileRecord = parsed
    if (record.sessionId !== sessionId) {
      // NOT corruption: the caller's sessionId came from the canvas record,
      // which is authoritative for ownership, and canvas adoption moves it
      // (canvas-session-link). An internally-valid file under a stale owner is
      // re-stamped — refusing it would mark every adopted canvas's reviews
      // broken. Real shape corruption still lands in `broken` above.
      record = reboundRecord(record, sessionId)
      try {
        persist(record)
      } catch {
        /* disk heal failed — the in-memory view is still correct, and the next
           successful mutation persists the re-bound record anyway */
      }
    }
    // Heal counters upward if skewed; ids must never repeat.
    const maxReview = record.reviews.reduce((max, r) => Math.max(max, Number(r.id.slice(1))), 0)
    const maxAnnotation = record.annotations.reduce((max, a) => Math.max(max, Number(a.id.slice(1))), 0)
    record.nextReview = Math.max(record.nextReview, maxReview + 1)
    record.nextAnnotation = Math.max(record.nextAnnotation, maxAnnotation + 1)
    records.set(canvasId, record)
    return record
  } catch {
    broken.add(canvasId)
    return null
  }
}

/**
 * Move a canvas's review store to a new owner session (canvas adoption,
 * 2026-08-14). reviews.json embeds the owner session id at the record level
 * and inside every review's canvas handle; after the canvas record re-binds,
 * this brings the review side into agreement. Loading under the new session
 * would self-heal anyway (above) — calling this at adoption time makes the
 * move durable immediately and pushes the change event while the canvas one
 * is fresh. A broken store stays broken: preserved evidence is never touched.
 */
export function rebindReviewsToSession(canvasId: string, sessionId: string): void {
  if (!SESSION_ID_RE.test(sessionId)) return
  if (broken.has(canvasId)) return
  const record = loadRecord(canvasId, sessionId)
  if (!record) return
  if (record.sessionId === sessionId) {
    // loadRecord already healed the file on this call (or it always matched);
    // either way the maps and disk agree — just let listeners know.
    emitChanged(record)
    return
  }
  commit(reboundRecord(record, sessionId))
}

interface SessionCanvas {
  canvasId: string
  activeVersionId: string | null
  versionIds: Set<string>
}

function canvasForSession(sessionId: string): SessionCanvas | null {
  if (!SESSION_ID_RE.test(sessionId)) return null
  const state = getCanvasStateForSession(sessionId)
  if (!state) return null
  return {
    canvasId: state.canvasId,
    activeVersionId: state.activeVersionId,
    versionIds: new Set(state.versions.map((v) => v.id)),
  }
}

function requireHealthy(canvasId: string): void {
  if (broken.has(canvasId)) {
    throw new Error('review store unreadable: reviews.json exists but does not validate; not overwriting it')
  }
}

function recordFor(sessionId: string, canvas: SessionCanvas): ReviewFileRecord {
  return (
    loadRecord(canvas.canvasId, sessionId) ?? {
      canvasId: canvas.canvasId,
      sessionId,
      nextReview: 1,
      nextAnnotation: 1,
      reviews: [],
      annotations: [],
    }
  )
}

/** Deep-ish copy so callers can never mutate the committed record. */
function toState(record: ReviewFileRecord): CanvasReviewState {
  return {
    canvasId: record.canvasId,
    sessionId: record.sessionId,
    reviews: record.reviews.map((r) => ({ ...r, canvas: { ...r.canvas }, annotationIds: [...r.annotationIds] })),
    annotations: record.annotations.map(cloneAnnotation),
  }
}

function cloneAnnotation(a: Annotation): Annotation {
  return {
    ...a,
    ...(a.focus
      ? { focus: { ...a.focus, targets: a.focus.targets.map((t) => ({ ...t })), bboxPage: { ...a.focus.bboxPage } } }
      : {}),
    ...(a.sketch ? { sketch: { ...a.sketch, excalidrawElementIds: [...a.sketch.excalidrawElementIds], bboxPage: { ...a.sketch.bboxPage } } } : {}),
  }
}

export function getReviewStateForSession(sessionId: string): CanvasReviewState | null {
  const canvas = canvasForSession(sessionId)
  if (!canvas) return null
  if (broken.has(canvas.canvasId)) {
    return { canvasId: canvas.canvasId, sessionId, reviews: [], annotations: [] }
  }
  const record = loadRecord(canvas.canvasId, sessionId)
  if (!record) return { canvasId: canvas.canvasId, sessionId, reviews: [], annotations: [] }
  return toState(record)
}

// ── Mutations ───────────────────────────────────────────────────────────────

function commit(record: ReviewFileRecord): void {
  persist(record)
  records.set(record.canvasId, record)
  emitChanged(record)
}

function draftReviewOf(record: ReviewFileRecord): Review | null {
  return record.reviews.find((r) => r.status === 'draft') ?? null
}

/** Validate a renderer-supplied draft against this canvas. Throws on anything
 *  out of shape — the IPC schema should have caught it, so a throw here is a
 *  bug surfacing, not a user error. */
function validateDraft(draft: CanvasAnnotationDraft, canvas: SessionCanvas): void {
  if (typeof draft !== 'object' || draft === null) throw new Error('invalid draft')
  if (!ANNOTATION_SCOPES.has(draft.scope)) throw new Error('invalid draft scope')
  if (!isCleanNote(draft.note)) throw new Error('invalid draft note')
  if (typeof draft.versionId !== 'string' || !canvas.versionIds.has(draft.versionId)) throw new Error('draft names an unknown version')
  if (draft.scope === 'general') {
    if (draft.focus !== undefined) throw new Error('a general note carries no focus')
  } else {
    if (!isValidFocus(draft.focus)) throw new Error('invalid draft focus')
    if (draft.scope === 'element' && draft.focus.targets.length === 0) throw new Error('an element note needs at least one anchor')
  }
  if (draft.sketch !== undefined && !isValidSketchMeta(draft.sketch)) throw new Error('invalid draft sketch')
}

/**
 * Create or update a note in the session's draft review, creating the draft
 * review itself on the first note. Returns the committed state plus the id of
 * the note touched (the renderer needs it to keep editing).
 */
export function upsertAnnotation(
  sessionId: string,
  draft: CanvasAnnotationDraft,
): { state: CanvasReviewState; annotationId: string } {
  const canvas = canvasForSession(sessionId)
  if (!canvas) throw new Error('no canvas for session')
  requireHealthy(canvas.canvasId)
  validateDraft(draft, canvas)

  const base = recordFor(sessionId, canvas)
  const next: ReviewFileRecord = {
    ...base,
    reviews: base.reviews.map((r) => ({ ...r, annotationIds: [...r.annotationIds] })),
    annotations: base.annotations.map(cloneAnnotation),
  }

  let review = draftReviewOf(next)
  let annotationId: string

  if (draft.annotationId !== undefined) {
    if (typeof draft.annotationId !== 'string' || !CANVAS_ANNOTATION_ID_RE.test(draft.annotationId)) throw new Error('invalid annotation id')
    const existing = next.annotations.find((a) => a.id === draft.annotationId)
    if (!existing) throw new Error('unknown annotation')
    const owner = next.reviews.find((r) => r.id === existing.reviewId)
    if (!owner || owner.status !== 'draft') throw new Error('only a draft note can be edited')
    annotationId = existing.id
    existing.scope = draft.scope
    existing.note = draft.note
    existing.versionId = draft.versionId
    if (draft.scope === 'general') delete existing.focus
    else existing.focus = draft.focus
    if (draft.sketch) existing.sketch = { ...draft.sketch, pngPath: '' }
    else delete existing.sketch
  } else {
    if (!review) {
      if (next.reviews.length >= MAX_REVIEWS_PER_CANVAS) throw new Error('review cap reached for this canvas')
      review = {
        id: `R${next.nextReview}`,
        canvas: { sessionId, canvasId: canvas.canvasId },
        // Provisional until submit freezes it against the version on screen.
        versionId: draft.versionId,
        annotationIds: [],
        status: 'draft',
        createdAt: new Date().toISOString(),
      }
      next.nextReview += 1
      next.reviews.push(review)
    }
    if (review.annotationIds.length >= MAX_ANNOTATIONS_PER_REVIEW) throw new Error('note cap reached for this review')
    annotationId = `a${next.nextAnnotation}`
    next.nextAnnotation += 1
    const annotation: Annotation = {
      id: annotationId,
      reviewId: review.id,
      scope: draft.scope,
      note: draft.note,
      versionId: draft.versionId,
      state: 'open',
      ...(draft.scope !== 'general' && draft.focus ? { focus: draft.focus } : {}),
      ...(draft.sketch ? { sketch: { ...draft.sketch, pngPath: '' } } : {}),
    }
    next.annotations.push(annotation)
    review.annotationIds.push(annotationId)
  }

  commit(next)
  return { state: toState(next), annotationId }
}

export function deleteAnnotation(sessionId: string, annotationId: string): CanvasReviewState {
  const canvas = canvasForSession(sessionId)
  if (!canvas) throw new Error('no canvas for session')
  requireHealthy(canvas.canvasId)
  if (typeof annotationId !== 'string' || !CANVAS_ANNOTATION_ID_RE.test(annotationId)) throw new Error('invalid annotation id')

  const base = recordFor(sessionId, canvas)
  const target = base.annotations.find((a) => a.id === annotationId)
  if (!target) throw new Error('unknown annotation')
  const owner = base.reviews.find((r) => r.id === target.reviewId)
  if (!owner || owner.status !== 'draft') throw new Error('only a draft note can be deleted')

  const next: ReviewFileRecord = {
    ...base,
    annotations: base.annotations.filter((a) => a.id !== annotationId).map(cloneAnnotation),
    reviews: base.reviews
      .map((r) => ({ ...r, annotationIds: r.annotationIds.filter((id) => id !== annotationId) }))
      // A draft emptied of its last note disappears; its number is not reused.
      .filter((r) => r.status !== 'draft' || r.annotationIds.length > 0),
  }
  commit(next)
  return toState(next)
}

/** PNG magic: the eight bytes every real PNG starts with. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function decodeSketchPng(pngBase64: string): Buffer {
  if (typeof pngBase64 !== 'string' || pngBase64.length === 0) throw new Error('invalid sketch png')
  const bytes = Buffer.from(pngBase64, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_SKETCH_PNG_BYTES) throw new Error('sketch png too large')
  if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) throw new Error('sketch is not a png')
  return bytes
}

/**
 * Freeze the draft review (spec §6 step 4): every sketch-carrying note gets its
 * exported PNG written, the review flips to 'submitted' against the version on
 * screen, and only then does memory move. A missing or invalid export refuses
 * the whole submit — silently dropping a sketch the user attached would hand
 * the agent a review that is quietly less than what was written.
 */
export function submitReview(sessionId: string, reviewId: string, sketches: CanvasSketchExport[]): CanvasReviewState {
  const canvas = canvasForSession(sessionId)
  if (!canvas) throw new Error('no canvas for session')
  requireHealthy(canvas.canvasId)
  if (typeof reviewId !== 'string' || !CANVAS_REVIEW_ID_RE.test(reviewId)) throw new Error('invalid review id')
  if (!Array.isArray(sketches)) throw new Error('invalid sketches')

  const base = recordFor(sessionId, canvas)
  const review = base.reviews.find((r) => r.id === reviewId)
  if (!review || review.status !== 'draft') throw new Error('no such draft review')
  if (review.annotationIds.length === 0) throw new Error('a review needs at least one note')
  if (!canvas.activeVersionId) throw new Error('no active version to submit against')

  const exportsById = new Map<string, string>()
  for (const sketch of sketches) {
    if (typeof sketch !== 'object' || sketch === null) throw new Error('invalid sketch export')
    if (typeof sketch.annotationId !== 'string' || !CANVAS_ANNOTATION_ID_RE.test(sketch.annotationId)) throw new Error('invalid sketch export')
    if (exportsById.has(sketch.annotationId)) throw new Error('duplicate sketch export')
    exportsById.set(sketch.annotationId, sketch.pngBase64)
  }

  const next: ReviewFileRecord = {
    ...base,
    reviews: base.reviews.map((r) => ({ ...r, annotationIds: [...r.annotationIds] })),
    annotations: base.annotations.map(cloneAnnotation),
  }
  const nextReview = next.reviews.find((r) => r.id === reviewId)!
  const members = new Set(nextReview.annotationIds)

  // Pair exports with sketch-carrying notes, both directions: an export for a
  // note without a sketch (or outside this review) is refused, not ignored.
  const pngWrites: Array<{ absPath: string; bytes: Buffer }> = []
  for (const annotation of next.annotations) {
    if (!members.has(annotation.id)) continue
    if (!annotation.sketch) {
      if (exportsById.has(annotation.id)) throw new Error('sketch export for a note without a sketch')
      continue
    }
    const pngBase64 = exportsById.get(annotation.id)
    if (pngBase64 === undefined) throw new Error(`sketch export missing for note ${annotation.id}`)
    exportsById.delete(annotation.id)
    const bytes = decodeSketchPng(pngBase64)
    const relPath = `reviews/${reviewId}/${annotation.id}.png`
    annotation.sketch.pngPath = relPath
    pngWrites.push({ absPath: path.join(canvasDir(canvas.canvasId), 'reviews', reviewId, `${annotation.id}.png`), bytes })
  }
  if (exportsById.size > 0) throw new Error('sketch export for a note not in this review')

  nextReview.status = 'submitted'
  nextReview.submittedAt = new Date().toISOString()
  // D12: the review freezes against the version the user was looking at.
  nextReview.versionId = canvas.activeVersionId

  // PNGs first, record second, memory last. A failure anywhere leaves the
  // draft intact in memory and on disk; at worst orphaned PNG files that no
  // record references.
  if (pngWrites.length > 0) {
    mkdirSecure(path.join(canvasDir(canvas.canvasId), 'reviews', reviewId))
    for (const write of pngWrites) atomicWriteSecure(write.absPath, write.bytes)
  }
  commit(next)
  return toState(next)
}

export type ResolveAction = 'approve' | 'dismiss' | 'reannotate'

/**
 * The user's verdict on one open note of a submitted review (spec §6 step 2).
 * 'reannotate' mints the replacement draft note (pre-linked via supersededBy)
 * in the current draft review, creating that review if none is open. When a
 * submitted review runs out of open notes it becomes 'resolved'.
 */
export function resolveAnnotation(
  sessionId: string,
  annotationId: string,
  action: ResolveAction,
): { state: CanvasReviewState; reannotationId?: string } {
  const canvas = canvasForSession(sessionId)
  if (!canvas) throw new Error('no canvas for session')
  requireHealthy(canvas.canvasId)
  if (typeof annotationId !== 'string' || !CANVAS_ANNOTATION_ID_RE.test(annotationId)) throw new Error('invalid annotation id')
  if (action !== 'approve' && action !== 'dismiss' && action !== 'reannotate') throw new Error('invalid action')

  const base = recordFor(sessionId, canvas)
  const target = base.annotations.find((a) => a.id === annotationId)
  if (!target) throw new Error('unknown annotation')
  if (target.state !== 'open') throw new Error('only an open note can be resolved')
  const owner = base.reviews.find((r) => r.id === target.reviewId)
  if (!owner || owner.status === 'draft') throw new Error('only a submitted note can be resolved')

  const next: ReviewFileRecord = {
    ...base,
    reviews: base.reviews.map((r) => ({ ...r, annotationIds: [...r.annotationIds] })),
    annotations: base.annotations.map(cloneAnnotation),
  }
  const nextTarget = next.annotations.find((a) => a.id === annotationId)!
  let reannotationId: string | undefined

  if (action === 'approve') {
    nextTarget.state = 'approved'
  } else if (action === 'dismiss') {
    nextTarget.state = 'dismissed'
  } else {
    if (!canvas.activeVersionId) throw new Error('no active version to re-annotate against')
    let draft = draftReviewOf(next)
    if (!draft) {
      if (next.reviews.length >= MAX_REVIEWS_PER_CANVAS) throw new Error('review cap reached for this canvas')
      draft = {
        id: `R${next.nextReview}`,
        canvas: { sessionId, canvasId: canvas.canvasId },
        versionId: canvas.activeVersionId,
        annotationIds: [],
        status: 'draft',
        createdAt: new Date().toISOString(),
      }
      next.nextReview += 1
      next.reviews.push(draft)
    }
    if (draft.annotationIds.length >= MAX_ANNOTATIONS_PER_REVIEW) throw new Error('note cap reached for this review')
    reannotationId = `a${next.nextAnnotation}`
    next.nextAnnotation += 1
    const replacement: Annotation = {
      id: reannotationId,
      reviewId: draft.id,
      scope: nextTarget.scope,
      // The old wording carries over as the starting point for the new one.
      note: nextTarget.note,
      versionId: canvas.activeVersionId,
      state: 'open',
      // The focus carries over so the new note points where the old one did;
      // the sketch does not — its glass elements belong to the old turn.
      ...(nextTarget.focus ? { focus: cloneAnnotation(nextTarget).focus } : {}),
    }
    next.annotations.push(replacement)
    draft.annotationIds.push(reannotationId)
    nextTarget.state = 'reannotated'
    nextTarget.supersededBy = reannotationId
  }

  const nextOwner = next.reviews.find((r) => r.id === owner.id)!
  const stillOpen = next.annotations.some((a) => a.reviewId === nextOwner.id && a.state === 'open')
  if (!stillOpen && nextOwner.status === 'submitted') nextOwner.status = 'resolved'

  commit(next)
  return { state: toState(next), ...(reannotationId ? { reannotationId } : {}) }
}

// ── The MCP read (canvas_review) ────────────────────────────────────────────

export interface ReviewPayloadResult {
  payload: ReviewPayload
  /** Absolute PNG paths, 1:1 with payload.attachments. Resolved HERE from the
   *  validated relative paths so the tool never joins paths itself. */
  attachmentFiles: Array<{ annotationId: string; absPath: string }>
  /** Ids of every submitted (fetchable) review, for the tool's own messaging. */
  submittedReviewIds: string[]
}

/** Everything the canvas_review tool needs, or a throw whose message the tool
 *  maps to an operator-authored refusal. Draft reviews are not fetchable (D10). */
export function getReviewPayload(sessionId: string, reviewId: string): ReviewPayloadResult {
  const canvas = canvasForSession(sessionId)
  if (!canvas) throw new Error('no canvas for session')
  requireHealthy(canvas.canvasId)
  if (typeof reviewId !== 'string' || !CANVAS_REVIEW_ID_RE.test(reviewId)) throw new Error('invalid review id')

  const record = loadRecord(canvas.canvasId, sessionId)
  const submittedReviewIds = record ? record.reviews.filter((r) => r.status !== 'draft').map((r) => r.id) : []
  const review = record?.reviews.find((r) => r.id === reviewId)
  if (!record || !review) {
    const err = new Error('unknown review') as Error & { submittedReviewIds?: string[] }
    err.submittedReviewIds = submittedReviewIds
    throw err
  }
  if (review.status === 'draft') throw new Error('review is a draft')

  const members = new Set(review.annotationIds)
  const all = record.annotations.filter((a) => members.has(a.id)).map(cloneAnnotation)
  const generalNotes = all.filter((a) => a.scope === 'general')
  const anchored = all.filter((a) => a.scope !== 'general')
  const attachments = all
    .filter((a) => a.sketch && a.sketch.pngPath !== '')
    .map((a) => ({ annotationId: a.id, pngPath: a.sketch!.pngPath }))

  return {
    payload: {
      review: { ...review, canvas: { ...review.canvas }, annotationIds: [...review.annotationIds] },
      annotations: anchored,
      generalNotes,
      attachments,
      envelope: 'untrusted-content',
    },
    attachmentFiles: attachments.map((att) => ({
      annotationId: att.annotationId,
      absPath: path.join(canvasDir(canvas.canvasId), att.pngPath),
    })),
    submittedReviewIds,
  }
}

/**
 * Forget everything held for one canvas, because that canvas has been deleted.
 *
 * `reviews.json` lives inside the canvas directory, so deleting the canvas
 * already takes the file with it. These two maps are what would otherwise
 * outlive it: a `records` entry can hold hundreds of reviews with their
 * annotations, and nothing would ever evict it — canvas ids are random, so no
 * later canvas reaches the stale entry. Purely a memory concern, but an
 * unbounded one for a long-running app that renders, reviews and deletes.
 */
export function dropReviewsForCanvas(canvasId: string): void {
  records.delete(canvasId)
  broken.delete(canvasId)
}

/** Test seam: drop all in-memory state so each test starts cold. */
export function _resetCanvasReviewStoreForTest(): void {
  records.clear()
  broken.clear()
}
