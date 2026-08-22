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
  CANVAS_ID_RE,
  CANVAS_REVIEW_ID_RE,
  CANVAS_VERSION_ID_RE,
  type AgentCloseVerdict,
  type AnchorRef,
  type Annotation,
  type AnnotationSketch,
  type AnnotationState,
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
import { logInfo } from '../debug-logger'
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
/** Ceiling on a reviews.json the COUNT path will read (see readRecordNoRebind).
 *  Generous next to any real record — a few hundred notes of prose — and well
 *  under what the per-field maxima would permit if every one were at its bound. */
const MAX_REVIEW_FILE_BYTES = 8 * 1024 * 1024

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

const ANNOTATION_STATES = new Set(['open', 'addressed', 'approved', 'reannotated', 'dismissed', 'stale'])
const REVIEW_STATUSES = new Set(['draft', 'submitted', 'resolved'])
const ANNOTATION_SCOPES = new Set(['element', 'region', 'general'])
/** States a note can be REOPENED from: the three terminal verdicts. Not
 *  'reannotated' — that one already has a live successor note, and reopening it
 *  would leave two notes claiming the same issue. */
const REOPENABLE_STATES = new Set(['approved', 'dismissed', 'stale'])
const CLOSED_BY_VALUES = new Set(['user', 'agent'])
const CLOSED_FROM_VALUES = new Set(['open', 'addressed'])
/**
 * Verdict → the state it writes.
 *
 * A Map, not an object literal, and for the reason SEVERITY_RANK in
 * shared/canvas.ts is one: the key arrives from a model-generated tool call, and
 * an object literal answers `VERDICT_STATE['constructor']` with a function
 * rather than undefined. There is no key on this Map that yields 'approved' —
 * which is the property the never-approve rule actually rests on.
 */
const VERDICT_STATE: ReadonlyMap<string, AnnotationState> = new Map([
  ['stale', 'stale'],
  ['dismissed', 'dismissed'],
])

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
  // Close-out provenance. Validated even though this store is the only writer,
  // for the same reason pngPath is: a hand-edited record must not be able to
  // present an agent-set closure as the user's, which is the one claim on the
  // row a person is being asked to trust.
  if (a.closedBy !== undefined && (typeof a.closedBy !== 'string' || !CLOSED_BY_VALUES.has(a.closedBy))) return false
  if (a.closedFrom !== undefined && (typeof a.closedFrom !== 'string' || !CLOSED_FROM_VALUES.has(a.closedFrom))) return false
  // A timestamp the close-out barrier reads. Bounded and clean like every other
  // stored string; a value that is present but does not PARSE is treated by the
  // barrier as "just now", i.e. it refuses the close — the fail-closed
  // direction, since the barrier exists to withhold permission.
  if (a.addressedAt !== undefined && !isCleanString(a.addressedAt, 64)) return false
  // 'approved' is the user's alone, so a record claiming the agent set it is
  // corrupt by definition — refuse it rather than render it.
  if (a.state === 'approved' && a.closedBy === 'agent') return false
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
  if (!rec.annotations.every((a) => reviewIds.has(a.reviewId))) return false

  /**
   * The two views of "which notes are on this review" must be THE SAME SET.
   *
   * A review lists its members (`annotationIds`) and every note names its owner
   * (`reviewId`), and nothing used to check that the two agreed. Every mutation
   * maintains both in lockstep, so drift is unreachable through the API — but
   * the code reads whichever is convenient, and a record where they disagree
   * makes the readers disagree too. A note absent from `R1.annotationIds` but
   * carrying `reviewId: 'R1'` is invisible to the scope rule (which counts
   * members, sees no open notes, and permits a close) and visible to
   * `settleReviewStatus` (which counts by `reviewId` and keeps R1 submitted),
   * leaving a round the agent has "closed" that never resolves.
   *
   * Checking it here makes the two provably equal for every record that loads,
   * which is what lets the readers stop caring which one they use. A record
   * that fails is BROKEN — preserved evidence, not free space.
   */
  const ownedByReview = new Map<string, Set<string>>()
  for (const a of rec.annotations) {
    const set = ownedByReview.get(a.reviewId)
    if (set) set.add(a.id)
    else ownedByReview.set(a.reviewId, new Set([a.id]))
  }
  for (const r of rec.reviews) {
    const listed = new Set(r.annotationIds)
    if (listed.size !== r.annotationIds.length) return false // a repeated member
    const owned = ownedByReview.get(r.id) ?? new Set<string>()
    if (listed.size !== owned.size) return false
    for (const id of listed) if (!owned.has(id)) return false
  }
  return true
}

