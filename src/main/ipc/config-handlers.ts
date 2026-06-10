/**
 * Config IPC Handlers — bridge between renderer and config-manager
 */

import { ipcMain } from 'electron'
import { loadAllConfig, saveConfig, migrateFromLocalStorage, type ConfigKey } from '../config-manager'
import { logInfo } from '../debug-logger'
import { refreshTokenomicsConfigs } from '../tokenomics/tokenomics-service'

export function registerConfigHandlers(): void {
  // Load all config in one round-trip
  ipcMain.handle('config:loadAll', async () => {
    return loadAllConfig()
  })

  // Save a specific config key
  ipcMain.handle('config:save', async (_event, key: ConfigKey, data: unknown) => {
    const result = saveConfig(key, data)
    // Keep the tokenomics worker's cwd->config attribution dimension fresh when
    // the saved-configs list changes mid-run (otherwise a newly added/renamed
    // config wouldn't attribute until the next app restart).
    if (key === 'configs') {
      try { refreshTokenomicsConfigs() } catch { /* non-fatal */ }
    }
    return result
  })

  // Migrate localStorage data to CONFIG/ files
  ipcMain.handle('config:migrateFromLocalStorage', async (_event, data: Record<string, unknown>) => {
    logInfo(`[config-handlers] Migration requested with ${Object.keys(data).length} keys`)
    return migrateFromLocalStorage(data)
  })
}
