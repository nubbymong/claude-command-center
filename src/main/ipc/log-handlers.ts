import { ipcMain } from 'electron'
import { listLogSessions, readLogEntries, searchLogs, cleanupOldLogs } from '../session-logger'

export function registerLogHandlers(): void {
  ipcMain.handle('logs:list', async () => {
    return listLogSessions()
  })

  ipcMain.handle('logs:read', async (_event, logDir: string, offset?: number, limit?: number) => {
    return readLogEntries(logDir, offset, limit)
  })

  ipcMain.handle('logs:search', async (_event, logDir: string, query: string) => {
    return searchLogs(logDir, query)
  })

  ipcMain.handle('logs:cleanup', async (_event, retentionDays?: number) => {
    return cleanupOldLogs(retentionDays)
  })
}
