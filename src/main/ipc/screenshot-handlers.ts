import { ipcMain, BrowserWindow } from 'electron'
import { z } from 'zod'
import {
  captureRectangle,
  captureWindow,
  listWindows,
  listRecentScreenshots,
  cleanupOldScreenshots,
  startStoryboard,
  captureStoryboardFrame,
  stopStoryboard,
  isStoryboardActive
} from '../screenshot-capture'

const sourceIdSchema = z.string().min(1).max(500)
const maxAgeDaysSchema = z.number().int().positive().max(3650)

export function registerScreenshotHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('screenshot:captureRectangle', async () => {
    const win = getWindow()
    if (!win) return null
    return captureRectangle(win)
  })

  ipcMain.handle('screenshot:captureWindow', async (_event, sourceId: string) => {
    try {
      sourceIdSchema.parse(sourceId)
    } catch (err) {
      throw new Error(`Invalid parameters: ${err instanceof Error ? err.message : String(err)}`)
    }
    return captureWindow(sourceId)
  })

  ipcMain.handle('screenshot:listWindows', async () => {
    return listWindows()
  })

  ipcMain.handle('screenshot:listRecent', async () => {
    return listRecentScreenshots()
  })

  ipcMain.handle('screenshot:cleanup', async (_event, maxAgeDays: number) => {
    try {
      maxAgeDaysSchema.parse(maxAgeDays)
    } catch (err) {
      throw new Error(`Invalid parameters: ${err instanceof Error ? err.message : String(err)}`)
    }
    return cleanupOldScreenshots(maxAgeDays)
  })

  // Storyboard handlers
  ipcMain.handle('storyboard:start', async () => {
    const win = getWindow()
    if (!win) return null
    return startStoryboard(win)
  })

  ipcMain.handle('storyboard:captureFrame', async () => {
    return captureStoryboardFrame()
  })

  ipcMain.handle('storyboard:stop', async () => {
    return stopStoryboard()
  })

  ipcMain.handle('storyboard:isActive', async () => {
    return isStoryboardActive()
  })
}
