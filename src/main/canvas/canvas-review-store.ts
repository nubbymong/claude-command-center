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
  MAX_ANNOTATION_VARIANTS,
  artifactRuns,
  MAX_ATTACHMENT_PNG_BYTES,
  isCleanVariantLabel,
  type AddressedBy,
  type AgentCloseVerdict,
  type AnchorRef,
  type Annotation,
  type AnnotationImage,
  type AnnotationSketch,
  type AnnotationState,
  type AnnotationVariant,
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
import { clearAwaitingReview, getCanvasStateById, getCanvasStateForSession } from './canvas-store'

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
/** One attachment PNG (sketch export or pasted image). Far beyond any real
 *  annotation attachment; small enough that a save can't be turned into a
 *  disk-filling primitive. The shared constant is the single source; this
 *  export keeps the name the IPC schemas import. */
export const MAX_SKETCH_PNG_BYTES = MAX_ATTACHMENT_PNG_BYTES
/** Ceiling on a reviews.json the COUNT path will read (see readRecordNoRebind).
 *  Generous next to any real record — a few hundred notes of prose — and well
 *  under what the per-field maxima would permit if every one were at its bound. */
const MAX_REVIEW_FILE_BYTES = 8 * 1024 * 1024

const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
/** The one shape a stored pngPath may have — minted here, revalidated on load
 *  so a hand-edited record cannot point the MCP tool at an arbitrary file. */
const PNG_PATH_RE = /^reviews\/R[0-9]{1,9}\/a[0-9]{1,9}\.png$/
/** Same rule for a pasted image's path — its own directory, because the file
 *  exists before the note's review is submitted (no review id yet). */
const IMAGE_PNG_PATH_RE = /^reviews\/pasted\/a[0-9]{1,9}\.png$/

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

/** A note's text may be EMPTY only when a pasted image rides the note — the
 *  image is the note then. Same cleanliness rules otherwise. */
function isCleanNoteOrEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length <= NOTE_MAX_CHARS && !CONTROL_CHARS.test(value)
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
const CLOSED_BY_VALUES = new Set(['user', 'agent', 'supersede'])
const CLOSED_FROM_VALUES = new Set(['open', 'addressed'])
const ADDRESSED_ACTORS = new Set(['agent', 'user'])
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
  if (!(a.image !== undefined ? isCleanNoteOrEmpty(a.note) : isCleanNote(a.note))) return false
  if (typeof a.versionId !== 'string' || !CANVAS_VERSION_ID_RE.test(a.versionId)) return false
  if (typeof a.state !== 'string' || !ANNOTATION_STATES.has(a.state)) return false
  if (a.scope === 'general') {
    if (a.focus !== undefined) return false
  } else if (!isValidFocus(a.focus)) return false
  if (a.sketch !== undefined && !isValidStoredSketch(a.sketch)) return false
  // A pasted image: our minted path shape or absent, and never beside a sketch.
  if (a.image !== undefined) {
    const img = a.image as Partial<AnnotationImage> | null
    if (typeof img !== 'object' || img === null) return false
    if (typeof img.pngPath !== 'string' || !IMAGE_PNG_PATH_RE.test(img.pngPath)) return false
    if (a.sketch !== undefined) return false
  }
  if (a.supersededBy !== undefined && (typeof a.supersededBy !== 'string' || !CANVAS_ANNOTATION_ID_RE.test(a.supersededBy))) return false
  // Alternatives (#373): OUR minted shape or absent — keys are positional
  // 'A'…, labels are held to note cleanliness, and a hand-edited set that
  // breaks either drops the whole note rather than rendering as chips the
  // verdict path would then trust.
  if (a.variants !== undefined) {
    if (!Array.isArray(a.variants) || a.variants.length === 0 || a.variants.length > MAX_ANNOTATION_VARIANTS) return false
    for (let i = 0; i < a.variants.length; i++) {
      const v = a.variants[i] as Partial<AnnotationVariant> | undefined
      if (v?.key !== String.fromCharCode(65 + i)) return false
      if (!isCleanVariantLabel(v.label)) return false
    }
  }
  // A choice exists only as part of an approval, and only of a variant the
  // note actually carries.
  if (a.chosenVariantKey !== undefined) {
    if (a.state !== 'approved') return false
    if (!Array.isArray(a.variants) || !a.variants.some((v) => (v as AnnotationVariant).key === a.chosenVariantKey)) return false
  }
  // Chat-pick provenance (`canvas_pick`): the one legal value, and only in the
  // one legal position — an agent-recorded approval that names a variant. A
  // hand-edited record wearing it anywhere else (on a user close, on a note
  // with no choice) would launder provenance the panel presents as fact.
  if (a.pickSource !== undefined) {
    if (a.pickSource !== 'chat') return false
    if (a.state !== 'approved' || a.closedBy !== 'agent' || a.chosenVariantKey === undefined) return false
  }
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
  // The reopen stamp (#470): same discipline as addressedAt. Its PRESENCE is
  // what shields a round from the supersede sweep, so a malformed value fails
  // the record rather than silently dropping the shield.
  if (a.reopenedAt !== undefined && !isCleanString(a.reopenedAt, 64)) return false
  // The close-out barrier's two inputs, validated hardest of anything here: a
  // hand-edited record that could name a non-agent actor, or set the user's
  // seen flag, would hand `canvas_verdict` the permission it is meant to have
  // to earn. Anything malformed fails the whole record rather than being
  // dropped to undefined, because undefined is a PASS for neither but a
  // half-read record is worse than a refused one.
  if (a.addressedBy !== undefined) {
    const by = a.addressedBy as Partial<AddressedBy> & Record<string, unknown>
    if (typeof by !== 'object' || by === null) return false
    if (typeof by.actor !== 'string' || !ADDRESSED_ACTORS.has(by.actor)) return false
    if (typeof by.sessionId !== 'string' || !SESSION_ID_RE.test(by.sessionId)) return false
  }
  if (a.userSawAddressed !== undefined && typeof a.userSawAddressed !== 'boolean') return false
  // A note waiting on the AGENT cannot carry a claim that the user saw it
  // addressed. Belt and braces next to `markAnnotationsAddressed`, which clears
  // the flag on every open -> addressed move: it stops the flag being smuggled
  // onto an open note through the file in the first place.
  if (a.userSawAddressed === true && a.state === 'open') return false
  // 'approved' by the agent exists in exactly one form: a chat pick, which
  // `recordChatPick` always stamps `pickSource: 'chat'`. The pair without that
  // stamp is what a forged click-approval would look like — refuse it rather
  // than render it. (The pickSource block above already pins the stamp itself
  // to this position, so the two rules together are an iff.)
  if (a.state === 'approved' && a.closedBy === 'agent' && a.pickSource !== 'chat') return false
  // 'supersede' has exactly one legal position (#470): the sweep writes it
  // only as stale-from-addressed. Anywhere else — an approved note wearing it,
  // a dismissal — is a hand-edit laundering provenance the panel would then
  // present as the store's own settling.
  if (a.closedBy === 'supersede' && (a.state !== 'stale' || a.closedFrom !== 'addressed')) return false
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
  /** Version ids the agent is still drafting (#366) — a review must never
   *  freeze against one; the user has not seen it. In render order. */
  draftVersionIds: string[]
  /** Non-draft version ids, in render order — what the pane can show. */
  readyVersionIds: string[]
  /** versionId -> the ARTIFACT (contiguous same-kind run) it belongs to,
   *  keyed by the run's first version id — the same grouping the history
   *  picker uses (#470 supersede scoping). A round supersedes only OTHER
   *  rounds of its own artifact; a plan-artifact ruling must not settle a
   *  mockup-artifact round that merely shares the canvas. */
  artifactKeyByVersion: Map<string, string>
}

