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
import { ipcMain, BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc-channels'
import { getLogSupervisor, getTranscriptBinder } from '../logging/logging-service'
import { rememberSessionName, forgetSessionName, writeNameSidecar, nodeNameSidecarDeps, writeRealmNameSidecar, nodeRealmNameFs } from '../logging/session-name-sidecar'
import { getCodexLogBinder } from '../logging/codex-log-binder'
import { detectOldLogArtifacts, executeWipe } from '../logging/logs-wipe'
import { logInfo, logError } from '../debug-logger'
import { appWindowSender } from './trusted-sender'

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

/**
 * P3.12 round 1: every logs2 channel answers only the app's own window, its
 * main frame, by the same check as the account handlers (trusted-sender.ts).
 * A request from anywhere else is refused (the promise rejects) before any
 * argument is read.
 */
function handleFromApp(
  getWindow: () => BrowserWindow | null,
): (channel: string, fn: (e: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void {
  const trusted = appWindowSender(getWindow)
  return (channel, fn) => {
    ipcMain.handle(channel, async (e, ...args) => {
      if (!trusted(e)) throw new Error('That request was not accepted.')
      return fn(e, ...args)
    })
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** `isCodexSession`: whether the pty manager runs `sessionId` as a Codex
 *  session now (P3.12 round 1, Q1: only such a session's rename takes the
 *  Codex binder's path). */
export function registerLogs2Handlers(getWindow: () => BrowserWindow | null, isCodexSession: (sessionId: string) => boolean): void {
  const handle = handleFromApp(getWindow)
  handle(IPC.LOGS2_LIST_SLOTS, async () => {
    return q('list-slots', {})
  })

  handle(IPC.LOGS2_READ_MESSAGES, async (_e, args: unknown) => {
    const { scope, anchor, dir, limit } = readMessagesSchema.parse(args)
    return q('read-messages', {
      ...scope,
      anchor: anchor ?? 'tail',
      dir: dir ?? 'older',
      limit: limit ?? 200,
    })
  })

  handle(IPC.LOGS2_TURN_SUMMARY, async (_e, args: unknown) => {
    const { scope } = turnSummarySchema.parse(args)
    return q('turn-summary', { ...scope })
  })

  handle(IPC.LOGS2_SEARCH, async (_e, args: unknown) => {
    const { query, limit } = searchSchema.parse(args)
    return q('search', { query, limit: limit ?? 50 })
  })

  handle(IPC.LOGS2_DELETE_SLOT, async (_e, args: unknown) => {
    const { scope } = deleteSlotSchema.parse(args)
    const rows = await q('delete-slot', { ...scope })
    return rows[0] ?? { deletedRuns: 0, deletedMessages: 0 }
  })

  handle(IPC.LOGS2_CLEAR_ALL, async () => {
    const rows = await q('clear-all', {})
    return rows[0] ?? { deletedRuns: 0, deletedMessages: 0 }
  })

  // Session rename: update the display label on the session's latest run so the
  // logs/history tab reflects the custom work name durably. Fire-and-forget post
  // (buffered in the supervisor); no-op when logging is disabled.
  handle(IPC.LOGS2_RENAME_SESSION, async (_e, args: unknown) => {
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
    // P3.12 (row 32): a Codex session's name file goes next to the rollout its
    // watcher claimed exactly (never an inferred or shared claim), inside its
    // realm and never through a link; else it is remembered for that claim.
    // Round 1 (Q1): only while the session runs as Codex (a tab respawned as
    // Claude takes Claude's path below).
    const codex = isCodexSession(sessionId) ? getCodexLogBinder() : null
    if (codex?.knows(sessionId)) {
      const exact = codex.exactRollout(sessionId)
      if (exact) {
        writeRealmNameSidecar(exact.path, exact.sessionsDir, nameForSidecar, nodeRealmNameFs)
        forgetSessionName(sessionId)
      } else {
        rememberSessionName(sessionId, nameForSidecar)
      }
      return { ok: true }
    }
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

  handle(IPC.LOGS2_INGEST_STATUS, async (_e, args: unknown) => {
    const { sessionId } = ingestStatusSchema.parse(args)
    const rows = await q('ingest-stats', { sessionId })
    return rows[0] ?? null
  })

  handle(IPC.LOGS2_SESSION_CONFIG, async (_e, args: unknown) => {
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

/**
 * Logs v2 first-run wipe. Deliberately NOT inside registerLogs2Handlers: that
 * runs after initLogging, and the wipe prompt must be registered before any
 * boot step ahead of it can throw and skip it.
 */
export function registerLogsWipeHandlers(getWindow: () => BrowserWindow | null): void {
  const handle = handleFromApp(getWindow)
  // The renderer drives a blocking confirm modal: it DETECTs at startup, and
  // only on the user's confirm does CONFIRM actually delete. Detection-driven +
  // idempotent (no marker file — once deleted nothing is detected). executeWipe
  // NEVER touches ~/.claude / the safety backup / the logging settings.
  handle(IPC.LOGS2_WIPE_DETECT, async () => {
    try {
      return detectOldLogArtifacts()
    } catch (err) {
      logError(`[logs2] wipe detect failed: ${(err as Error)?.message ?? err}`)
      return { present: false, totalBytes: 0, paths: [], settingsKeys: [] }
    }
  })
  handle(IPC.LOGS2_WIPE_CONFIRM, async () => {
    const res = executeWipe()
    logInfo(`[logs2] wiped ${res.deletedPaths.length} old log artifact(s), freed ${res.freedBytes} bytes, cleared keys: ${res.clearedKeys.join(', ') || '(none)'}`)
    return res
  })
}
