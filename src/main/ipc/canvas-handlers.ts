// Agent Canvas IPC — the renderer's read/notify surface over the canvas store.
//
// The store (src/main/canvas/canvas-store.ts) is the single mutation point;
// these handlers validate renderer input with Zod and delegate. `canvas:render`
// is the P1 ingress for content (dev tooling and tests); the agent-facing
// `canvas_render` MCP tool (P3) will call the same store API, and both fan out
// to the renderer through the store's change feed → `canvas:changed` push.
//
// No default export (project convention).

import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc-channels'
import {
  deleteArtifact,
  deleteCanvas,
  getCanvasStateById,
  getCanvasStateForSession,
  listAllCanvases,
  onCanvasChanged,
  renderVersion,
  reopenVersionForReview,
  setActiveVersion,
  setArtifactArchived,
  setVersionVerdict,
  verdictTargetVersionId,
} from '../canvas/canvas-store'
import {
  MAX_SKETCH_PNG_BYTES,
  clearComposerDraft,
  deleteAnnotation,
  dropReviewsForCanvas,
  getReviewCountsForCanvas,
  getReviewSnapshotForCanvas,
  getReviewStateForSession,
  deleteAnnotationsForVersions,
  markAddressedNotesSeen,
  onReviewChanged,
  reopenAnnotation,
  reopenReview,
  setComposerDraft,
  settleReviewsForSupersededVersions,
  settleRoundsForUserDecision,
  submitReview,
  upsertAnnotation,
} from '../canvas/canvas-review-store'
import { completeCanvasGuarded, describeForceClosures, reopenCanvasGuarded } from '../canvas/canvas-completion'
import { logInfo } from '../debug-logger'
import {
  MAX_NOTE_CHARS,
  MAX_NOTE_IMAGES,
  MAX_SKETCH_SCENE_BYTES,
  MAX_SKETCH_SCENE_ELEMENTS,
  artifactPhaseOf,
  artifactRuns,
  type CanvasLibraryEntry,
} from '../../shared/canvas'
import { resolveCanvasSnapshot, setSnapshotSender } from '../canvas/canvas-snapshot-broker'
import {
  canvasCwdForSession,
  installCanvasSessionLink,
  listReclaimableCanvases,
  reclaimCanvasForSession,
} from '../canvas/canvas-session-link'

/** How many canvases NOT belonging to the asking session get a review-count
 *  read per library open. Their own are always counted; the rest are a courtesy
 *  and must not turn one click into a hundred synchronous file reads. */
const MAX_REVIEW_SWEEP = 20

/**
 * The DERIVED phase of a canvas's most recent artefact, for the Library row.
 *
 * Composed here for the same reason the counts are: `artifactPhaseOf` needs the
 * versions (canvas store) and the rounds (review store), and this handler is the
 * one place that already holds both. Undefined when either side cannot be read —
 * a row with no phase renders without one, never as "settled".
 */
function latestArtifactPhase(canvasId: string): CanvasLibraryEntry['phase'] {
  const canvas = getCanvasStateById(canvasId)
  if (!canvas) return undefined
  // The latest LIVE run. `artifactRuns` breaks a run on the archive flip, so
  // the last run is often an ARCHIVED one — the artefacts the user has
  // deliberately tucked away — and reporting its phase would make the Library
  // row describe something the user has already put down.
  const runs = artifactRuns(canvas.versions).filter((r) => !r[0]?.archived)
  const run = runs[runs.length - 1]
  if (!run) return undefined
  const snapshot = getReviewSnapshotForCanvas(canvasId)
  return artifactPhaseOf(run, snapshot?.reviews ?? [], snapshot?.annotations ?? []).kind
}

/**
 * W2 — a USER APPROVAL auto-completes the artefact when nothing is owed anywhere
 * on the canvas.
 *
 * The gesture the old model made the user perform twice: approve the version,
 * then hunt for a Mark complete button that was disabled anyway. An approval
 * over a canvas with nothing outstanding IS the sign-off, so it is recorded as
 * one (`completed: { by: 'user' }`) and the existing `canvas:changed
 * { completed: true }` push returns the pane to its front page.
 *
 * A REFUSAL IS NOT AN ERROR. Another artefact on the same canvas may still be
 * mid-flight, or a draft note may be half-written — perfectly ordinary states —
 * so the refusal is logged at info and the caller returns its own result. The
 * user's approval landed either way.
 *
 * NEVER reachable from an MCP path: `canvas_version_verdict` stamps 'agent-chat'
 * and does not come through here, which is what keeps an agent from
 * self-approving and self-completing in one turn.
 */
