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
  clearAwaitingReview,
  deleteCanvas,
  getCanvasStateForSession,
  listAllCanvases,
  onCanvasChanged,
  renderVersion,
  setActiveVersion,
} from '../canvas/canvas-store'
import {
  MAX_SKETCH_PNG_BYTES,
  closeOutCanvasReviews,
  deleteAnnotation,
  dropReviewsForCanvas,
  getReviewCountsForCanvas,
  getReviewStateForSession,
  markAddressedNotesSeen,
  onReviewChanged,
  reopenAnnotation,
  resolveAnnotation,
  submitReview,
  upsertAnnotation,
} from '../canvas/canvas-review-store'
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
  z.object({ kind: z.literal('plan-step'), id: z.string().min(1).max(512) }).strict(),
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

const annotationDraftSchema = z
  .object({
    annotationId: annotationIdSchema.optional(),
    scope: z.enum(['element', 'region', 'general']),
    // min(0): empty text is legal ONLY beside a pasted image — the store is
    // the gate (validateDraft), this schema only bounds the shape.
    note: z.string().min(0).max(4000),
    focus: focusSchema.optional(),
    sketch: sketchMetaSchema.optional(),
    // A pasted screenshot riding the save: fresh bytes, or 'keep' for an
    // existing one the renderer no longer holds. Base64 bound reuses the
    // sketch cap (declared below; hoisted const).
    image: z
      .union([z.literal('keep'), z.object({ pngBase64: z.string().min(8).max(Math.ceil(MAX_SKETCH_PNG_BYTES / 3) * 4 + 8) }).strict()])
      .optional(),
    versionId: versionIdSchema,
  })
  .strict()

const reviewGetStateSchema = z.object({ sessionId: sessionIdSchema }).strict()

const annotationUpsertSchema = z.object({ sessionId: sessionIdSchema, draft: annotationDraftSchema }).strict()

const annotationDeleteSchema = z.object({ sessionId: sessionIdSchema, annotationId: annotationIdSchema }).strict()

/** Base64 of a PNG capped at MAX_SKETCH_PNG_BYTES: 4 chars per 3 bytes, plus
 *  padding slack. The store re-measures in BYTES after decoding. */
const sketchPngBase64Schema = z.string().min(8).max(Math.ceil(MAX_SKETCH_PNG_BYTES / 3) * 4 + 8)

const reviewSubmitSchema = z
  .object({
    sessionId: sessionIdSchema,
    reviewId: reviewIdSchema,
    sketches: z
      .array(z.object({ annotationId: annotationIdSchema, pngBase64: sketchPngBase64Schema }).strict())
      .max(100),
  })
  .strict()

/** The canvas a renderer call was composed against. Same charset bound as the
 *  library's close-out id. Required, not optional: a call that cannot say which
 *  canvas it meant is exactly the one the mismatch check exists to refuse. */
const canvasIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/)

const annotationResolveSchema = z
  .object({
    sessionId: sessionIdSchema,
    // The canvas the panel had on screen when the user clicked. The store
    // refuses the call if the session has since moved to another canvas —
    // annotation ids restart at a1 on every one, so without it a verdict aimed
    // at the round the user was reading can land on a stranger's note.
    canvasId: canvasIdSchema,
    annotationId: annotationIdSchema,
    // 'stale' is the close-out verdict: the work shipped, so the note is no
    // longer live. Deliberately distinct from 'approve' — the user is saying
    // "this went out", not "I checked it and it is right".
    action: z.enum(['approve', 'dismiss', 'reannotate', 'stale']),
    // Which of the note's offered alternatives the user is approving. Rides an
    // approval only — the store throws on any other action — and must name a
    // variant that exists on the note.
    variantKey: z
      .string()
      .regex(/^[A-D]$/)
      .optional(),
  })
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

/** The library's bulk close-out. Takes a canvas ID and nothing else — same
 *  charset bound as delete, and like delete it is keyed by canvas rather than
 *  session because the library shows the whole project, including canvases
 *  owned by sessions that have since closed. Clearing notes is housekeeping: it
 *  never moves ownership, and it never removes a file. */
const reviewCloseOutSchema = z
  .object({ canvasId: z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/) })
  .strict()

/** Dismiss-all sweeps the ASKING session's own canvases. The tile list feeds
 *  the same library read `canvas:listAll` uses and can only mark rows as
 *  on-screen — it can never widen the sweep beyond rows owned by (or active
 *  for) sessionId, and the project scope is resolved in main from the session
 *  id, never accepted as a path. */
