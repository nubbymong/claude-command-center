import { ipcMain, BrowserWindow } from 'electron'
import { startVisionForSession, stopVisionForSession, getVisionStatus, launchBrowser } from '../vision-manager'

export function registerVisionHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('vision:start', async (_event, sessionId: string, debugPort: number, browser: string) => {
    try {
      const proxyPort = await startVisionForSession(sessionId, debugPort, browser, getWindow)
      return { ok: true, proxyPort }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to start vision' }
    }
  })

  ipcMain.handle('vision:stop', async (_event, sessionId: string) => {
    stopVisionForSession(sessionId)
    return { ok: true }
  })

  ipcMain.handle('vision:status', async (_event, sessionId: string) => {
    const status = getVisionStatus(sessionId)
    return status || { connected: false, browser: null, proxyPort: 0 }
  })

  ipcMain.handle('vision:launch', async (_event, browser: 'chrome' | 'edge', debugPort: number, url?: string) => {
    try {
      const result = launchBrowser(browser, debugPort, url)
      return { ok: true, ...result }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to launch browser' }
    }
  })
}