function autoCompleteAfterUserApproval(canvasId: string, sessionId: string): void {
  try {
    const result = completeCanvasGuarded(canvasId, 'user', sessionId)
    if ('error' in result) logInfo(`[canvas] approval did not complete ${canvasId}: ${result.error}`)
  } catch (err) {
    logInfo(`[canvas] auto-complete failed for ${canvasId}: ${err}`)
  }
}

// ---------------------------------------------------------------------------
// Bounds + Zod schemas
// ---------------------------------------------------------------------------

/** Session ids are app-minted (randomId → 24 hex); the bound is defensive. */
const sessionIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)

/** Design documents are single-file mockups; 2 MB of HTML is far beyond any
 *  real one and small enough to move over IPC without a hiccup. */
const DESIGN_HTML_MAX = 2 * 1024 * 1024

/** The canvas's SUBJECT, as the shared `CanvasRenderSource` type already
 *  declares it. Free text: the store re-cleans it (`sanitizeCanvasTitle` —
 *  control/format/bidi stripped, 80 code points) and decides from it whether
 *  a render is a new version or a new canvas. The MCP tool has always carried
 *  it; this dev/test ingress silently dropped it, so a renderer-driven render
 *  could never start a second subject. */
const titleSchema = z.string().max(200).optional()

const renderSourceSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('design'),
      html: z.string().min(1).max(DESIGN_HTML_MAX),
      title: titleSchema,
      ready: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      mode: z.literal('uat'),
      distRoot: z.string().min(1).max(1024),
      entry: z.string().min(1).max(512).optional(),
      buildLabel: z.string().max(120).optional(),
      title: titleSchema,
      ready: z.boolean().optional(),
    })
    .strict(),
])

const getStateSchema = z.object({ sessionId: sessionIdSchema }).strict()

/**
 * The tiles the user currently has open, as the renderer sees them.
 *
 * Optional and bounded. It can only make MORE sessions count as "still here",
 * so a missing or bogus id costs a candidate that would have been offered — it
 * can never make an unavailable canvas takeable. That is what makes accepting
 * it from the renderer safe.
 */
const openTileSessionIdsSchema = z.array(sessionIdSchema).max(256).optional()

const listReclaimableSchema = z
  .object({ sessionId: sessionIdSchema, openTileSessionIds: openTileSessionIdsSchema })
  .strict()

/** The library is a pure read; listing never binds anything, so the session id
 *  here is not an ownership question. It scopes the list to the PROJECT the
 *  session is in, because a library mixing every project's mockups together is
 *  unreadable. openTileSessionIds only marks which rows are on screen right now
 *  so the UI can warn before deleting one. */
const listAllSchema = z
  .object({ openTileSessionIds: openTileSessionIdsSchema, sessionId: sessionIdSchema.optional() })
  .strict()

/** Delete takes an ID and nothing else — never a path. Same charset bound as
 *  reclaim: app-minted ids only, so a caller cannot name anything outside the
 *  canvas store even before the store re-checks and realpath-confirms it. */
const deleteCanvasSchema = z
  .object({ canvasId: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/) })
  .strict()

/** Archive/unarchive one artifact (item C, phase 5): the canvas it is on, one
 *  of its version ids, and the target state. Reversible; the store re-checks
 *  everything and no-ops safely on a stranger id. */
const artifactArchiveSchema = z
  .object({
    canvasId: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
    versionId: z.string().regex(/^v[0-9]{1,9}$/),
    archived: z.boolean(),
  })
  .strict()

/** Permanently delete one artifact (item C, phase 5). Same id shapes; the store
 *  applies the path discipline and refuses the canvas's only artifact. */
const artifactDeleteSchema = z
  .object({
    canvasId: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
    versionId: z.string().regex(/^v[0-9]{1,9}$/),
  })
  .strict()