// ── Load / access ───────────────────────────────────────────────────────────

/**
 * Heal skewed id counters upward. Ids must never repeat.
 *
 * Extracted because EVERY path that can reach `commit` has to run it, not just
 * `loadRecord`. `commit` writes the record into `records`, and every later
 * `loadRecord` short-circuits on that cached entry — so a record that entered
 * the cache without this repair keeps its skew for the life of the process. A
 * `reviews.json` whose `nextAnnotation` sits below `max(id) + 1` (hand-edited,
 * an older format, a torn write) would then mint a duplicate annotation id on
 * the very next note.
 */
function healCounters(record: ReviewFileRecord): void {
  const maxReview = record.reviews.reduce((max, r) => Math.max(max, Number(r.id.slice(1))), 0)
  const maxAnnotation = record.annotations.reduce((max, a) => Math.max(max, Number(a.id.slice(1))), 0)
  record.nextReview = Math.max(record.nextReview, maxReview + 1)
  record.nextAnnotation = Math.max(record.nextAnnotation, maxAnnotation + 1)
}

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
    healCounters(record)
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

/**
 * What is outstanding on ONE canvas, as counts and store-minted ids only.
 *
 * Keyed by canvasId, deliberately, not by session. Every session-keyed read
 * resolves through `canvasForSession` -> `sessionIndex`, which after a FILING
 * already points at the new canvas — and the canvas we most need to report on
 * is the one that was just filed out from under the user's open notes.
 *
 * READ-ONLY, and that is load-bearing: `loadRecord` re-stamps and PERSISTS a
 * record whose embedded owner differs from the session it was asked for. A
 * report must never write, so this reads the file itself and shares only the
 * validator, which checks internal self-consistency and nothing about ownership.
 *
 * Returns `null` — never zeroes — when the store is broken or unreadable. "No
 * open notes" and "I could not tell" are different messages, and only one of
 * them should ever reassure an agent.
 */
export interface CanvasReviewCounts {
  /** Notes in the user's unsubmitted draft: work in progress, not yours yet. */
  draftNotes: number
  /** Versions those draft notes were written against, store-minted 'v<n>'. */
  draftVersionIds: string[]
  /** Submitted reviews with notes still in play, store-minted 'R<n>'. */
  openReviewIds: string[]
  /** Notes on submitted reviews awaiting the AGENT (state 'open'). Kept apart
   *  from 'addressed', which awaits the USER — summing them would produce a
   *  number neither party can act on. */
  openNotes: number
  /** Notes the agent has marked addressed and the user has not ruled on. */
  addressedNotes: number
  /**
   * What a bulk close-out on this canvas would ACTUALLY clear.
   *
   * Not the same as `addressedNotes`, and the difference is a real bug that
   * shipped in the first cut of this feature: `closeOutCanvasReviews` skips a
   * whole review that still holds an `open` note, so on the routine partial
   * round (one note handled, one not) `addressedNotes` is 1 while the close-out
   * clears 0 — a button that promised "Close 1 note", did nothing, and never
   * went away because the number it was drawn from never moved.
   *
   * So the count is computed with the SAME per-review gate the mutation
   * applies. The label and the mutation share one rule, which is the property
   * the panel already had via `roundsWaitingOnYou` and the library did not.
   */
  closeableNotes: number
}