function canvasForSession(sessionId: string): SessionCanvas | null {
  if (!SESSION_ID_RE.test(sessionId)) return null
  const state = getCanvasStateForSession(sessionId)
  if (!state) return null
  const artifactKeyByVersion = new Map<string, string>()
  for (const run of artifactRuns(state.versions)) {
    const key = run[0]?.id
    if (key === undefined) continue
    for (const v of run) artifactKeyByVersion.set(v.id, key)
  }
  return {
    canvasId: state.canvasId,
    activeVersionId: state.activeVersionId,
    versionIds: new Set(state.versions.map((v) => v.id)),
    draftVersionIds: state.versions.filter((v) => v.draft).map((v) => v.id),
    readyVersionIds: state.versions.filter((v) => !v.draft).map((v) => v.id),
    artifactKeyByVersion,
  }
}

function requireHealthy(canvasId: string): void {
  if (broken.has(canvasId)) {
    throw new Error('review store unreadable: reviews.json exists but does not validate; not overwriting it')
  }
}

/**
 * A signed-off canvas (#476) is terminal: no new notes, no new rounds. The
 * renderer keeps the note-taking chips disabled while viewing a completed
 * canvas, but that is a label — this is the boundary (ADR-009), so a note
 * write over IPC to a canvas the user re-opened to VIEW is refused here.
 * Reopen (which clears the stamp) is the way back to annotating.
 */
function requireNotCompleted(canvasId: string): void {
  if (getCanvasStateById(canvasId)?.completed) {
    throw new Error('this canvas is signed off as complete; reopen it before adding notes')
  }
}

