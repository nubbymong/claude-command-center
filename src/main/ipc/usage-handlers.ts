import { ipcMain } from 'electron'
import { getUsageSummary, getSessionUsage } from '../usage-tracker'

export function registerUsageHandlers(): void {
  ipcMain.handle('usage:session', async (_event, sessionId: string) => {
    return getSessionUsage(sessionId)
  })

  ipcMain.handle('usage:total', async () => {
    return getUsageSummary(5)
  })

  ipcMain.handle('usage:history', async (_event, hours: number) => {
    return getUsageSummary(hours)
  })
}