/** Sign the subject off (#476): the acting session and the canvas it owns.
 *  The guard module refuses while anything is owed; ownership is re-checked
 *  in the store against the record itself. */
const canvasCompleteSchema = z
  .object({
    sessionId: sessionIdSchema,
    canvasId: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
  })
  .strict()

/** Reopen a completed canvas (#476). Same shapes; only ever restores work. */
const canvasCompleteReopenSchema = z
  .object({
    sessionId: sessionIdSchema,
    canvasId: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
  })
  .strict()

/** Canvas ids are app-minted (see CANVAS_ID_RE); bounded here at the seam. */
const reclaimSchema = z
  .object({
    sessionId: sessionIdSchema,
    canvasId: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/),
    openTileSessionIds: openTileSessionIdsSchema,
  })
  .strict()

const renderSchema = z
  .object({
    sessionId: sessionIdSchema,
    source: renderSourceSchema,
  })
  .strict()

const setActiveVersionSchema = z
  .object({
    sessionId: sessionIdSchema,
    versionId: z.string().regex(/^v[0-9]{1,9}$/),
  })
  .strict()

// ── P3: reviews & annotations ───────────────────────────────────────────────
// The store re-validates everything (it is the single mutation point and the
// MCP tool reads through it); these schemas are the transport's own bound so a
// malformed renderer payload dies at the boundary with a parse error, not a
// store throw.

const versionIdSchema = z.string().regex(/^v[0-9]{1,9}$/)
const annotationIdSchema = z.string().regex(/^a[0-9]{1,9}$/)
const reviewIdSchema = z.string().regex(/^R[0-9]{1,9}$/)

const rectSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().min(0),
    height: z.number().finite().min(0),
  })
  .strict()

const anchorRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ux-id'), id: z.string().min(1).max(512) }).strict(),
  z
    .object({
      kind: z.literal('fingerprint'),
      role: z.string().max(512),
      name: z.string().max(512),
      ancestorPath: z.string().max(512),
      ordinal: z.number().int().min(0).max(1_000_000),
    })
    .strict(),
])

const focusSchema = z
  .object({
    targets: z.array(anchorRefSchema).max(8),
    bboxPage: rectSchema,
    label: z.string().max(120),
    versionId: versionIdSchema,
  })
  .strict()

const sketchMetaSchema = z
  .object({
    excalidrawElementIds: z.array(z.string().min(1).max(128)).min(1).max(100),
    bboxPage: rectSchema,
  })
  .strict()

/** Base64 of ONE attachment PNG: 4 chars per 3 bytes, plus padding slack. The
 *  store re-measures in BYTES after decoding, which is the real bound. */
const attachmentBase64Schema = z.string().min(8).max(Math.ceil(MAX_SKETCH_PNG_BYTES / 3) * 4 + 8)

/**
 * The images riding a note save, in order (W15).
 *
 * Three forms because the renderer holds BYTES only for a fresh paste; for
 * anything already persisted it holds a POSITION — `fromComposer` into the
 * persisted composer draft, `fromNote` into the note's own current list. The
 * store resolves both against what is actually on disk and refuses a dangling
 * index; the indices are bounded here so a hostile one never reaches it.
 */
const draftImageSchema = z.union([
  z.object({ pngBase64: attachmentBase64Schema }).strict(),
  z.object({ fromComposer: z.number().int().min(0).max(MAX_NOTE_IMAGES - 1) }).strict(),
  z.object({ fromNote: z.number().int().min(0).max(MAX_NOTE_IMAGES - 1) }).strict(),
])

const annotationDraftSchema = z
  .object({
    annotationId: annotationIdSchema.optional(),
    scope: z.enum(['element', 'region', 'general']),
    // min(0): empty text is legal ONLY when an attachment is the note — the
    // store is the gate (validateDraft), this schema only bounds the shape.
    note: z.string().min(0).max(MAX_NOTE_CHARS),
    focus: focusSchema.optional(),
    sketch: sketchMetaSchema.optional(),
    images: z.array(draftImageSchema).max(MAX_NOTE_IMAGES).optional(),
    versionId: versionIdSchema,
  })
  .strict()