export function getReviewCountsForCanvas(canvasId: string): CanvasReviewCounts | null {
  if (!CANVAS_ID_RE.test(canvasId)) return null
  if (broken.has(canvasId)) return null
  const record = records.get(canvasId) ?? readRecordNoRebind(canvasId)
  if (!record) return null

  const draftIds = new Set(record.reviews.filter((r) => r.status === 'draft').flatMap((r) => r.annotationIds))
  const openReviewIds: string[] = []
  const submitted = new Set<string>()
  for (const r of record.reviews) {
    if (r.status === 'submitted') submitted.add(r.id)
  }
  let openNotes = 0
  let addressedNotes = 0
  const withOpenNotes = new Set<string>()
  const draftVersions = new Set<string>()
  // Per review, so the closeable count below can apply the mutation's own gate.
  const openByReview = new Map<string, number>()
  const addressedByReview = new Map<string, number>()
  for (const a of record.annotations) {
    if (draftIds.has(a.id)) {
      draftVersions.add(a.versionId)
      continue
    }
    if (!submitted.has(a.reviewId)) continue
    if (a.state === 'open') {
      openNotes++
      withOpenNotes.add(a.reviewId)
      openByReview.set(a.reviewId, (openByReview.get(a.reviewId) ?? 0) + 1)
    } else if (a.state === 'addressed') {
      addressedNotes++
      withOpenNotes.add(a.reviewId)
      addressedByReview.set(a.reviewId, (addressedByReview.get(a.reviewId) ?? 0) + 1)
    }
  }
  // The close-out's own rule, restated over the same tallies: a submitted
  // review with zero open notes contributes all of its addressed ones; a review
  // still holding an open note contributes NOTHING, because the mutation skips
  // it whole. Read by `a.reviewId` rather than membership, which the validator
  // now proves is the same set.
  let closeableNotes = 0
  for (const r of record.reviews) {
    if (r.status !== 'submitted') continue
    if (withOpenNotes.has(r.id)) openReviewIds.push(r.id)
    if ((openByReview.get(r.id) ?? 0) > 0) continue
    closeableNotes += addressedByReview.get(r.id) ?? 0
  }
  return {
    draftNotes: draftIds.size,
    draftVersionIds: [...draftVersions],
    openReviewIds,
    openNotes,
    addressedNotes,
    closeableNotes,
  }
}

/** Read + validate reviews.json WITHOUT loadRecord's owner re-stamp, its disk
 *  heal, or its counter repair. Nothing here is cached either: a reporting read
 *  must not warm a cache that only `dropReviewsForCanvas` ever evicts. */
