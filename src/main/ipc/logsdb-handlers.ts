import { ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc-channels'
import { getLogSupervisor } from '../logging/logging-service'

const listArgsSchema = z.object({ offset: z.number().int().nonnegative().optional(), limit: z.number().int().positive().max(2000).optional() }).optional()
const sessionIdSchema = z.string().min(1).max(200)
const offsetSchema = z.number().int().nonnegative().optional()
const limitSchema = z.number().int().positive().max(5000).optional()
const searchQuerySchema = z.string().min(1).max(500)
const idsSchema = z.array(z.string().min(1).max(200)).max(100000)

/** Reach the worker through the supervisor only (never import log-db here).
 *  Rejects fast when the supervisor is absent so the renderer never hangs. */
async function q(kind: string, args: Record<string, unknown>): Promise<unknown[]> {
  const sup = getLogSupervisor()
  if (!sup) throw new Error('logging service not running')
  return sup.query(kind, args)
}

export function registerLogsdbHandlers(): void {
  ipcMain.handle(IPC.LOGSDB_LIST_SESSIONS, async (_e, args?: { offset?: number; limit?: number }) => {
    const parsed = listArgsSchema.parse(args) ?? {}
    return q('listSessions', parsed)
  })

  ipcMain.handle(IPC.LOGSDB_READ_EVENTS, async (_e, sessionId: string, offset?: number, limit?: number) => {
    sessionIdSchema.parse(sessionId)
    offsetSchema.parse(offset)
    limitSchema.parse(limit)
    return q('readEvents', { sessionId, offset: offset ?? 0, limit: limit ?? 100 })
  })

  ipcMain.handle(IPC.LOGSDB_SEARCH, async (_e, query: string, limit?: number) => {
    searchQuerySchema.parse(query)
    limitSchema.parse(limit)
    return q('search', { query, limit: limit ?? 50 })
  })

  ipcMain.handle(IPC.LOGSDB_PRUNE, async (_e, ids: string[]) => {
    idsSchema.parse(ids)
    const rows = await q('prune', { ids })
    return rows[0] ?? { deletedSessions: 0, deletedEvents: 0 }
  })

  ipcMain.handle(IPC.LOGSDB_CLEAR_ALL, async () => {
    const rows = await q('clearAll', {})
    return rows[0] ?? { deletedSessions: 0, deletedEvents: 0 }
  })
}