/**
 * The persisted composer (W14).
 *
 * `'keep'` is positional — "the image already at this index" — so a debounced
 * save costs no bytes for images the renderer stopped holding. The sketch scene
 * is OPAQUE: bounded in bytes here and never parsed anywhere in main, exactly
 * like the note text. The element→version stamps are bounded in count and each
 * value must be a store-minted version id, so the map cannot become a general
 * key/value store riding on the review record.
 */
const composerDraftSchema = z
  .object({
    versionId: versionIdSchema,
    decision: z.enum(['approve', 'reject']).optional(),
    text: z.string().min(0).max(MAX_NOTE_CHARS),
    focus: focusSchema.optional(),
    images: z
      .array(
        z.union([
          z.literal('keep'),
          z.object({ keepIndex: z.number().int().min(0).max(MAX_NOTE_IMAGES - 1) }).strict(),
          z.object({ pngBase64: attachmentBase64Schema }).strict(),
        ]),
      )
      .max(MAX_NOTE_IMAGES),
    sketch: z
      .object({
        scene: z.string().max(MAX_SKETCH_SCENE_BYTES),
        // Bounded in KEY COUNT as well as in value shape. Without a count the
        // map is an unbounded key/value store riding on the review record: the
        // scene has a byte cap, the stamps had none, so a caller could send one
        // element of scene and a million stamps.
        versions: z
          .record(z.string().min(1).max(128), versionIdSchema)
          .refine((v) => Object.keys(v).length <= MAX_SKETCH_SCENE_ELEMENTS, {
            message: `at most ${MAX_SKETCH_SCENE_ELEMENTS} drawing elements`,
          }),
      })
      .strict()
      .optional(),
  })
  .strict()

const reviewGetStateSchema = z.object({ sessionId: sessionIdSchema }).strict()

const annotationUpsertSchema = z.object({ sessionId: sessionIdSchema, draft: annotationDraftSchema }).strict()

const annotationDeleteSchema = z.object({ sessionId: sessionIdSchema, annotationId: annotationIdSchema }).strict()

/** Base64 of a sketch-export PNG — the same bound every attachment gets. */
const sketchPngBase64Schema = attachmentBase64Schema

const reviewSubmitSchema = z
  .object({
    sessionId: sessionIdSchema,
    reviewId: reviewIdSchema,
    sketches: z
      .array(z.object({ annotationId: annotationIdSchema, pngBase64: sketchPngBase64Schema }).strict())
      .max(100),
    /** The decision this submit carries. REQUIRED (the settled machine): the
     *  user's word is version-level, and a submit with no decision is the shape
     *  that produced rounds nobody could close. */
    decision: z.enum(['approve', 'reject']),
  })
  .strict()

/**
 * A zero-note verdict (the plain Approve, a Reject, or a Dismiss) — no review
 * record involved, just the version's outcome.
 *
 * A REJECTION carries a note or it is refused, here and again in the store.
 * "Rejected" with nothing said is a decision the agent cannot act on and a
 * History row that explains nothing, and — because a reject settles every
 * earlier round of the artefact — it would close the user's own outstanding
 * feedback while saying why to nobody.
 */
const versionVerdictSchema = z
  .object({
    sessionId: sessionIdSchema,
    versionId: z.string().regex(/^v[0-9]{1,9}$/).optional(),
    state: z.enum(['approved', 'rejected', 'dismissed']),
    note: z.string().max(4000).optional(),
  })
  .strict()
  .refine((v) => v.state !== 'rejected' || (v.note?.trim().length ?? 0) > 0, {
    message: 'a rejection needs a note — say what is wrong',
    path: ['note'],
  })

const versionReopenSchema = z
  .object({
    sessionId: sessionIdSchema,
    versionId: z.string().regex(/^v[0-9]{1,9}$/),
  })
  .strict()

/** The canvas a renderer call was composed against. Same charset bound as the
 *  library's close-out id. Required, not optional: a call that cannot say which
 *  canvas it meant is exactly the one the mismatch check exists to refuse. */
const canvasIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/)

/** The composer draft's own envelope. Names the canvas for the same reason
 *  mark-seen does — and here it is load-bearing rather than defensive: the
 *  payload is the user's unsent words, so answering (or accepting) one for a
 *  canvas this session does not own would be both a leak and a way to plant
 *  text in somebody else's composer. The store re-checks it. */
