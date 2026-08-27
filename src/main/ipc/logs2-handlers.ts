/**
 * logs2-handlers.ts — Logs v2 read-surface IPC (the transcript-chat viewer).
 *
 * Every channel is Zod-validated HERE (invalid args reject BEFORE the supervisor
 * is touched) then routed through getLogSupervisor().query(kind, args) — the
 * single forked transcripts worker. This file NEVER imports transcripts-db /
 * transcripts-worker (better-sqlite3 lives only in the fork); it only reaches the
 * worker through the supervisor's promise-based query() (15 s timeout, can't hang).
 *
 * The kinds map onto the worker's handleQuery() switch (transcripts-worker.ts):
 *   list-slots, read-messages, turn-summary, search, delete-slot, clear-all,
 *   ingest-stats. Scope is flattened into args ({configId} | {sessionId}) because
 *   the worker's scopeFromArgs() reads args.configId / args.sessionId directly.
 *
 * LOGS2_NEW_MESSAGES is a PUSH: at registration we subscribe to the supervisor's
 * new-messages fan-out and forward each event to the renderer's webContents
 * (mirrors the emitToWindow pattern in index.ts) so the open chat view live-tails.
 *
 * No default export (project convention).
 */
import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc-channels'
import { getLogSupervisor, getTranscriptBinder } from '../logging/logging-service'
import { rememberSessionName, forgetSessionName, writeNameSidecar, nodeNameSidecarDeps } from '../logging/session-name-sidecar'

// ---------------------------------------------------------------------------
// Bounds + Zod schemas
// ---------------------------------------------------------------------------

const READ_LIMIT_MAX = 1000
const SEARCH_LIMIT_MAX = 500

/** Exactly one of configId | sessionId — never both, never neither (the worker's
 *  scopeFromArgs throws on neither; an ambiguous both is rejected up front). */
const scopeSchema = z
  .object({
    configId: z.string().min(1).max(200).optional(),
    sessionId: z.string().min(1).max(200).optional(),
  })
  .strict()
  .refine(
    (s) => (s.configId === undefined) !== (s.sessionId === undefined),
    { message: 'scope must include exactly one of configId or sessionId' },
  )

/** anchor: the literal 'tail' or an explicit {runId, idx} message address. */
const anchorSchema = z.union([
  z.literal('tail'),
  z.object({ runId: z.number().int(), idx: z.number().int() }).strict(),
])

const readMessagesSchema = z
  .object({
    scope: scopeSchema,
    anchor: anchorSchema.optional(),
    dir: z.enum(['older', 'newer']).optional(),
    limit: z.number().int().positive().max(READ_LIMIT_MAX).optional(),
  })
  .strict()

const turnSummarySchema = z.object({ scope: scopeSchema }).strict()

const searchSchema = z
  .object({
    query: z.string().min(1).max(500),
    limit: z.number().int().positive().max(SEARCH_LIMIT_MAX).optional(),
  })
  .strict()

const deleteSlotSchema = z.object({ scope: scopeSchema }).strict()

const renameSessionSchema = z
  .object({ sessionId: z.string().min(1).max(200), configLabel: z.string().max(200), customName: z.string().max(200).optional() })
  .strict()

const ingestStatusSchema = z.object({ sessionId: z.string().min(1).max(200) }).strict()

const sessionConfigSchema = z.object({ sessionId: z.string().min(1).max(200) }).strict()

// ---------------------------------------------------------------------------
// Supervisor query helper
// ---------------------------------------------------------------------------

/** Route through the supervisor only. Rejects fast when it is absent so the
 *  renderer never hangs. */
