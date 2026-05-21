import { ipcMain, BrowserWindow } from 'electron'
import { startGlobalVision, stopGlobalVision, getGlobalVisionStatus, launchBrowser, tryReconnectGlobalVision } from '../vision-manager'
import { readConfig, writeConfig } from '../config-manager'
import { isPackagedApp } from '../update-watcher'
import { resolveCdpPort } from '../../shared/cdp-ports'
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

  ipcMain.handle('vision:launch', async (_event, browser: 'chrome' | 'edge', _debugPort: number, url?: string, headless: boolean = true) => {
    try {
      // P7.7.12: ignore the renderer-provided debugPort and resolve it main-
      // side. A stale saved config (e.g. debugPort=9222 from before the P7.7
      // CDP split) would otherwise defeat the dev/prod separation -- dev mode
      // would launch Chrome on 9222 and either collide with a running prod
      // CCC or attach back to its browser. The resolver is the single source
      // of truth for the CDP port; the renderer's value is now advisory only.
      const debugPort = resolveCdpPort(isPackagedApp())
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