const composerDraftSetSchema = z
  .object({ sessionId: sessionIdSchema, canvasId: canvasIdSchema, draft: composerDraftSchema })
  .strict()

const composerDraftClearSchema = z.object({ sessionId: sessionIdSchema, canvasId: canvasIdSchema }).strict()

/** The user puts a whole settled ROUND back in play. Names the canvas it was
 *  composed against for the same reason mark-seen does: review ids are ordinals
 *  within whichever canvas is active right now. */
const reviewReopenSchema = z
  .object({ sessionId: sessionIdSchema, canvasId: canvasIdSchema, reviewId: reviewIdSchema })
  .strict()

/** "The user has these addressed notes on screen." The release side of the
 *  close-out barrier, and renderer-only by construction: there is no MCP tool
 *  that reaches this channel. */
const reviewMarkSeenSchema = z
  .object({
    sessionId: sessionIdSchema,
    canvasId: canvasIdSchema,
    annotationIds: z.array(annotationIdSchema).max(500),
  })
  .strict()

const annotationReopenSchema = z.object({ sessionId: sessionIdSchema, annotationId: annotationIdSchema }).strict()

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerCanvasHandlers(getWindow: () => BrowserWindow | null): void {
  // Continuity glue: canvas records get stamped with each session's cwd +
  // conversation so adoption (canvas-session-link) can move a canvas to the
  // session that carries the same work after a restart.
  installCanvasSessionLink()

  ipcMain.handle(IPC.CANVAS_GET_STATE, async (_e, args: unknown) => {
    const { sessionId } = getStateSchema.parse(args)
    // Read-shaped and read-only. An earlier cut ran canvas adoption from here;
    // a GET that can transfer ownership of the user's review notes is the
    // wrong shape for the operation as well as the wrong authorization model.
    return getCanvasStateForSession(sessionId)
  })

  // What this session could reclaim, for the user to choose from. Pure read.
  ipcMain.handle(IPC.CANVAS_LIST_RECLAIMABLE, async (_e, args: unknown) => {
    const { sessionId, openTileSessionIds } = listReclaimableSchema.parse(args)
    return listReclaimableCanvases(sessionId, openTileSessionIds ?? [])
  })

  // The ONLY path that moves a canvas between sessions, and it exists because
  // the user clicked the canvas they want back.
  ipcMain.handle(IPC.CANVAS_RECLAIM, async (_e, args: unknown) => {
    const { sessionId, canvasId, openTileSessionIds } = reclaimSchema.parse(args)
    const ok = reclaimCanvasForSession(sessionId, canvasId, openTileSessionIds ?? [])
    return { ok, state: getCanvasStateForSession(sessionId) }
  })

  // The library. Pure read over every canvas on disk; listing one never binds
  // it to anything.
  ipcMain.handle(IPC.CANVAS_LIST_ALL, async (_e, args: unknown) => {
    const { openTileSessionIds, sessionId } = listAllSchema.parse(args ?? {})
    // Scope to the asking session's project. Resolved HERE from main's own spawn
    // record rather than accepted from the renderer, so the caller cannot ask to
    // see another project's list by naming its path.
    const cwd = sessionId ? canvasCwdForSession(sessionId) : undefined
    const entries = listAllCanvases(openTileSessionIds ?? [], cwd, sessionId)
    // What is outstanding on each, joined HERE: the review store imports the
    // canvas store, so the reverse import would be a cycle, and this handler
    // already holds both (same reason the delete handler drops reviews here).
    //
    // Bounded on purpose. Every miss is a synchronous read + full validation, so
    // the sweep covers the rows a user actually acts on -- their own canvases,
    // and the head of the rest -- and everything past that renders without a
    // count rather than turning one library open into a hundred file reads.
    let swept = 0
    for (const e of entries) {
      const isMine = e.ownedByThisSession || e.isActiveForThisSession
      if (!isMine && swept >= MAX_REVIEW_SWEEP) continue
      if (!isMine) swept++
      const counts = getReviewCountsForCanvas(e.canvasId)
      // Left UNDEFINED, never zeroed, when the store is unreadable: "nothing
      // outstanding" and "could not tell" must not look the same in the UI.
      if (!counts) continue
      e.openReviewCount = counts.openReviewIds.length
      e.draftNoteCount = counts.draftNotes
      // LIVE rounds — the owed term the settled machine derives everything from.
      // Left undefined with the others when the store is unreadable.
      e.liveRoundCount = counts.liveRounds
      // Rounds waiting on the user's verdicts — the queue's second input
      // (#364). Same sweep bound and same undefined-when-unreadable rule.
      e.verdictRounds = counts.verdictRounds
      // The DERIVED phase of the row's most recent artefact, computed once here
      // so the Library's owed-text and the pane's status line are one answer.
      e.phase = latestArtifactPhase(e.canvasId)
    }
    return entries
  })

  // The only destructive canvas operation, and it exists because the user
  // clicked delete on a specific row.
  ipcMain.handle(IPC.CANVAS_DELETE, async (_e, args: unknown) => {
    const { canvasId } = deleteCanvasSchema.parse(args)
    const ok = deleteCanvas(canvasId)
    // The review store keys off canvasId and its reviews.json lived inside the
    // directory just removed, so its in-memory entry has to go too. Done here
    // rather than inside deleteCanvas because the review store imports the
    // canvas store — this handler is the one place that already holds both.
    if (ok) dropReviewsForCanvas(canvasId)
    return { ok }
  })

  ipcMain.handle(IPC.CANVAS_RENDER, async (_e, args: unknown) => {
    const { sessionId, source } = renderSchema.parse(args)
    const result = renderVersion(sessionId, source)
    // C1: a ready render auto-superseded the previously open version — settle
    // its notes here, the one place that already holds both stores (the same
    // reason dropReviewsForCanvas lives in this file).
    if (result.superseded?.length) settleReviewsForSupersededVersions(result.canvasId, result.superseded)
    return result
  })

  // The zero-note verdict — the plain Approve, a Reject, or a Dismiss — and
  // THE COMPOSITION the settled machine hangs on. Renderer-only: the agent's
  // mouth is the MCP canvas_version_verdict tool, which stamps 'agent-chat' and
  // deliberately reaches none of this (A2 — a relayed verdict settles nothing
  // and completes nothing).
  //
  // Three steps, in this order, and only here because only this file holds both
  // stores:
  //   1. stamp the verdict;
  //   2. an approve or a reject SETTLES that artefact's earlier rounds (W4) —
  //      the user's newest word is their authoritative statement of what is
  //      still wrong. A `dismissed` settles nothing: "I am not looking at this"
  //      says nothing about the feedback beneath it;
  //   3. an approve then tries the AUTO-COMPLETE (W2). A refusal there is not
  //      an error — it means something is still owed elsewhere on the canvas,
  //      which is a perfectly ordinary state — so it is logged and the verdict
  //      is returned as the result.
  ipcMain.handle(IPC.CANVAS_VERSION_VERDICT, async (_e, args: unknown) => {
    const { sessionId, versionId, state, note } = versionVerdictSchema.parse(args)
    // Resolved BEFORE the write: afterwards the version is decided and is no
    // longer "the open one", so the settle would have nothing to key on.
    const target = verdictTargetVersionId(sessionId, versionId)
    const result = setVersionVerdict(sessionId, versionId, { state, ...(note ? { note } : {}) }, 'user')
    if ('error' in result) return result
    if (target && (state === 'approved' || state === 'rejected')) {
      settleRoundsForUserDecision(result.canvasId, target)
    }
    if (state === 'approved') autoCompleteAfterUserApproval(result.canvasId, sessionId)
    return result
  })

  ipcMain.handle(IPC.CANVAS_VERSION_REOPEN, async (_e, args: unknown) => {
    const { sessionId, versionId } = versionReopenSchema.parse(args)
    const result = reopenVersionForReview(sessionId, versionId, 'user')
    if ('error' in result) return result
    if (result.withdrawn.length) settleReviewsForSupersededVersions(result.state.canvasId, result.withdrawn)
    return result.state
  })

  // Archive/unarchive one artifact (item C, phase 5). Reversible: it only moves
  // the artifact into (or out of) the muted Archived history group. Returns the
  // updated state so the pane reflects it without waiting for the change push.
  ipcMain.handle(IPC.CANVAS_ARCHIVE_ARTIFACT, async (_e, args: unknown) => {
    const { canvasId, versionId, archived } = artifactArchiveSchema.parse(args)
    const state = setArtifactArchived(canvasId, versionId, archived)
    return { ok: state !== null, state }
  })

  // Permanently delete one artifact: its versions, their files, and their review
  // notes. Two stores: the canvas store removes the versions (and returns their
  // ids), then the review store drops the notes anchored to them — the same
  // two-store shape CANVAS_DELETE uses for dropReviewsForCanvas. The review drop
  // only runs on a successful version delete, so a refused delete never clears a
  // note.
  ipcMain.handle(IPC.CANVAS_DELETE_ARTIFACT, async (_e, args: unknown) => {
    const { canvasId, versionId } = artifactDeleteSchema.parse(args)
    const result = deleteArtifact(canvasId, versionId)
    if (!result.ok) return { ok: false as const, reason: result.reason }
    const notesDeleted = deleteAnnotationsForVersions(canvasId, result.deletedVersionIds)
    return { ok: true as const, deletedVersions: result.deletedVersionIds.length, notesDeleted: notesDeleted ?? 0 }
  })

  ipcMain.handle(IPC.CANVAS_SET_ACTIVE_VERSION, async (_e, args: unknown) => {
    const { sessionId, versionId } = setActiveVersionSchema.parse(args)
    return setActiveVersion(sessionId, versionId)
  })

  ipcMain.handle(IPC.CANVAS_REVIEW_GET_STATE, async (_e, args: unknown) => {
    const { sessionId } = reviewGetStateSchema.parse(args)
    return getReviewStateForSession(sessionId)
  })

  ipcMain.handle(IPC.CANVAS_ANNOTATION_UPSERT, async (_e, args: unknown) => {
    const { sessionId, draft } = annotationUpsertSchema.parse(args)
    return upsertAnnotation(sessionId, draft)
  })

  ipcMain.handle(IPC.CANVAS_ANNOTATION_DELETE, async (_e, args: unknown) => {
    const { sessionId, annotationId } = annotationDeleteSchema.parse(args)
    return deleteAnnotation(sessionId, annotationId)
  })

  ipcMain.handle(IPC.CANVAS_REVIEW_SUBMIT, async (_e, args: unknown) => {
    const { sessionId, reviewId, sketches, decision } = reviewSubmitSchema.parse(args)
    const state = submitReview(sessionId, reviewId, sketches, decision)
    // The submit-with-notes half of the auto-complete (W2). The store already
    // settled the earlier rounds and turned this round's notes into
    // observations; if that left nothing owed anywhere, an approval signs the
    // subject off and the pane returns to its front page.
    if (decision === 'approve') autoCompleteAfterUserApproval(state.canvasId, sessionId)
    return state
  })

  // The USER puts a settled ROUND back in play — with the per-note reopen
  // below, the ONLY two writes that may move a round `resolved -> submitted`.
  ipcMain.handle(IPC.CANVAS_REVIEW_REOPEN, async (_e, args: unknown) => {
    const { sessionId, canvasId, reviewId } = reviewReopenSchema.parse(args)
    return reopenReview(sessionId, canvasId, reviewId)
  })

  // The user's eyes on an addressed round — the one input to the close-out
  // barrier that no agent can produce. Renderer-only: the MCP surface has no
  // path here, and must never be given one.
  ipcMain.handle(IPC.CANVAS_REVIEW_MARK_SEEN, async (_e, args: unknown) => {
    const { sessionId, canvasId, annotationIds } = reviewMarkSeenSchema.parse(args)
    return markAddressedNotesSeen(sessionId, canvasId, annotationIds)
  })

  // THE HALF-WRITTEN NOTE, PERSISTED (W14). Before this, the composer lived
  // only in React state, so switching to the terminal and back threw away the
  // note, the target, the pasted screenshots and the drawing without asking.
  // Renderer-only and owner-scoped: no MCP tool reaches this channel, and the
  // store refuses a canvas this session does not hold.
  ipcMain.handle(IPC.CANVAS_COMPOSER_DRAFT_SET, async (_e, args: unknown) => {
    const { sessionId, canvasId, draft } = composerDraftSetSchema.parse(args)
    return setComposerDraft(sessionId, canvasId, draft)
  })

  ipcMain.handle(IPC.CANVAS_COMPOSER_DRAFT_CLEAR, async (_e, args: unknown) => {
    const { sessionId, canvasId } = composerDraftClearSchema.parse(args)
    return clearComposerDraft(sessionId, canvasId)
  })

  // The undo half of close-out. Cheap and one click away, which is what makes
  // a bulk close safe to offer at all.
  ipcMain.handle(IPC.CANVAS_ANNOTATION_REOPEN, async (_e, args: unknown) => {
    const { sessionId, annotationId } = annotationReopenSchema.parse(args)
    return reopenAnnotation(sessionId, annotationId)
  })

  // Sign the subject off (#476). The guard module owns the "nothing left owed
  // either way" rule (drafts, open notes, verdicts) and fails closed on an
  // unreadable review store; the canvas store re-checks ownership against the
  // record itself. Detaches the canvas as the session's current one, so the
  // pane falls back to its front page.
  ipcMain.handle(IPC.CANVAS_COMPLETE, async (_e, args: unknown) => {
    const { sessionId, canvasId } = canvasCompleteSchema.parse(args)
    const result = completeCanvasGuarded(canvasId, 'user', sessionId)
    return 'error' in result ? { ok: false as const, reason: result.error } : { ok: true as const, state: result }
  })

  // MARK COMPLETE IS NEVER DEAD (W3): the user force-closes what is still owed
  // and signs the subject off. USER-only by construction — `completeCanvasGuarded`
  // honours `force` only for `by: 'user'`, and there is no MCP path to this
  // channel — so `canvas_complete` keeps every refusal it has.
  ipcMain.handle(IPC.CANVAS_COMPLETE_FORCE, async (_e, args: unknown) => {
    const { sessionId, canvasId } = canvasCompleteSchema.parse(args)
    const result = completeCanvasGuarded(canvasId, 'user', sessionId, { force: true })
    return 'error' in result ? { ok: false as const, reason: result.error } : { ok: true as const, state: result }
  })

  // What that force WOULD close, so the armed confirm names it before the user
  // commits. Pure read — and OWNER-ONLY: these tallies are the canvas's private
  // review state, so answering them to a foreign session would be an oracle for
  // exactly what `canvas:completeForce` refuses to act on. Null for a stranger.
  ipcMain.handle(IPC.CANVAS_DESCRIBE_FORCE_CLOSURES, async (_e, args: unknown) => {
    const { sessionId, canvasId } = canvasCompleteSchema.parse(args)
    return describeForceClosures(canvasId, sessionId)
  })

  // The undo half (#476): clears the stamp, restores obligations, and rebinds
  // the canvas as current when the owner session shows nothing else.
  ipcMain.handle(IPC.CANVAS_COMPLETE_REOPEN, async (_e, args: unknown) => {
    const { sessionId, canvasId } = canvasCompleteReopenSchema.parse(args)
    const result = reopenCanvasGuarded(canvasId, sessionId)
    return 'error' in result ? { ok: false as const, reason: result.error } : { ok: true as const, state: result }
  })

  onReviewChanged((event) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send(IPC.CANVAS_REVIEW_CHANGED, event)
      } catch {
        /* window gone */
      }
    }
  })

  onCanvasChanged((event) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      try {
        win.webContents.send(IPC.CANVAS_CHANGED, event)
      } catch {
        /* window gone */
      }
    }
  })

  // Snapshot capture is the one main → renderer REQUEST in the app: the page
  // only exists in the renderer's frame, so the MCP tool has to ask for it. The
  // broker owns correlation and the timeout; this just moves bytes.
  setSnapshotSender((event) => {
    const win = getWindow()
    if (!win || win.isDestroyed()) return false
    try {
      win.webContents.send(IPC.CANVAS_SNAPSHOT_REQUEST, event)
      return true
    } catch {
      return false
    }
  })

  ipcMain.on(IPC.CANVAS_SNAPSHOT_RESULT, (_e, reply: unknown) => {
    resolveCanvasSnapshot(reply)
  })
}