const reviewDismissAllSchema = z
  .object({ sessionId: sessionIdSchema, openTileSessionIds: openTileSessionIdsSchema })
  .strict()

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
      // What a bulk close-out on this row would ACTUALLY clear. The store
      // computes it with the same per-review gate the mutation applies, so the
      // button's label and the button's effect cannot disagree. Left undefined
      // with the other two when the store is unreadable.
      e.closeableNoteCount = counts.closeableNotes
      // Rounds waiting on the user's verdicts — the queue's second input
      // (#364). Same sweep bound and same undefined-when-unreadable rule.
      e.verdictRounds = counts.verdictRounds
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
    return renderVersion(sessionId, source)
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
    const { sessionId, reviewId, sketches } = reviewSubmitSchema.parse(args)
    return submitReview(sessionId, reviewId, sketches)
  })

  ipcMain.handle(IPC.CANVAS_ANNOTATION_RESOLVE, async (_e, args: unknown) => {
    const { sessionId, canvasId, annotationId, action, variantKey } = annotationResolveSchema.parse(args)
    return resolveAnnotation(sessionId, annotationId, action, canvasId, variantKey)
  })

  // The user's eyes on an addressed round — the one input to the close-out
  // barrier that no agent can produce. Renderer-only: the MCP surface has no
  // path here, and must never be given one.
  ipcMain.handle(IPC.CANVAS_REVIEW_MARK_SEEN, async (_e, args: unknown) => {
    const { sessionId, canvasId, annotationIds } = reviewMarkSeenSchema.parse(args)
    return markAddressedNotesSeen(sessionId, canvasId, annotationIds)
  })

  // The undo half of close-out. Cheap and one click away, which is what makes
  // a bulk close safe to offer at all.
  ipcMain.handle(IPC.CANVAS_ANNOTATION_REOPEN, async (_e, args: unknown) => {
    const { sessionId, annotationId } = annotationReopenSchema.parse(args)
    return reopenAnnotation(sessionId, annotationId)
  })

  // "The work on this canvas shipped — clear its notes." Clears, never deletes:
  // the canvas, its versions and every note's text stay exactly where they are,
  // and each cleared note keeps a Reopen.
  ipcMain.handle(IPC.CANVAS_REVIEW_CLOSE_OUT, async (_e, args: unknown) => {
    const { canvasId } = reviewCloseOutSchema.parse(args)
    const result = closeOutCanvasReviews(canvasId)
    // null is "could not read the store", which must not render as "cleared 0".
    if (!result) return { ok: false as const }
    return { ok: true as const, closed: result.closed, reviews: result.reviews }
  })

  // "Clear my whole canvas queue" — the Canvas button's right-click. One sweep
  // over exactly the rows the queue number counts (owned by or active for this
  // session, per totalsFromEntries): rounds already waiting on the user close
  // out per canvas, and a ready-marked render still awaiting its first review
  // stops being owed. Scope is resolved HERE (cwd from main's own spawn
  // record), so the renderer cannot aim the sweep at another project, and a
  // canvas some other session owns is never touched. Composed from the two
  // existing user-driven mutations rather than a new store path — this handler
  // is the one place that already holds both stores (same reason listAll joins
  // counts here).
  ipcMain.handle(IPC.CANVAS_REVIEW_DISMISS_ALL, async (_e, args: unknown) => {
    const { sessionId, openTileSessionIds } = reviewDismissAllSchema.parse(args)
    const cwd = canvasCwdForSession(sessionId)
    const entries = listAllCanvases(openTileSessionIds ?? [], cwd, sessionId)
    let closedNotes = 0
    let closedReviews = 0
    let clearedAwaiting = 0
    let unreadable = 0
    for (const e of entries) {
      if (!e.ownedByThisSession && !e.isActiveForThisSession) continue
      // Same blunt rule the queue's own `unknown` uses: an owned row is always
      // swept, so an undefined count means the review store could not be read
      // — reported, never presented as "nothing to clear".
      if (e.openReviewCount === undefined) unreadable++
      // Close out only where the label counted work (verdictRounds > 0), so
      // the gesture clears precisely what the number promised.
      if (e.verdictRounds && e.verdictRounds > 0) {
        const res = closeOutCanvasReviews(e.canvasId)
        if (res) {
          closedNotes += res.closed
          closedReviews += res.reviews.length
        }
      }
      if (e.awaitingReview) {
        clearAwaitingReview(e.canvasId)
        clearedAwaiting++
      }
    }
    return { closedNotes, closedReviews, clearedAwaiting, unreadable }
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