async function q(kind: string, args: Record<string, unknown>): Promise<unknown[]> {
  const sup = getLogSupervisor()
  if (!sup) throw new Error('logging service not running')
  return sup.query(kind, args)
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerLogs2Handlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.LOGS2_LIST_SLOTS, async () => {
    return q('list-slots', {})
  })

  ipcMain.handle(IPC.LOGS2_READ_MESSAGES, async (_e, args: unknown) => {
    const { scope, anchor, dir, limit } = readMessagesSchema.parse(args)
    return q('read-messages', {
      ...scope,
      anchor: anchor ?? 'tail',
      dir: dir ?? 'older',
      limit: limit ?? 200,
    })
  })

  ipcMain.handle(IPC.LOGS2_TURN_SUMMARY, async (_e, args: unknown) => {
    const { scope } = turnSummarySchema.parse(args)
    return q('turn-summary', { ...scope })
  })

  ipcMain.handle(IPC.LOGS2_SEARCH, async (_e, args: unknown) => {
    const { query, limit } = searchSchema.parse(args)
    return q('search', { query, limit: limit ?? 50 })
  })

  ipcMain.handle(IPC.LOGS2_DELETE_SLOT, async (_e, args: unknown) => {
    const { scope } = deleteSlotSchema.parse(args)
    const rows = await q('delete-slot', { ...scope })
    return rows[0] ?? { deletedRuns: 0, deletedMessages: 0 }
  })

  ipcMain.handle(IPC.LOGS2_CLEAR_ALL, async () => {
    const rows = await q('clear-all', {})
    return rows[0] ?? { deletedRuns: 0, deletedMessages: 0 }
  })

  // Session rename: update the display label on the session's latest run so the
  // logs/history tab reflects the custom work name durably. Fire-and-forget post
  // (buffered in the supervisor); no-op when logging is disabled.
  ipcMain.handle(IPC.LOGS2_RENAME_SESSION, async (_e, args: unknown) => {
    const { sessionId, configLabel, customName } = renameSessionSchema.parse(args)
    getLogSupervisor()?.renameRun(sessionId, configLabel)
    // #536: carry the user's OWN work name (customName, NOT the generic config
    // label) onto the transcript so it survives outside CCC and identifies the
    // conversation on resume. An empty customName is a real "cleared" signal and
    // removes the sidecar. Older preload builds omit customName → fall back to
    // configLabel. Remember it (the exact-bind callback writes it once the path is
    // known), and write now only against an EXACT bind — never a heuristic guess
    // (which in a shared folder could be a sibling card's transcript). Best-effort.
    const nameForSidecar = customName ?? configLabel
    const exactPath = getTranscriptBinder()?.getExactResumeTarget(sessionId)
    if (exactPath) {
      // Already bound: write directly and DO NOT keep a pending entry — a lingering
      // one would bleed this name onto the next conversation this session binds
      // after a /clear rotates the uuid (adv review #536).
      writeNameSidecar(exactPath, nameForSidecar, nodeNameSidecarDeps)
      forgetSessionName(sessionId)
    } else {
      // Not bound yet: remember so onExactBind writes it once the path is known
      // (a blank name clears the pending entry).
      rememberSessionName(sessionId, nameForSidecar)
    }
    return { ok: true }
  })

  ipcMain.handle(IPC.LOGS2_INGEST_STATUS, async (_e, args: unknown) => {
    const { sessionId } = ingestStatusSchema.parse(args)
    const rows = await q('ingest-stats', { sessionId })
    return rows[0] ?? null
  })

  ipcMain.handle(IPC.LOGS2_SESSION_CONFIG, async (_e, args: unknown) => {
    const { sessionId } = sessionConfigSchema.parse(args)
    const rows = await q('session-config', { sessionId })
    return rows[0] ?? null     // { configId: string | null } | null
  })

  // PUSH: forward the worker's new-messages fan-out to the renderer so the open
  // chat view can live-tail. Guarded against a destroyed window (mirrors
  // index.ts's emitToWindow). No-op when logging is disabled (no supervisor).
  const sup = getLogSupervisor()
  sup?.onNewMessages((e) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) {
      try { win.webContents.send(IPC.LOGS2_NEW_MESSAGES, e) } catch { /* window gone */ }
    }
  })
}
