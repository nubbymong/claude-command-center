import { ipcMain } from 'electron'
import { z } from 'zod'
import { listLogSessions, readLogEntries, searchLogs, cleanupOldLogs } from '../session-logger'
import { validatePath } from '../utils/path-validator'
import { getDataDirectory } from './setup-handlers'
import * as path from 'path'

const logDirSchema = z.string().min(1).max(1000)
const offsetSchema = z.number().int().nonnegative().optional()
const limitSchema = z.number().int().positive().optional()
const searchQuerySchema = z.string().min(1).max(500)
const retentionDaysSchema = z.number().int().positive().max(3650).optional()

export function registerLogHandlers(): void {
  ipcMain.handle('logs:list', async () => {
    return listLogSessions()
  })

  ipcMain.handle('logs:read', async (_event, logDir: string, offset?: number, limit?: number) => {
    try {
      logDirSchema.parse(logDir)
      offsetSchema.parse(offset)
      limitSchema.parse(limit)
    } catch (err) {
      throw new Error(`Invalid parameters: ${err instanceof Error ? err.message : String(err)}`)
    }
    const logsRoot = path.join(getDataDirectory(), 'logs')
    const validPath = validatePath(logDir, logsRoot)
    return readLogEntries(validPath, offset, limit)
  })

  ipcMain.handle('logs:search', async (_event, logDir: string, query: string) => {
    try {
      logDirSchema.parse(logDir)
      searchQuerySchema.parse(query)
    } catch (err) {
      throw new Error(`Invalid parameters: ${err instanceof Error ? err.message : String(err)}`)
    }
    const logsRoot = path.join(getDataDirectory(), 'logs')
    const validPath = validatePath(logDir, logsRoot)
    return searchLogs(validPath, query)
  })

  ipcMain.handle('logs:cleanup', async (_event, retentionDays?: number) => {
    try {
      retentionDaysSchema.parse(retentionDays)
    } catch (err) {
      throw new Error(`Invalid parameters: ${err instanceof Error ? err.message : String(err)}`)
    }
    return cleanupOldLogs(retentionDays)
  })
}