function recordFor(sessionId: string, canvas: SessionCanvas): ReviewFileRecord {
  const loaded = loadRecord(canvas.canvasId, sessionId)
  if (loaded) return loaded
  // loadRecord returned null for one of two very different reasons, and the
  // fresh-record fallback is right for only ONE of them. "No file yet" is a
  // healthy empty store; "a file exists but failed isValidRecord" is corruption
  // loadRecord just moved into `broken`. requireHealthy runs BEFORE this on
  // every mutation, but `broken` is populated as a side effect of THIS load —
  // so on the FIRST touch of a corrupt file requireHealthy saw an empty set and
  // passed, and without this check the fallback would overwrite preserved
  // evidence with an empty record. Re-assert health now that the load has run.
  requireHealthy(canvas.canvasId)
  return {
    canvasId: canvas.canvasId,
    sessionId,
    nextReview: 1,
    nextAnnotation: 1,
    reviews: [],
    annotations: [],
  }
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
    ...(a.image ? { image: { ...a.image } } : {}),
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
  /** Rounds waiting on the USER: submitted reviews with no open notes and at
   *  least one addressed one. The queue's verdict-owed input (#364). */
  verdictRounds: number
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

/**
 * Whether a reviews.json is present on disk for this canvas.
 *
 * `getReviewCountsForCanvas` returns null for two very different cases — the
 * store is CORRUPT (a file exists but will not read), or there is simply NO
 * file yet (a canvas rendered but never annotated). The dismiss-all sweep must
 * not call the second one "unreadable": a null-count PLUS a present file is a
 * genuinely unreadable store; a null-count with no file is a healthy, empty
 * one. Cheap (a single stat) and only ever called on the sweep's own rows.
 */
export function reviewStoreFileExists(canvasId: string): boolean {
  if (!CANVAS_ID_RE.test(canvasId)) return false
  try {
    return fs.existsSync(reviewsJsonPath(canvasId))
  } catch {
    return false
  }
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
  let verdictRounds = 0
  for (const r of record.reviews) {
    if (r.status !== 'submitted') continue
    if (withOpenNotes.has(r.id)) openReviewIds.push(r.id)
    if ((openByReview.get(r.id) ?? 0) > 0) continue
    closeableNotes += addressedByReview.get(r.id) ?? 0
    // A round waiting on the USER: nothing left for the agent, and at least
    // one addressed note wants a verdict. The queue's second input (#364),
    // derived from the same per-review tallies the close-out gate uses.
    if ((addressedByReview.get(r.id) ?? 0) > 0) verdictRounds++
  }
  return {
    draftNotes: draftIds.size,
    draftVersionIds: [...draftVersions],
    openReviewIds,
    openNotes,
    addressedNotes,
    closeableNotes,
    verdictRounds,
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
 * THE CLOSE-OUT BARRIER: may the agent close this addressed note?
 *
 * The scope rule ("every note on this round is addressed") is a precondition
 * the agent writes ITSELF. `canvas_resolve` moves notes open -> addressed with
 * no user involvement, so resolve-then-verdict satisfies the rule in one
 * unattended pass and takes the round off the pill that would have sent the
 * user to look at it — every note closed as "on your instruction" with no
 * instruction anywhere.
 *
 * The first cut answered that with a 60s dwell on `addressedAt`. That is a
 * DELAY, not an authorisation: an autonomous agent does other work for 61s and
 * the same chain completes. Time cannot express intent, and the barrier has to.
 *
 * So the gate is provenance, not the clock. A note is closeable by the agent
 * only when one of these is true of it:
 *
 *   - the USER HAS SEEN IT ADDRESSED (`userSawAddressed`) — the one bit on the
 *     record no MCP tool can write. It is set from the renderer, and only when
 *     the note's addressed state has actually been on the user's screen in the
 *     active session of a visible window. An agent cannot manufacture it: it
 *     has no way to make the panel visible, and nothing it can call sets it.
 *   - the note was addressed by somebody who is NOT an agent (`addressedBy`),
 *     i.e. the precondition was not the closing party's own work. No such path
 *     exists today; the check is here so that if one is ever added the barrier
 *     reads the fact instead of inheriting an assumption.
 *
 * ABSENT PROVENANCE IS A REFUSAL. A note with no `addressedBy` — every note in
 * the pre-upgrade backlog, which is exactly the backlog this feature exists to
 * clear — is treated as agent-addressed, so the agent may close it only once
 * the user has seen it. Failing open there would have handed the whole existing
 * corpus to the very chain this function refuses.
 *
 * What this deliberately does NOT claim: it is not proof the user SAID "close
 * it". Nothing in the store can see chat. It is proof that the round reached
 * the user's eyes before the agent cleared it — which is the property that
 * makes the refusal path ("hand back, let them rule") reachable at all, and the
 * strongest one the store can verify on its own.
 */
function isAgentCloseable(a: Annotation): boolean {
  if (a.userSawAddressed === true) return true
  return a.addressedBy !== undefined && a.addressedBy.actor !== 'agent'
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

/**
 * Rounds that are OWED but SUPERSEDED (#470): submitted reviews, fully
 * addressed (nothing open, something addressed), whose ordinal sits below a
 * later round the user has already ruled on ('resolved'). The owner's live
 * session hit the shape this names: three ready versions, a review against
 * each, and the pill read 3 — then approving the newest round left the two
 * older fully-addressed rounds counting forever, and re-addressing them
 * pushed the count back UP. A round the user answered by ruling on a NEWER
 * round of the same canvas is settled debt, not fresh debt.
 *
 * Ordinals ('R3' > 'R1'), not frozen version ids, order the rounds: review
 * numbers are minted monotonically per canvas, so a later round is a later
 * ask even when both froze against the same version. The predicate feeds the
 * MUTATION path only (`settleSupersededRounds` inside the four writes that
 * can create the shape); read paths are untouched, so a record written before
 * this existed reads as before until its canvas's next mutation settles it.
 */
function supersededOwedReviewIds(record: ReviewFileRecord, artifactKeyByVersion: Map<string, string>): Set<string> {
  const ord = (id: string): number => Number(id.slice(1))
  // A round's artifact — derived from its NOTES' versions, not its frozen
  // version alone. A round can freeze against a version of a DIFFERENT artifact
  // than its notes point at: the agent's `canvas_render` moves activeVersionId,
  // and submitReview freezes against active, so a mockup note submitted just
  // after a plan render freezes on the plan version (re-attack round 2, MAJOR).
  // Keyed on the frozen version alone, a plan ruling would then stale that
  // mockup note. So a round belongs to an artifact only when its notes AND its
  // frozen version all agree; one that spans artifacts is isolated to its own
  // key (`span:`) — it neither anchors a sweep nor is swept, the fail-closed
  // side. A version absent from the map keys to `v:<id>` (rounds freeze against
  // ready versions, so this is the belt, not the norm).
  const keyOf = (versionId: string): string => artifactKeyByVersion.get(versionId) ?? `v:${versionId}`
  const artifactOf = (r: Review): string => {
    const keys = new Set<string>([keyOf(r.versionId)])
    for (const a of notesOfReview(record, r)) keys.add(keyOf(a.versionId))
    return keys.size === 1 ? [...keys][0] : `span:${r.id}`
  }
  // Per ARTIFACT, the highest-ordinal round the USER verifiably ruled on. Per
  // artifact, not per canvas (review round 2, security lens): a canvas holds
  // many artifacts (a plan, a mockup, a legacy build), and "the user answered
  // this more recently" is only true for later rounds of the SAME artifact —
  // approving a plan says nothing about a mockup's open feedback.
  const resolvedMaxByArtifact = new Map<string, number>()
  for (const r of record.reviews) {
    if (r.status !== 'resolved') continue
    // Only a round the USER verifiably ruled on anchors supersession. The
    // sweep's justification is "the user answered this artifact more recently
    // than these rounds", and that must be a fact the store can check, not an
    // agent assertion: a round resolved purely through the agent-callable
    // writes (canvas_verdict, canvas_pick — closedBy 'agent') must not let a
    // single canvas_pick transitively settle every older round without the
    // seen-barrier ever running (review round 1, security lens). The two
    // provenances no agent path can mint: a note closed by the user's own
    // panel click (closedBy 'user' — the approved+agent iff rule pins agent
    // approvals to chat picks), and a re-annotation (state 'reannotated' is
    // written only by the panel's resolve IPC).
    const userRuled = notesOfReview(record, r).some((a) => a.closedBy === 'user' || a.state === 'reannotated')
    if (!userRuled) continue
    const art = artifactOf(r)
    resolvedMaxByArtifact.set(art, Math.max(resolvedMaxByArtifact.get(art) ?? 0, ord(r.id)))
  }
  const out = new Set<string>()
  if (resolvedMaxByArtifact.size === 0) return out
  for (const r of record.reviews) {
    if (r.status !== 'submitted') continue
    const anchorMax = resolvedMaxByArtifact.get(artifactOf(r)) ?? 0
    if (anchorMax === 0 || ord(r.id) >= anchorMax) continue
    const notes = notesOfReview(record, r)
    // A round still holding OPEN notes is the agent's debt and survives whole;
    // one with nothing addressed has nothing owed to settle.
    if (notes.some((a) => a.state === 'open')) continue
    if (!notes.some((a) => a.state === 'addressed')) continue
    // A REOPENED note shields its round for good (#470): reopening is the user
    // deliberately putting a settled note back in play, and an automatic sweep
    // that immediately re-settles it would make Reopen a no-op. Only the
    // user's own verdict ends a reopened note.
    if (notes.some((a) => a.state === 'addressed' && a.reopenedAt !== undefined)) continue
    // THE SEEN-BARRIER, applied to the automatic sweep (ADR-009 adversarial
    // pass). This is the load-bearing gate. Without it, `canvas_resolve`
    // (markAnnotationsAddressed — agent-callable) becomes an unattended
    // terminal close: the agent addresses a round the user never saw, and if
    // ANY later round was user-ruled the sweep closes it in the same commit —
    // the precise chain `isAgentCloseable`/`closeAnnotationsByAgent` refuse by
    // name. The sweep is that same close reached without naming it, so it must
    // clear the same bar: every addressed note must be agent-closeable (the
    // user has SEEN it addressed, or a non-agent addressed it). An
    // agent-addressed-but-unseen note keeps its round owed until the user's
    // next glance marks it seen (or they dismiss it) — one look, not a silent
    // close. This is what makes the panel's "settled by your later review"
    // true: the notes were on the user's screen before the sweep touched them.
    if (notes.some((a) => a.state === 'addressed' && !isAgentCloseable(a))) continue
    // A round the user is THEMSELVES triaging — they have ruled on one of its
    // notes with their own click (closedBy 'user') — is not settled debt. The
    // click that ruled one note is a verdict on that note, never on its
    // siblings, so a later round resolving must not sweep the rest of a round
    // the user is actively working through. A 'reannotated' note is NOT a
    // shield: the user finished with it and its replacement lives in a newer
    // round, so its addressed round-mates are ordinary settle-able debt
    // (re-attack round 2).
    if (notes.some((a) => a.closedBy === 'user')) continue
    out.add(r.id)
  }
  return out
}

/**
 * Make the supersession durable: every round `supersededOwedReviewIds` names
 * has its addressed notes moved to 'stale' with `closedBy: 'supersede'` —
 * the automated form of the dismiss-all sweep the owner used as the
 * workaround. Nothing is deleted, the row says the store settled it (never
 * that a person clicked it), and Reopen puts any note straight back.
 *
 * Runs inside every mutation that can create the shape — a later round
 * resolving or an older round becoming fully addressed after the later round
 * already resolved (`markAnnotationsAddressed`, the owner's 3→2→3 bounce).
 * Deliberately NOT a new agent capability: the anchor is STORE-VERIFIED user
 * provenance on the resolved later round (see supersededOwedReviewIds), the
 * notes end in a reopenable state, and `canvas_verdict`'s seen-barrier still
 * guards every close the agent asks for by name.
 */
function settleSupersededRounds(record: ReviewFileRecord, artifactKeyByVersion: Map<string, string>): string[] {
  const doomed = supersededOwedReviewIds(record, artifactKeyByVersion)
  if (doomed.size === 0) return []
  for (const review of record.reviews) {
    if (!doomed.has(review.id)) continue
    for (const a of notesOfReview(record, review)) {
      if (a.state !== 'addressed') continue
      a.state = 'stale'
      a.closedBy = 'supersede'
      a.closedFrom = 'addressed'
    }
    settleReviewStatus(record, review.id)
  }
  return [...doomed]
}

/** Validate a renderer-supplied draft against this canvas. Throws on anything
 *  out of shape — the IPC schema should have caught it, so a throw here is a
 *  bug surfacing, not a user error. */
function validateDraft(draft: CanvasAnnotationDraft, canvas: SessionCanvas): void {
  if (typeof draft !== 'object' || draft === null) throw new Error('invalid draft')
  if (!ANNOTATION_SCOPES.has(draft.scope)) throw new Error('invalid draft scope')
  // Empty text is allowed only when a pasted image rides the note.
  if (!(draft.image !== undefined ? isCleanNoteOrEmpty(draft.note) : isCleanNote(draft.note))) throw new Error('invalid draft note')
  if (draft.image !== undefined) {
    if (draft.sketch !== undefined) throw new Error('a note carries one attachment: a sketch or an image')
    if (draft.image !== 'keep') {
      const img = draft.image as { pngBase64?: unknown } | null
      if (typeof img !== 'object' || img === null || typeof img.pngBase64 !== 'string' || img.pngBase64.length === 0)
        throw new Error('invalid draft image')
      if (img.pngBase64.length > Math.ceil(MAX_ATTACHMENT_PNG_BYTES / 3) * 4 + 8) throw new Error('draft image too large')
    }
  }
  if (typeof draft.versionId !== 'string' || !canvas.versionIds.has(draft.versionId)) throw new Error('draft names an unknown version')
  // A user note can only be about a version the user was SHOWN. Agent drafts
  // (#366) are invisible by contract — and after a subject change their ids
  // restart at v1, so an id from the pane's canvas can collide with a draft
  // on the session's new one. Refusing here keeps a note from silently
  // anchoring to a page the user has never seen.
  if (canvas.draftVersionIds.includes(draft.versionId)) throw new Error('draft names a version the user has not been shown')
  if (draft.scope === 'general') {
    if (draft.focus !== undefined) throw new Error('a general note carries no focus')
  } else {
    if (!isValidFocus(draft.focus)) throw new Error('invalid draft focus')
    if (draft.scope === 'element' && draft.focus.targets.length === 0) throw new Error('an element note needs at least one anchor')
  }
  if (draft.sketch !== undefined && !isValidSketchMeta(draft.sketch)) throw new Error('invalid draft sketch')
}

/** Where a pasted image lives, relative to the canvas dir. Keyed by note id —
 *  unique per canvas — because at compose time the review id is still fluid. */
function pastedImagePath(annotationId: string): string {
  return `reviews/pasted/${annotationId}.png`
}

/** Decode, cap-check and write a pasted image; returns the record to store.
 *  Same PNG discipline as sketch exports (magic + byte cap), written BEFORE the
 *  record commits so a failed write refuses the whole save. */
function writePastedImage(canvasId: string, annotationId: string, pngBase64: string): AnnotationImage {
  const bytes = decodeAttachmentPng(pngBase64)
  mkdirSecure(path.join(canvasDir(canvasId), 'reviews', 'pasted'))
  atomicWriteSecure(path.join(canvasDir(canvasId), pastedImagePath(annotationId)), bytes)
  return { pngPath: pastedImagePath(annotationId) }
}

/** Best-effort removal — a leftover file no record references is harmless; a
 *  throw here must never undo the record mutation it accompanies. */
function unlinkPastedImage(canvasId: string, image: AnnotationImage | undefined): void {
  if (!image?.pngPath || !IMAGE_PNG_PATH_RE.test(image.pngPath)) return
  try {
    fs.unlinkSync(path.join(canvasDir(canvasId), image.pngPath))
  } catch {
    /* already gone, or locked — either way the record is the truth */
  }
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
  requireNotCompleted(canvas.canvasId)
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
    // A removal's file is unlinked AFTER the commit, never before — the same
    // persist-before-memory discipline deleteAnnotation states: if `persist`
    // throws, the still-committed record must not reference a file we already
    // deleted. Captured here (from the clone we are about to overwrite) and
    // unlinked past the commit below.
    let imageToUnlink: AnnotationImage | undefined
    if (draft.image === 'keep') {
      if (!existing.image) throw new Error('no image to keep on this note')
    } else if (draft.image) {
      // Write before commit (persist-before-memory); replacing overwrites the
      // same path atomically.
      existing.image = writePastedImage(canvas.canvasId, existing.id, draft.image.pngBase64)
    } else if (existing.image) {
      imageToUnlink = existing.image
      delete existing.image
    }
    commit(next)
    if (imageToUnlink) unlinkPastedImage(canvas.canvasId, imageToUnlink)
    return { state: toState(next), annotationId }
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
    if (draft.image === 'keep') throw new Error('no image to keep on a new note')
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
      ...(draft.image ? { image: writePastedImage(canvas.canvasId, annotationId, draft.image.pngBase64) } : {}),
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
  requireNotCompleted(canvas.canvasId)
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
  // After the commit: a pasted image belongs to exactly this note, so the file
  // goes with it. Best-effort — the record is already the truth.
  unlinkPastedImage(canvas.canvasId, target.image)
  return toState(next)
}

/** PNG magic: the eight bytes every real PNG starts with. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Decode + validate a note-attachment PNG. Shared by both attachment kinds —
 *  a sketch export and a pasted screenshot — so the messages say "attachment",
 *  not "sketch", or a paste failure reads as a sketch bug in the logs. */
function decodeAttachmentPng(pngBase64: string): Buffer {
  if (typeof pngBase64 !== 'string' || pngBase64.length === 0) throw new Error('invalid attachment png')
  const bytes = Buffer.from(pngBase64, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_SKETCH_PNG_BYTES) throw new Error('attachment png too large')
  if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) throw new Error('attachment is not a png')
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
  requireNotCompleted(canvas.canvasId)
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
    const bytes = decodeAttachmentPng(pngBase64)
    const relPath = `reviews/${reviewId}/${annotation.id}.png`
    annotation.sketch.pngPath = relPath
    pngWrites.push({ absPath: path.join(canvasDir(canvas.canvasId), 'reviews', reviewId, `${annotation.id}.png`), bytes })
  }
  if (exportsById.size > 0) throw new Error('sketch export for a note not in this review')

  nextReview.status = 'submitted'
  nextReview.submittedAt = new Date().toISOString()
  // D12: the review freezes against the version the user was LOOKING at. With
  // drafts (#366) that is not always the active version: the agent may already
  // be drafting the next round, which moves activeVersionId onto a version the
  // pane deliberately does not show. Freezing against the draft would anchor
  // the user's notes to a document they never saw.
  const activeIsDraft = canvas.activeVersionId !== null && canvas.draftVersionIds.includes(canvas.activeVersionId)
  const frozenVersionId = activeIsDraft
    ? canvas.readyVersionIds[canvas.readyVersionIds.length - 1]
    : canvas.activeVersionId
  if (!frozenVersionId) throw new Error('no active version to submit against')
  nextReview.versionId = frozenVersionId

  // PNGs first, record second, memory last. A failure anywhere leaves the
  // draft intact in memory and on disk; at worst orphaned PNG files that no
  // record references.
  if (pngWrites.length > 0) {
    mkdirSecure(path.join(canvasDir(canvas.canvasId), 'reviews', reviewId))
    for (const write of pngWrites) atomicWriteSecure(write.absPath, write.bytes)
  }
  commit(next)
  // Submitting IS responding: the ready-marked round leaves the review queue
  // (#366). After the commit, so a failed submit never clears what is owed;
  // and never the other way to fail — a clear that throws must not undo a
  // submit that persisted.
  //
  // But clear ONLY when this round actually covers the AWAITED version (#476
  // adversarial): if a newer ready render superseded the one the user was
  // looking at, their notes are anchored to the OLDER version while the stamp
  // points at the newer one — clearing it would mark the newer render
  // "reviewed" though the user never saw it, and #476's completion guard
  // leans on that stamp. The notes' own versionId is the only signal that
  // distinguishes the two (frozenVersionId is always the latest ready). In
  // the ordinary flow the user annotates the awaited render, so the ids match
  // and this clears exactly as before.
  const awaited = getCanvasStateForSession(sessionId)?.awaitingReview?.versionId
  const submittedVersionIds = new Set(
    next.annotations.filter((a) => members.has(a.id)).map((a) => a.versionId),
  )
  if (awaited === undefined || submittedVersionIds.has(awaited)) {
    try {
      clearAwaitingReview(canvas.canvasId)
    } catch (err) {
      logInfo(`[canvas-review] clearAwaitingReview failed for ${canvas.canvasId}: ${err}`)
    }
  }
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
  expectedCanvasId: string,
  /** The alternative the user approved (#373). Only 'approve' may carry one,
   *  and it must name a variant that exists on the note — the choice is part
   *  of the approval, never a side channel. */
  variantKey?: string,
): { state: CanvasReviewState; reannotationId?: string } {
  const canvas = canvasForSession(sessionId)
  if (!canvas) throw new Error('no canvas for session')
  requireHealthy(canvas.canvasId)
  requireNotCompleted(canvas.canvasId)
  // The canvas the CALLER meant. Annotation ids restart at a1 on every canvas
  // and the session's canvas is mutable — an agent's `canvas_render` naming a
  // different subject files the current one — so an id alone names a note only
  // as long as the canvas holds still. The panel re-checks between notes in a
  // bulk pass, but the last check and the write it authorises are separated by
  // an await, and one note can slip through that gap: it lands on whichever a4
  // happens to exist on the NEW canvas and closes it under the user's own name.
  // Naming the canvas closes the gap, because the check is now inside the same
  // synchronous mutation as the write.
  if (typeof expectedCanvasId !== 'string' || canvas.canvasId !== expectedCanvasId) {
    throw new Error('canvas changed under this resolve')
  }
  if (typeof annotationId !== 'string' || !CANVAS_ANNOTATION_ID_RE.test(annotationId)) throw new Error('invalid annotation id')
  if (typeof action !== 'string' || !RESOLVE_ACTIONS.has(action)) throw new Error('invalid action')
  // A variant choice is PART OF an approval (#373): any other action carrying
  // one is a caller mistake, refused rather than silently dropped.
  if (variantKey !== undefined && action !== 'approve') throw new Error('a variant choice rides an approval only')
  if (variantKey !== undefined && (typeof variantKey !== 'string' || !/^[A-D]$/.test(variantKey))) {
    throw new Error('invalid variant key')
  }

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
    if (variantKey !== undefined) {
      // The choice must name an alternative this note actually carries — a key
      // for a set the agent replaced (or never attached) approves nothing.
      if (!nextTarget.variants?.some((v) => v.key === variantKey)) throw new Error('unknown variant')
      nextTarget.chosenVariantKey = variantKey
    }
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
    // The version the re-annotation is ABOUT: the one the user is looking at.
    // With drafts (#366) the ACTIVE version can be agent work-in-progress the
    // pane deliberately does not show — the same rule submitReview applies, so
    // a note minted here can never anchor to a page the user has not seen.
    const activeIsDraft = canvas.activeVersionId !== null && canvas.draftVersionIds.includes(canvas.activeVersionId)
    const shownVersionId = activeIsDraft
      ? canvas.readyVersionIds[canvas.readyVersionIds.length - 1]
      : canvas.activeVersionId
    if (!shownVersionId) throw new Error('no active version to re-annotate against')
    let draft = draftReviewOf(next)
    if (!draft) {
      if (next.reviews.length >= MAX_REVIEWS_PER_CANVAS) throw new Error('review cap reached for this canvas')
      draft = {
        id: `R${next.nextReview}`,
        canvas: { sessionId, canvasId: canvas.canvasId },
        versionId: shownVersionId,
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
      versionId: shownVersionId,
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
  // The user just ruled: if that resolved a round, older fully-addressed
  // (and user-seen) rounds of the SAME artifact are settled debt now, not
  // stacked debt (#470).
  settleSupersededRounds(next, canvas.artifactKeyByVersion)

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
    .filter((a) => (a.sketch && a.sketch.pngPath !== '') || a.image)
    .map((a) => ({
      annotationId: a.id,
      pngPath: a.sketch && a.sketch.pngPath !== '' ? a.sketch.pngPath : a.image!.pngPath,
    }))

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
  /**
   * Alternatives per note (#373): "addressed, three ways — pick which ships".
   * Keyed by annotation id; each entry is the LABELS in order, and the store
   * mints the keys ('A'…) from position so the agent can never forge or
   * collide one. Validated here as well as at the MCP ingress: labels are held
   * to note cleanliness and the variant caps, and an entry for a note this
   * call does not address is refused — variants only ever ride an address.
   */
  variantsByNote?: Readonly<Record<string, readonly string[]>>,
): { state: CanvasReviewState; addressed: string[]; skipped: string[] } {
  const canvas = canvasForSession(sessionId)
  if (!canvas) throw new Error('no canvas for session')
  requireHealthy(canvas.canvasId)
  requireNotCompleted(canvas.canvasId)
  if (typeof reviewId !== 'string' || !CANVAS_REVIEW_ID_RE.test(reviewId)) throw new Error('invalid review id')
  const wanted = new Set<string>()
  for (const id of annotationIds) {
    if (typeof id === 'string' && CANVAS_ANNOTATION_ID_RE.test(id)) wanted.add(id)
  }
  const variantEntries = new Map<string, AnnotationVariant[]>()
  if (variantsByNote !== undefined) {
    if (typeof variantsByNote !== 'object' || variantsByNote === null || Array.isArray(variantsByNote)) {
      throw new Error('invalid variants')
    }
    for (const [noteId, labels] of Object.entries(variantsByNote)) {
      if (!wanted.has(noteId)) throw new Error('variants name a note this call does not address')
      if (!Array.isArray(labels) || labels.length === 0 || labels.length > MAX_ANNOTATION_VARIANTS) {
        throw new Error('invalid variants')
      }
      const minted: AnnotationVariant[] = labels.map((label, i) => {
        // Stricter than a note: a label is a single serializer FIELD beside
        // `chosen-variant:` — a newline in it would let the agent forge the
        // user's decision line, so every control character is banned.
        if (!isCleanVariantLabel(label)) {
          throw new Error('invalid variant label')
        }
        return { key: String.fromCharCode(65 + i), label }
      })
      variantEntries.set(noteId, minted)
    }
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
      // When, as provenance for the panel and the record.
      a.addressedAt = new Date().toISOString()
      // WHO, which is what the close-out barrier actually reads: this write is
      // the agent creating its own precondition for `canvas_verdict`, and the
      // record has to say so or the two are indistinguishable later.
      a.addressedBy = { actor: 'agent', sessionId }
      // A fresh claim of work is a fresh thing to be seen. Whatever the user
      // saw before was the previous round of this note, not this one — so the
      // barrier starts closed again.
      delete a.userSawAddressed
      // Alternatives ride the address they came with (#373): a fresh address
      // replaces the previous set whole, and a stale choice must not survive
      // a new set it may not even name.
      const minted = variantEntries.get(a.id)
      if (minted) a.variants = minted
      else delete a.variants
      delete a.chosenVariantKey
      addressed.push(a.id)
    } else {
      skipped.push(a.id)
    }
  }
  for (const id of wanted) if (!addressed.includes(id) && !skipped.includes(id)) skipped.push(id)
  // The owner's 3→2→3 bounce (#470): addressing the notes of a round whose
  // artifact already has a LATER user-ruled round used to push that round
  // back into "waiting on the user". The sweep collapses it instead — but
  // ONLY once the user has seen those notes addressed (the seen-barrier in
  // supersededOwedReviewIds): a note the agent addresses in this very call is
  // not yet seen, so it stays owed for one glance rather than closing under
  // the user unattended. That one-glance delay is the deliberate price of not
  // handing `canvas_resolve` an unattended close past the barrier (ADR-009).
  if (addressed.length > 0) settleSupersededRounds(next, canvas.artifactKeyByVersion)
  if (addressed.length > 0) commit(next)
  return { state: toState(addressed.length > 0 ? next : base), addressed, skipped }
}

/**
 * The USER has seen these notes in their addressed state (the close-out
 * barrier's release).
 *
 * Reached ONLY from the renderer, over `canvas:reviewMarkSeen`, and only after
 * the panel has actually had the addressed rows on screen — active session,
 * visible window, long enough to read. No MCP tool reaches this function, and
 * that is the whole point: `userSawAddressed` is the one bit on the record the
 * agent cannot write, which is what makes it usable as an authorisation input
 * where `addressedAt` (which the agent writes, and can simply outwait) is not.
 *
 * Narrow on purpose:
 *  - the caller must NAME THE CANVAS it saw. The renderer's ids were captured
 *    against one canvas, and an agent's `canvas_render` can file that canvas
 *    mid-flight; without the check a stale in-flight "I saw these" would land
 *    on whichever a1/a2 exist on the new canvas and unlock notes nobody has
 *    ever looked at.
 *  - only a note that is 'addressed' RIGHT NOW on a SUBMITTED review moves. A
 *    seen flag on anything else is meaningless at best.
 *  - nothing is written when nothing changed, so the panel's steady-state
 *    re-render does not turn into a commit/emit loop.
 */
export function markAddressedNotesSeen(
  sessionId: string,
  canvasId: string,
  annotationIds: readonly string[],
): { state: CanvasReviewState; seen: string[] } {
  const canvas = canvasForSession(sessionId)
  if (!canvas) throw new Error('no canvas for session')
  requireHealthy(canvas.canvasId)
  if (typeof canvasId !== 'string' || canvas.canvasId !== canvasId) throw new Error('canvas changed under this session')

  const wanted = new Set<string>()
  for (const id of annotationIds) {
    if (typeof id === 'string' && CANVAS_ANNOTATION_ID_RE.test(id)) wanted.add(id)
  }
  const base = recordFor(sessionId, canvas)
  if (wanted.size === 0) return { state: toState(base), seen: [] }

  const submitted = new Set(base.reviews.filter((r) => r.status === 'submitted').map((r) => r.id))
  const next: ReviewFileRecord = {
    ...base,
    reviews: base.reviews.map((r) => ({ ...r, annotationIds: [...r.annotationIds] })),
    annotations: base.annotations.map(cloneAnnotation),
  }
  const seen: string[] = []
  for (const a of next.annotations) {
    if (!wanted.has(a.id)) continue
    if (a.state !== 'addressed' || !submitted.has(a.reviewId)) continue
    if (a.userSawAddressed === true) continue
    a.userSawAddressed = true
    seen.push(a.id)
  }
  if (seen.length === 0) return { state: toState(base), seen }
  // The glance IS the seen-barrier's release, so it is exactly the moment a
  // round the user had already answered (by ruling a later round) becomes
  // settle-able (#470 re-attack round 2): run the sweep here so the pill
  // clears on the look, not one mutation later. Renderer-only path, so this
  // adds no agent capability — it settles only what the user has now seen.
  settleSupersededRounds(next, canvas.artifactKeyByVersion)
  commit(next)
  return { state: toState(next), seen }
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
  /** How many notes the user has not seen in their addressed state, and so may
   *  not be closed by the agent (the close-out barrier). */
  unseenNotes?: number
  /** True when the session being refused is the one that addressed those notes
   *  — the resolve-then-verdict chain, rather than an inherited backlog. */
  selfAddressed?: boolean
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

  // THE BARRIER (see isAgentCloseable). Whole-round, not per-note: a partial
  // close would leave the user a round stripped of everything except the notes
  // the agent could not justify closing, which reads as "these were handled"
  // about the ones that vanished. Either the round reached the user or none of
  // it closes this way.
  const unseen = memberNotes.filter((a) => a.state === 'addressed' && !isAgentCloseable(a))
  if (unseen.length > 0) {
    const err = scopeError('review has not reached the user', { openNotes, addressedNotes })
    err.unseenNotes = unseen.length
    // Whether the refusing session is the same one that created the
    // precondition. Both cases are refused; they are told apart only so the
    // refusal can name what actually happened.
    err.selfAddressed = unseen.some((a) => a.addressedBy?.sessionId === sessionId)
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
  // Re-runs the sweep so a legacy record can HEAL on the next agent write; an
  // agent close never anchors supersession itself (closedBy 'agent' is not
  // user provenance), so this only ever settles rounds a prior USER ruling
  // already licensed (#470).
  settleSupersededRounds(next, canvas.artifactKeyByVersion)
  const reviewClosed = next.reviews.find((r) => r.id === review.id)?.status === 'resolved'
  commit(next)
  return { state: toState(next), closed, skipped, reviewClosed }
}

/**
 * The USER's variant pick, stated in chat and recorded by the agent
 * (`canvas_pick`).
 *
 * The agent's THIRD write into the review store, and the only one that can end
 * in 'approved' — which is why it is the narrowest of the three: exactly one
 * note, and only a pick among alternatives the agent itself attached when it
 * addressed that note (#373). There is no free-form approval here: a note with
 * no variants has nothing to pick, and a key the note does not offer approves
 * nothing. Every gate fails closed with its own message so the tool can tell
 * the agent what actually stood in the way.
 *
 * Provenance is the point. The write is stamped `closedBy: 'agent'` AND
 * `pickSource: 'chat'` together: the panel renders it as "picked in chat",
 * apart from the user's own Approve clicks, and the validator refuses either
 * stamp without the other — so this function widens nothing for a forged
 * click-approval. Reopen undoes it in one click, exactly like any other close.
 *
 * Deliberately NO seen-barrier, unlike `closeAnnotationsByAgent`: that barrier
 * exists because "addressed" is the agent's own claim and closing on it lets
 * one hand create and spend the permission. A pick is the opposite shape — the
 * user themselves named the winner in conversation, so the user's engagement
 * is the input, not something the write has to prove happened. What this
 * function CANNOT verify is that the chat message exists; that stays on the
 * tool description ("only on an explicit pick in this conversation") and on
 * the visible provenance the user can audit and reopen.
 */
export function recordChatPick(
  sessionId: string,
  reviewId: string,
  annotationId: string,
  variantKey: string,
): { state: CanvasReviewState; pickedLabel: string; reviewClosed: boolean } {
  const canvas = canvasForSession(sessionId)
  if (!canvas) throw new Error('no canvas for session')
  requireHealthy(canvas.canvasId)
  if (typeof reviewId !== 'string' || !CANVAS_REVIEW_ID_RE.test(reviewId)) throw new Error('invalid review id')
  if (typeof annotationId !== 'string' || !CANVAS_ANNOTATION_ID_RE.test(annotationId)) throw new Error('invalid annotation id')
  // Same shape the user's own approve path holds a key to — positional 'A'…'D',
  // nothing else ever minted.
  if (typeof variantKey !== 'string' || !/^[A-D]$/.test(variantKey)) throw new Error('invalid variant key')

  const base = recordFor(sessionId, canvas)
  // Same caveat as every agent write: a review id is an ordinal within the
  // ACTIVE canvas, not a handle on one particular review. Membership below is
  // checked on both halves for the same reason closeAnnotationsByAgent's is.
  const review = base.reviews.find((r) => r.id === reviewId)
  if (!review) throw new Error('review not on this canvas')
  if (review.status === 'draft') throw new Error('review is still a draft')
  const target = base.annotations.find((a) => a.id === annotationId)
  if (!target || target.reviewId !== review.id || !review.annotationIds.includes(annotationId)) {
    throw new Error('note not on this review')
  }
  // Only an ADDRESSED note carries a live offer. An open note has no variants
  // to pick from yet; a closed one has already been ruled on — the two refusals
  // are told apart so the tool can name the remedy (do the work vs. reopen).
  if (target.state === 'open') throw new Error('note is still open')
  if (target.state !== 'addressed') throw new Error('note is already ruled on')
  if (!target.variants || target.variants.length === 0) throw new Error('note has no variants')
  const offered = target.variants.find((v) => v.key === variantKey)
  if (!offered) throw new Error('variant not offered on this note')

  const next: ReviewFileRecord = {
    ...base,
    reviews: base.reviews.map((r) => ({ ...r, annotationIds: [...r.annotationIds] })),
    annotations: base.annotations.map(cloneAnnotation),
  }
  const nextTarget = next.annotations.find((a) => a.id === annotationId)!
  nextTarget.state = 'approved'
  nextTarget.chosenVariantKey = variantKey
  nextTarget.closedBy = 'agent'
  nextTarget.closedFrom = 'addressed'
  nextTarget.pickSource = 'chat'

  settleReviewStatus(next, review.id)
  // A chat pick is closedBy 'agent', so it never anchors supersession itself;
  // this re-runs the sweep only so a legacy record heals on the next write
  // (#470). Same as the instructed-close path above.
  settleSupersededRounds(next, canvas.artifactKeyByVersion)
  const reviewClosed = next.reviews.find((r) => r.id === review.id)?.status === 'resolved'
  commit(next)
  // The label is store-held and was validated clean at mint; the tool echoes it
  // so the agent can confirm WHICH alternative it is now building.
  return { state: toState(next), pickedLabel: offered.label, reviewClosed }
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
  requireNotCompleted(canvas.canvasId)
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
  // The supersede shield (#470): a reopened note is the user's deliberate
  // re-ask, and the automatic sweep must never re-settle it — with the stamp,
  // only their own verdict ends this note. Stamped on EVERY reopen (also one
  // back to 'open': the agent's re-address keeps the shield, or the sweep
  // would stale the very work the reopen asked for).
  nextTarget.reopenedAt = new Date().toISOString()
  delete nextTarget.closedBy
  delete nextTarget.closedFrom
  // A note back to 'open' is one nobody has claimed to have acted on, so the
  // addressed stamp is no longer true of it. One returning to 'addressed' keeps
  // its stamp: the agent really did act, at that time.
  if (nextTarget.state === 'open') {
    delete nextTarget.addressedAt
    delete nextTarget.addressedBy
    // ...and the alternatives rode that address (#373): back to 'open' they
    // describe work nobody currently claims.
    delete nextTarget.variants
  }
  // The CHOICE never survives a reopen: it was part of the approval being
  // undone. The variants themselves stay on an 'addressed' note — the
  // alternatives still exist; the user simply has not re-ruled. The chat-pick
  // stamp describes that choice, so it dies with it (and the validator refuses
  // it on any state but 'approved' anyway).
  delete nextTarget.chosenVariantKey
  delete nextTarget.pickSource
  // The seen flag does NOT survive a reopen either way. Reopening is the user
  // putting the note back in play, and letting the agent re-close it on the
  // strength of a look that happened before that would make Reopen a one-shot
  // the agent could immediately undo. The panel re-marks it the moment the user
  // has the round on screen again, which is the same user in the same breath.
  delete nextTarget.userSawAddressed
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
 * Delete every note anchored to one of `versionIds`, because the artifact those
 * versions belong to was permanently deleted (item C, phase 5). Reviews left
 * with no notes are removed; the monotonic counters are untouched, so no id is
 * ever reissued. Attachment files (sketch exports, pasted images) for the
 * removed notes are unlinked best-effort — the record is the durable truth.
 *
 * Keyed by canvasId, like closeOutCanvasReviews and deleteCanvas: the caller
 * (the delete-artifact IPC handler) holds both stores and drives this after the
 * canvas store has removed the versions. Returns the number of notes removed,
 * or null for an unreadable store.
 */
export function deleteAnnotationsForVersions(canvasId: string, versionIds: readonly string[]): number | null {
  const base = recordByCanvasId(canvasId)
  if (!base) return null
  const targets = new Set<string>()
  for (const id of versionIds) if (typeof id === 'string' && CANVAS_VERSION_ID_RE.test(id)) targets.add(id)
  if (targets.size === 0) return 0

  const doomed = base.annotations.filter((a) => targets.has(a.versionId))
  if (doomed.length === 0) return 0
  const doomedIds = new Set(doomed.map((a) => a.id))

  const keptAnnotations = base.annotations.filter((a) => !doomedIds.has(a.id)).map(cloneAnnotation)
  const reviews = base.reviews
    .map((r) => ({ ...r, annotationIds: r.annotationIds.filter((id) => !doomedIds.has(id)) }))
    // A review emptied of every note is removed — its number is not reused
    // (nextReview never decreases), exactly like a deleted version's id.
    .filter((r) => r.annotationIds.length > 0)

  const next: ReviewFileRecord = { ...base, reviews, annotations: keptAnnotations }
  commit(next)

  // Best-effort file cleanup for the removed notes. The record already no longer
  // references them, so a leftover file is harmless; a throw here must never
  // undo the commit above.
  for (const a of doomed) {
    if (a.image) unlinkPastedImage(canvasId, a.image)
    // Re-validate the sketch path at unlink time, exactly as unlinkPastedImage
    // re-checks its own — the record is validated on load today, but this guard
    // keeps the unlink from becoming a delete-by-path primitive if any future
    // path ever warms the cache with a less-validated sketch pngPath (ADR-009).
    if (a.sketch && PNG_PATH_RE.test(a.sketch.pngPath)) {
      try {
        fs.unlinkSync(path.join(canvasDir(canvasId), a.sketch.pngPath))
      } catch {
        /* already gone, locked, or never exported — the record is the truth */
      }
    }
  }
  return doomed.length
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
