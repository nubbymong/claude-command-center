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
  deleteCanvas,
  getCanvasStateForSession,
  listAllCanvases,
  onCanvasChanged,
  renderVersion,
  setActiveVersion,
} from '../canvas/canvas-store'
import {
  MAX_SKETCH_PNG_BYTES,
  deleteAnnotation,
  getReviewStateForSession,
  onReviewChanged,
  resolveAnnotation,
  submitReview,
  upsertAnnotation,
} from '../canvas/canvas-review-store'
import { resolveCanvasSnapshot, setSnapshotSender } from '../canvas/canvas-snapshot-broker'
import {
  installCanvasSessionLink,
  listReclaimableCanvases,
  reclaimCanvasForSession,
} from '../canvas/canvas-session-link'

// ---------------------------------------------------------------------------
// Bounds + Zod schemas
// ---------------------------------------------------------------------------

/** Session ids are app-minted (randomId → 24 hex); the bound is defensive. */
const sessionIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/)

/** Design documents are single-file mockups; 2 MB of HTML is far beyond any
 *  real one and small enough to move over IPC without a hiccup. */
const DESIGN_HTML_MAX = 2 * 1024 * 1024

const renderSourceSchema = z.discriminatedUnion('mode', [
  z
    .object({
      mode: z.literal('design'),
      html: z.string().min(1).max(DESIGN_HTML_MAX),
    })
    .strict(),
  z
    .object({
      mode: z.literal('uat'),
      distRoot: z.string().min(1).max(1024),
      entry: z.string().min(1).max(512).optional(),
      buildLabel: z.string().max(120).optional(),
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

/** The library is a pure read over every canvas; it takes no session id because
 *  it is housekeeping, not an ownership question. openTileSessionIds only marks
 *  which rows are on screen right now so the UI can warn before deleting one. */
const listAllSchema = z
  .object({ openTileSessionIds: openTileSessionIdsSchema })
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
    note: z.string().min(1).max(4000),
    focus: focusSchema.optional(),
    sketch: sketchMetaSchema.optional(),
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

const annotationResolveSchema = z
  .object({
    sessionId: sessionIdSchema,
    annotationId: annotationIdSchema,
    action: z.enum(['approve', 'dismiss', 'reannotate']),
  })
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
    const { openTileSessionIds } = listAllSchema.parse(args ?? {})
    return listAllCanvases(openTileSessionIds ?? [])
  })

  // The only destructive canvas operation, and it exists because the user
  // clicked delete on a specific row.
  ipcMain.handle(IPC.CANVAS_DELETE, async (_e, args: unknown) => {
    const { canvasId } = deleteCanvasSchema.parse(args)
    return { ok: deleteCanvas(canvasId) }
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
    const { sessionId, annotationId, action } = annotationResolveSchema.parse(args)
    return resolveAnnotation(sessionId, annotationId, action)
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
