import { ipcMain, BrowserWindow } from 'electron'
import { startGlobalVision, stopGlobalVision, getGlobalVisionStatus, launchBrowser, tryReconnectGlobalVision } from '../vision-manager'
import { readConfig, writeConfig } from '../config-manager'
import type { GlobalVisionConfig } from '../../shared/types'

export function registerVisionHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('vision:start', async () => {
    const config = readConfig<GlobalVisionConfig>('visionGlobal')
    if (!config?.enabled) return { ok: false, error: 'Vision not configured' }
    try {
      await startGlobalVision(config, getWindow)
      return { ok: true }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to start vision' }
    }
  })

  ipcMain.handle('vision:stop', async () => {
    await stopGlobalVision()
    return { ok: true }
  })

  ipcMain.handle('vision:status', async () => {
    return getGlobalVisionStatus()
  })

  ipcMain.handle('vision:launch', async (_event, browser: 'chrome' | 'edge', debugPort: number, url?: string, headless: boolean = true) => {
    try {
      const result = launchBrowser(browser, debugPort, url, headless)
      tryReconnectGlobalVision()
      return { ok: true, ...result }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to launch browser' }
    }
  })

  ipcMain.handle('vision:saveConfig', async (_event, config: GlobalVisionConfig) => {
    writeConfig('visionGlobal', config)
    return { ok: true }
  })

  ipcMain.handle('vision:getConfig', async () => {
    return readConfig<GlobalVisionConfig>('visionGlobal')
  })
}
