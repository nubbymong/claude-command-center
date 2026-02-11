import { ipcMain, BrowserWindow } from 'electron'
import {
  captureRectangle,
  captureWindow,
  listWindows,
  listRecentScreenshots,
  cleanupOldScreenshots
} from '../screenshot-capture'

export function registerScreenshotHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('screenshot:captureRectangle', async () => {
    const win = getWindow()
    if (!win) return null
    return captureRectangle(win)
  })

  ipcMain.handle('screenshot:captureWindow', async (_event, sourceId: string) => {
    return captureWindow(sourceId)
  })

  ipcMain.handle('screenshot:listWindows', async () => {
    return listWindows()
  })

  ipcMain.handle('screenshot:listRecent', async () => {
    return listRecentScreenshots()
  })

  ipcMain.handle('screenshot:cleanup', async (_event, maxAgeDays: number) => {
    return cleanupOldScreenshots(maxAgeDays)
  })
}