function readRecordNoRebind(canvasId: string): ReviewFileRecord | null {
  let raw: string
  try {
    const file = reviewsJsonPath(canvasId)
    // Size first, because this runs on the main thread once PER CANVAS every
    // time the library opens, and a session's own canvases are swept without
    // the MAX_REVIEW_SWEEP bound. A legal record is kilobytes; the format's own
    // maxima (200 reviews × 100 notes × 4000 chars) allow tens of megabytes, and
    // whatever else happens to be sitting at that path allows anything at all.
    // Refusing to read it is the same outcome as failing to parse it: no counts.
    const size = fs.statSync(file).size
    if (size > MAX_REVIEW_FILE_BYTES) {
      // Say so. A silent refusal leaves the counts simply absent on both
      // surfaces — the library row and the agent's "notes waiting" line — for a
      // canvas whose notes still open perfectly well when you click into it.
      logInfo(`[canvas-reviews] counts skipped for ${canvasId}: reviews.json is ${size} bytes`)
      return null
    }
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isValidRecord(parsed, canvasId)) return null
    return parsed
  } catch {
    return null
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

/**
 * A note is LIVE while it is waiting on somebody: 'open' waits on the agent,
 * 'addressed' waits on the user. Every other state is a verdict already given.
 *
 * One predicate, named once, because close-out adds a third way for a review to
 * run out of live notes and every one of them has to agree with the counts the
 * pill is drawn from (`getReviewCountsForCanvas`, which uses the same pair).
 */
function isLiveNote(a: Annotation): boolean {
  return a.state === 'open' || a.state === 'addressed'
}

/**
 * The notes on one review — ONE definition, used by every close-out path.
 *
 * The record holds the membership twice (`review.annotationIds` and each note's
 * `reviewId`) and the file used to read whichever was nearer. `isValidRecord`
 * now proves the two are the same set for any record that loads, so this reads
 * both and the intersection is exactly either one; requiring both means a
 * record that somehow reached memory with drift narrows the set rather than
 * widening it, which is the safe direction for a function that decides what may
 * be closed.
 */
function notesOfReview(record: ReviewFileRecord, review: Review): Annotation[] {
  const members = new Set(review.annotationIds)
  return record.annotations.filter((a) => a.reviewId === review.id && members.has(a.id))
}

/**
 * How long a note must have been `addressed` before the AGENT may close it.
 *
 * The scope rule ("every note on this round is addressed") is a precondition
 * the agent writes itself: `canvas_resolve` moves notes open -> addressed with
 * no user involvement, so an agent can call resolve and then verdict back to
 * back, satisfy the rule, and take the round off the pill without the user ever
 * being asked. Nothing in the store can see the chat instruction that is
 * supposed to authorise the close, so nothing in the store can verify it.
 *
 * What the store CAN see is the shape of that chain: the legitimate flow has a
 * human in it — the agent finishes, hands back, the user reads the summary and
 * says "close them" — and that turnaround is never instant. The mechanical
 * chain is. A dwell time does not make the close authorised, but it does stop
 * the unattended one-pass version, and it costs the real flow nothing.
 *
 * Deliberately generous. Erring long fails toward "the user closes it in the
 * pane in one click", which is a working path, rather than toward an agent
 * clearing a round nobody looked at.
 */
export const MIN_ADDRESSED_DWELL_MS = 60_000

/** Milliseconds since a note was addressed. `null` when it carries no stamp
 *  (a record written before the stamp existed); 0 when the stamp is unreadable,
 *  which refuses the close. */
function addressedAgeMs(a: Annotation, now: number): number | null {
  if (a.addressedAt === undefined) return null
  const at = Date.parse(a.addressedAt)
  if (!Number.isFinite(at)) return 0
  return Math.max(0, now - at)
}

/**
 * Re-derive one review's status from its notes, BOTH directions.
 *
 * Forward: a submitted review with no live notes left is 'resolved'. That half
 * is what `resolveAnnotation` has always done inline, and it is unchanged.
 *
 * Backward: a resolved review that has a live note again is 'submitted'. That
 * half is new, and it is what makes Reopen honest — without it a reopened note
 * would sit on a review still marked resolved, so the pill would not come back
 * and the round would be invisible in every list that keys off 'submitted'.
 *
 * A DRAFT is never touched: it has no verdicts on it and its status is the
 * composer's, not this function's.
 */
function settleReviewStatus(record: ReviewFileRecord, reviewId: string): void {
  const review = record.reviews.find((r) => r.id === reviewId)
  if (!review || review.status === 'draft') return
  const live = record.annotations.some((a) => a.reviewId === review.id && isLiveNote(a))
  if (!live && review.status === 'submitted') review.status = 'resolved'
  else if (live && review.status === 'resolved') review.status = 'submitted'
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

export type ResolveAction = 'approve' | 'dismiss' | 'reannotate' | 'stale'

const RESOLVE_ACTIONS = new Set<string>(['approve', 'dismiss', 'reannotate', 'stale'])

/**
 * The user's verdict on one open note of a submitted review (spec §6 step 2).
 * 'reannotate' mints the replacement draft note (pre-linked via supersededBy)
 * in the current draft review, creating that review if none is open. When a
 * submitted review runs out of live notes it becomes 'resolved'.
 *
 * 'stale' is the close-out verdict: the work moved on, so the note is no longer
 * live. It is deliberately NOT 'approve' — the user is saying "this shipped",
 * not "I checked it and it is right" — and it is the same state the agent may
 * set through canvas_verdict, distinguished only by `closedBy`.
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
  if (typeof action !== 'string' || !RESOLVE_ACTIONS.has(action)) throw new Error('invalid action')

  const base = recordFor(sessionId, canvas)
  const target = base.annotations.find((a) => a.id === annotationId)
  if (!target) throw new Error('unknown annotation')
  // An ADDRESSED note is still the user's to resolve: "addressed" is the
  // agent saying it acted; approve / dismiss / re-annotate is the user's
  // verdict on whether that was right, and it must stay available.
  if (target.state !== 'open' && target.state !== 'addressed') throw new Error('only an open or addressed note can be resolved')
  const owner = base.reviews.find((r) => r.id === target.reviewId)
  if (!owner || owner.status === 'draft') throw new Error('only a submitted note can be resolved')

  const next: ReviewFileRecord = {
    ...base,
    reviews: base.reviews.map((r) => ({ ...r, annotationIds: [...r.annotationIds] })),
    annotations: base.annotations.map(cloneAnnotation),
  }
  const nextTarget = next.annotations.find((a) => a.id === annotationId)!
  let reannotationId: string | undefined

  // Where the note was when the user ruled on it, so Reopen can put it back
  // there. Captured before the state moves, and only for the terminal actions —
  // 're-annotate' keeps its own record through supersededBy.
  const closedFrom: 'open' | 'addressed' = nextTarget.state === 'addressed' ? 'addressed' : 'open'

  if (action === 'approve') {
    nextTarget.state = 'approved'
    nextTarget.closedBy = 'user'
    nextTarget.closedFrom = closedFrom
  } else if (action === 'dismiss') {
    nextTarget.state = 'dismissed'
    nextTarget.closedBy = 'user'
    nextTarget.closedFrom = closedFrom
  } else if (action === 'stale') {
    nextTarget.state = 'stale'
    nextTarget.closedBy = 'user'
    nextTarget.closedFrom = closedFrom
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

  // A review is done when nothing on it is left LIVE. Addressed notes still
  // hold it open: the agent has acted, but the user has not yet said whether
  // the action was right, and that verdict is what closes a review.
  settleReviewStatus(next, owner.id)

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
 * The agent marks notes it has acted on. The counterpart of `resolveAnnotation`
 * for the OTHER side of the loop: that one is the user's (approve / dismiss /
 * re-annotate, from the panel); this one is the agent's, reached through the
 * canvas_resolve MCP tool, and it can only ever say one thing — "addressed".
 *
 * Only OPEN notes on SUBMITTED reviews move; anything the user has already
 * resolved is left exactly as they left it, and a draft the user is still
 * writing is not the agent's to touch. Unknown ids are skipped rather than
 * fatal, so one stale id in a list does not stop the rest being marked.
 * Returns the ids actually moved, so the caller can say what happened.
 */
export function markAnnotationsAddressed(
  sessionId: string,
  reviewId: string,
  annotationIds: readonly string[],
): { state: CanvasReviewState; addressed: string[]; skipped: string[] } {
  const canvas = canvasForSession(sessionId)
  if (!canvas) throw new Error('no canvas for session')
  requireHealthy(canvas.canvasId)
  if (typeof reviewId !== 'string' || !CANVAS_REVIEW_ID_RE.test(reviewId)) throw new Error('invalid review id')
  const wanted = new Set<string>()
  for (const id of annotationIds) {
    if (typeof id === 'string' && CANVAS_ANNOTATION_ID_RE.test(id)) wanted.add(id)
  }
  const base = recordFor(sessionId, canvas)
  // Scoped to ONE review, and it has to be. Annotation ids restart per canvas
  // (a1, a2… on every one), and "the session's canvas" is mutable now that a
  // render naming a different subject files the current one: the skill has
  // the agent render and THEN resolve, so a title slip in that render pointed
  // this write at a different canvas whose a1/a2 happened to exist, marked
  // them addressed, and left the notes the agent actually handled open — the
  // very bug the tool exists to fix (adversarial review, 2026-08-19).
  //
  // What a review id does NOT do is name a canvas, which is what this comment
  // used to claim. Review ids restart at R1 on every canvas as well, so `R1`
  // is not a handle on one particular review -- it is a number resolved
  // against whichever canvas is active RIGHT NOW. The guard below is therefore
  // weaker than it reads: it refuses only when the number does not exist here,
  // and says nothing when it exists on both. What actually bounds the damage is
  // that the id can only ever resolve against the ACTIVE canvas, plus the
  // membership check on annotationIds below -- a resolve aimed at the wrong
  // canvas has to collide on the review number AND on the annotation ids to do
  // anything at all. Do not rely on the id to identify a canvas; if that is
  // ever needed, store the owning canvasId beside it.
  const review = base.reviews.find((r) => r.id === reviewId)
  if (!review) throw new Error('review not on this canvas')
  if (review.status === 'draft') throw new Error('review is still a draft')
  const members = new Set(review.annotationIds)
  const addressed: string[] = []
  const skipped: string[] = []
  const next: ReviewFileRecord = {
    ...base,
    reviews: base.reviews.map((r) => ({ ...r, annotationIds: [...r.annotationIds] })),
    annotations: base.annotations.map(cloneAnnotation),
  }
  for (const a of next.annotations) {
    if (!wanted.has(a.id)) continue
    if (a.state === 'open' && members.has(a.id)) {
      a.state = 'addressed'
      // When, so the agent's own close-out barrier can tell a round the user
      // has had a chance to see from one this same pass just manufactured.
      a.addressedAt = new Date().toISOString()
      addressed.push(a.id)
    } else {
      skipped.push(a.id)
    }
  }
  for (const id of wanted) if (!addressed.includes(id) && !skipped.includes(id)) skipped.push(id)
  if (addressed.length > 0) commit(next)
  return { state: toState(addressed.length > 0 ? next : base), addressed, skipped }
}

// ── Close-out (#365) ────────────────────────────────────────────────────────
//
// Three entry points, one rule: a note can be CLEARED but never deleted, and
// the record always says who cleared it. Approval is not reachable from any of
// them — `VERDICT_STATE` has no key that yields it, and the agent-facing
// function re-checks the verdict against that Map before it touches a record.

/** What one close-out call actually did. Ids only — the caller (an MCP tool
 *  reply, an IPC result) says the words. */
export interface CloseOutResult {
  state: CanvasReviewState
  /** Notes that moved, store-minted ids. */
  closed: string[]
  /** Ids asked for that did not move: unknown, not on this review, or already
   *  ruled on by the user in the meantime. */
  skipped: string[]
  /** True when this call was what emptied the review of live notes. */
  reviewClosed: boolean
}

/** An error carrying the numbers the caller needs to explain a refusal without
 *  re-reading the store. */
interface ScopeError extends Error {
  openNotes?: number
  addressedNotes?: number
  /** How many notes were addressed too recently to be closeable yet. */
  freshNotes?: number
}

function scopeError(message: string, counts: { openNotes: number; addressedNotes: number }): ScopeError {
  const err = new Error(message) as ScopeError
  err.openNotes = counts.openNotes
  err.addressedNotes = counts.addressedNotes
  return err
}

/**
 * The AGENT closes notes it was told to close (the `canvas_verdict` tool).
 *
 * The counterpart of `markAnnotationsAddressed`, one step further along: that
 * one says "I acted on this", this one says "you told me to close it". Both are
 * writes the agent makes into the user's review record, so both are narrow —
 * but this one is narrower, because it ENDS a note rather than advancing it.
 *
 * THE SCOPE RULE, and why it is here rather than in the tool: only a review
 * already WAITING ON THE USER may be closed this way — every remaining note on
 * it is 'addressed', meaning the agent has already claimed the work and the
 * only thing left is the user's verdict. A review with even one 'open' note is
 * refused whole. That is the difference between "the user told me to close the
 * round we finished" and an agent quietly deleting feedback it never acted on,
 * and it cannot be enforced in the tool layer alone: the tool's arguments are
 * model-generated, and a second caller (a future surface, a test, a refactor)
 * would inherit the hole. The store is the single mutation point; the rule
 * lives with the mutation.
 *
 * NEVER APPROVED. `verdict` is looked up in `VERDICT_STATE`, a Map with exactly
 * two keys, neither of which yields 'approved'. There is no argument, casing or
 * prototype key that reaches that state through this function.
 *
 * `annotationIds` null = the whole round. Named ids that are unknown, on
 * another review, or already ruled on are SKIPPED and reported rather than
 * fatal — the user may have clicked one themselves between the agent reading
 * the review and acting on it, and that should not fail the call.
 */
export function closeAnnotationsByAgent(
  sessionId: string,
  reviewId: string,
  annotationIds: readonly string[] | null,
  verdict: AgentCloseVerdict,
): CloseOutResult {
  const canvas = canvasForSession(sessionId)
  if (!canvas) throw new Error('no canvas for session')
  requireHealthy(canvas.canvasId)
  if (typeof reviewId !== 'string' || !CANVAS_REVIEW_ID_RE.test(reviewId)) throw new Error('invalid review id')
  // The never-approve gate, and the FIRST thing that happens: no record is
  // read, let alone written, for a verdict this function does not offer.
  const nextState = VERDICT_STATE.get(verdict as string)
  if (!nextState) throw new Error('invalid verdict')

  const base = recordFor(sessionId, canvas)
  const review = base.reviews.find((r) => r.id === reviewId)
  // Same caveat as markAnnotationsAddressed: a review id is an ordinal within
  // whichever canvas is active RIGHT NOW, not a handle on one particular
  // review. What bounds this is that it can only ever resolve against the
  // active canvas, plus the membership check below.
  if (!review) throw new Error('review not on this canvas')
  if (review.status === 'draft') throw new Error('review is still a draft')

  const members = new Set(review.annotationIds)
  const memberNotes = notesOfReview(base, review)
  const openNotes = memberNotes.filter((a) => a.state === 'open').length
  const addressedNotes = memberNotes.filter((a) => a.state === 'addressed').length

  // Waiting on the AGENT: not the agent's to close, whatever it was told.
  if (openNotes > 0) throw scopeError('review is still with the agent', { openNotes, addressedNotes })
  // Nothing to do, and saying so beats reporting a successful close of zero.
  if (addressedNotes === 0) throw scopeError('review has nothing waiting on the user', { openNotes, addressedNotes })

  // The chaining barrier. The scope rule above is satisfied by the agent's OWN
  // write (canvas_resolve), so on its own it does not distinguish "the user
  // told me to close the round we finished" from "I marked everything
  // addressed a moment ago and am now removing it from the pill". A note the
  // agent addressed seconds ago cannot have been seen, let alone ruled on, by
  // anybody — so it is not closeable yet, and the refusal says to hand back.
  const now = Date.now()
  const tooFresh = memberNotes.filter((a) => {
    if (a.state !== 'addressed') return false
    const age = addressedAgeMs(a, now)
    return age !== null && age < MIN_ADDRESSED_DWELL_MS
  })
  if (tooFresh.length > 0) {
    const err = scopeError('review was addressed just now', { openNotes, addressedNotes }) as ScopeError
    err.freshNotes = tooFresh.length
    throw err
  }

  const wanted = new Set<string>()
  if (annotationIds !== null) {
    for (const id of annotationIds) {
      if (typeof id === 'string' && CANVAS_ANNOTATION_ID_RE.test(id)) wanted.add(id)
    }
  }

  const next: ReviewFileRecord = {
    ...base,
    reviews: base.reviews.map((r) => ({ ...r, annotationIds: [...r.annotationIds] })),
    annotations: base.annotations.map(cloneAnnotation),
  }

  const closed: string[] = []
  const skipped: string[] = []
  // The same membership `notesOfReview` uses — both halves, so a note can only
  // move if the review lists it AND it names the review.
  const onReview = (a: Annotation): boolean => a.reviewId === review.id && members.has(a.id)
  for (const a of next.annotations) {
    const named = annotationIds === null ? onReview(a) : wanted.has(a.id)
    if (!named) continue
    // Only an ADDRESSED note on THIS review moves. `openNotes === 0` above
    // means no member can be 'open', so anything refused here is either off
    // this review or already ruled on.
    if (a.state === 'addressed' && onReview(a)) {
      a.state = nextState
      a.closedBy = 'agent'
      a.closedFrom = 'addressed'
      closed.push(a.id)
    } else {
      skipped.push(a.id)
    }
  }
  for (const id of wanted) if (!closed.includes(id) && !skipped.includes(id)) skipped.push(id)

  if (closed.length === 0) return { state: toState(base), closed, skipped, reviewClosed: false }

  settleReviewStatus(next, review.id)
  const reviewClosed = next.reviews.find((r) => r.id === review.id)?.status === 'resolved'
  commit(next)
  return { state: toState(next), closed, skipped, reviewClosed }
}

/**
 * The USER puts a closed note back in play.
 *
 * The inverse of a verdict, and the reason close-out is safe to offer in bulk:
 * nothing here is destroyed, so a wrong bulk click is one click to undo. The
 * note returns to exactly the state it was closed from (`closedFrom`), so a
 * note the agent had marked addressed comes back as addressed rather than
 * landing on the agent as fresh work it already did.
 *
 * Its own function rather than another `resolveAnnotation` action because the
 * PRECONDITION is the inverse: that one requires a live note, this one requires
 * a closed one. Folding two opposite guards into one entry point is how a guard
 * ends up applied to the wrong branch.
 */
export function reopenAnnotation(sessionId: string, annotationId: string): CanvasReviewState {
  const canvas = canvasForSession(sessionId)
  if (!canvas) throw new Error('no canvas for session')
  requireHealthy(canvas.canvasId)
  if (typeof annotationId !== 'string' || !CANVAS_ANNOTATION_ID_RE.test(annotationId)) throw new Error('invalid annotation id')

  const base = recordFor(sessionId, canvas)
  const target = base.annotations.find((a) => a.id === annotationId)
  if (!target) throw new Error('unknown annotation')
  if (!REOPENABLE_STATES.has(target.state)) throw new Error('only a closed note can be reopened')
  const owner = base.reviews.find((r) => r.id === target.reviewId)
  if (!owner || owner.status === 'draft') throw new Error('only a submitted note can be reopened')

  const next: ReviewFileRecord = {
    ...base,
    reviews: base.reviews.map((r) => ({ ...r, annotationIds: [...r.annotationIds] })),
    annotations: base.annotations.map(cloneAnnotation),
  }
  const nextTarget = next.annotations.find((a) => a.id === annotationId)!
  // Records written before close-out existed carry no `closedFrom`. 'open' is
  // the honest default for those: it waits on the agent, which is where a note
  // sits when nobody has claimed to have acted on it.
  nextTarget.state = nextTarget.closedFrom ?? 'open'
  delete nextTarget.closedBy
  delete nextTarget.closedFrom
  // A note back to 'open' is one nobody has claimed to have acted on, so the
  // addressed stamp is no longer true of it. One returning to 'addressed' keeps
  // its stamp: the agent really did act, at that time.
  if (nextTarget.state === 'open') delete nextTarget.addressedAt
  settleReviewStatus(next, owner.id)

  commit(next)
  return toState(next)
}

/**
 * Read a record by CANVAS id, for a mutation that is not addressed to a
 * session — the library's per-canvas close-out, where the row the user clicked
 * may belong to a session that is not theirs and may not be running.
 *
 * Unlike `loadRecord` this never re-stamps the owner: the canvas keeps whatever
 * session owns it, because clearing notes on a canvas is housekeeping and must
 * not move ownership. Unlike `readRecordNoRebind` the result IS destined for
 * the cache, but only via `commit` — a read that closes nothing leaves the maps
 * exactly as it found them.
 */
function recordByCanvasId(canvasId: string): ReviewFileRecord | null {
  if (typeof canvasId !== 'string' || !CANVAS_ID_RE.test(canvasId)) return null
  if (broken.has(canvasId)) return null
  const cached = records.get(canvasId)
  if (cached) return cached
  const parsed = readRecordNoRebind(canvasId)
  if (!parsed) return null
  // `readRecordNoRebind` deliberately skips loadRecord's repairs because it
  // serves a REPORTING read that must not write. This path can reach `commit`,
  // which puts the record in `records` where every later `loadRecord`
  // short-circuits on it — so the counter repair has to happen here or a skewed
  // `nextAnnotation` survives the process and mints a duplicate id.
  healCounters(parsed)
  return parsed
}

/**
 * Bulk close-out for ONE canvas, keyed by canvas id: "the work on this canvas
 * shipped — clear its notes."
 *
 * Keyed by canvasId rather than session for the same reason `deleteCanvas` is:
 * it is driven from the LIBRARY, where the user is looking at every canvas in
 * the project, including ones owned by sessions that have since closed. The
 * user clicked a named row; nothing here is inferred.
 *
 * Same scope rule as the agent path, applied per review: only notes ALREADY
 * WAITING ON THE USER are cleared, and a review still holding open notes is
 * left entirely alone. So this can never clear feedback the agent has not
 * claimed to have acted on — the number it reports is exactly the number of
 * "addressed" notes it found.
 *
 * Returns null for an unreadable store, never a zero — "nothing to close" and
 * "could not tell" must not look the same to the caller.
 */
export function closeOutCanvasReviews(canvasId: string): { closed: number; reviews: string[] } | null {
  const base = recordByCanvasId(canvasId)
  if (!base) return null

  const next: ReviewFileRecord = {
    ...base,
    reviews: base.reviews.map((r) => ({ ...r, annotationIds: [...r.annotationIds] })),
    annotations: base.annotations.map(cloneAnnotation),
  }

  const touched: string[] = []
  let closed = 0
  for (const review of next.reviews) {
    if (review.status !== 'submitted') continue
    const memberNotes = notesOfReview(next, review)
    // A round still with the agent is not "shipped work waiting on you", so it
    // is skipped whole rather than half-cleared. `getReviewCountsForCanvas`
    // applies this same gate, so the library's label counts exactly what this
    // clears — they disagreed once, and the button promised work it never did.
    if (memberNotes.some((a) => a.state === 'open')) continue
    const addressed = memberNotes.filter((a) => a.state === 'addressed')
    if (addressed.length === 0) continue
    for (const a of addressed) {
      a.state = 'stale'
      a.closedBy = 'user'
      a.closedFrom = 'addressed'
      closed++
    }
    touched.push(review.id)
  }

  if (closed === 0) return { closed: 0, reviews: [] }
  for (const id of touched) settleReviewStatus(next, id)
  commit(next)
  return { closed, reviews: touched }
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
