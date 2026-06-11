/**
 * tokenomics2-handlers.ts — Tokenomics v2 read-surface IPC.
 *
 * Every channel is Zod-validated HERE (invalid args reject BEFORE the supervisor
 * is touched) then routed through getTokenomicsSupervisor().query(kind, args) —
 * the forked tokenomics worker. This file NEVER imports the DB or worker directly;
 * it only reaches the worker through the supervisor's promise-based query()
 * (15 s timeout, can't hang).
 *
 * The kinds map onto the worker's handleQuery() switch (tokenomics-worker.ts):
 *   summary, sessions, session-detail, index-status.
 *
 * TOKENOMICS2_INDEX_PROGRESS / TOKENOMICS2_INDEX_COMPLETE are PUSHes: at
 * registration we subscribe to the supervisor's progress/complete fan-outs and
 * forward each event to the renderer's webContents so the tokenomics page can
 * live-update without polling.
 *
 * No default export (project convention).
 */
import { ipcMain, type BrowserWindow } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc-channels'
import { getTokenomicsSupervisor } from '../tokenomics/tokenomics-service'

// ---------------------------------------------------------------------------
// Zod schemas
// ---------------------------------------------------------------------------

const filterSchema = z.object({
  configId: z.string().min(1).max(200).nullable().optional(),   // undefined=all, null=External
  from: z.number().int().optional(),
  to: z.number().int().optional(),
  model: z.string().min(1).max(200).optional(),
}).strict()

const sessionsSchema = filterSchema.extend({
  search: z.string().max(200).optional(),
  cursor: z.object({ lastTs: z.number().int(), sessionId: z.string() }).strict().nullable().optional(),
  limit: z.number().int().positive().max(200).optional(),
}).strict()

const detailSchema = z.object({ sessionId: z.string().min(1).max(200) }).strict()

// ---------------------------------------------------------------------------
// Fallback when supervisor is not yet running
// ---------------------------------------------------------------------------

const DEFAULT_STATUS = {
  firstIndexComplete: false,
  indexing: false,
  filesDone: 0,
  filesTotal: 0,
  eventsTotal: 0,
  lastIndexAt: null,
}

// ---------------------------------------------------------------------------
// Supervisor query helper
// ---------------------------------------------------------------------------

/** Route through the supervisor only. Rejects fast when it is absent so the
 *  renderer never hangs. */
async function q(kind: string, args: Record<string, unknown>): Promise<unknown[]> {
  const sup = getTokenomicsSupervisor()
  if (!sup) throw new Error('tokenomics service not running')
  return sup.query(kind, args)
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerTokenomics2Handlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.TOKENOMICS2_SUMMARY, async (_e, a: unknown) => {
    return (await q('summary', filterSchema.parse(a ?? {})))[0] ?? null
  })

  ipcMain.handle(IPC.TOKENOMICS2_SESSIONS, async (_e, a: unknown) => {
    return (await q('sessions', sessionsSchema.parse(a ?? {})))[0] ?? { rows: [], nextCursor: null }
  })

  ipcMain.handle(IPC.TOKENOMICS2_SESSION_DETAIL, async (_e, a: unknown) => {
    return (await q('session-detail', detailSchema.parse(a)))[0] ?? null
  })

  ipcMain.handle(IPC.TOKENOMICS2_INDEX_STATUS, async () => {
    const sup = getTokenomicsSupervisor()
    if (!sup) return DEFAULT_STATUS
    try {
      const rows = await sup.query('index-status', {})
      return rows[0] ?? { ...DEFAULT_STATUS, indexing: true }
    } catch {
      return { ...DEFAULT_STATUS, indexing: true }   // worker not ready yet -> still indexing
    }
  })

  // PUSH: forward the supervisor's index progress/complete events to the renderer
  // so the tokenomics page can live-update. Guarded against a destroyed window
  // (mirrors the emitToWindow pattern in index.ts). No-op when the supervisor
  // is not yet running (will be wired at next registerTokenomics2Handlers call).
  const sup = getTokenomicsSupervisor()
  sup?.onIndexProgress((p) => {
    const w = getWindow()
    if (w && !w.isDestroyed()) {
      try { w.webContents.send(IPC.TOKENOMICS2_INDEX_PROGRESS, p) } catch { /* window gone */ }
    }
  })
  sup?.onIndexComplete((c) => {
    const w = getWindow()
    if (w && !w.isDestroyed()) {
      try { w.webContents.send(IPC.TOKENOMICS2_INDEX_COMPLETE, c) } catch { /* window gone */ }
    }
  })
}
