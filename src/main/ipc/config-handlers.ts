/**
 * Config IPC Handlers — bridge between renderer and config-manager
 */

import { ipcMain } from 'electron'
import { loadAllConfig, saveConfig, migrateFromLocalStorage, isRendererConfigKey } from '../config-manager'
import { logInfo, logWarn } from '../debug-logger'
import { refreshTokenomicsConfigs } from '../tokenomics/tokenomics-service'

export interface ConfigHandlerHooks {
  /** Fired after the 'settings' config persists, so main-side services whose
   *  behaviour is settings-gated can re-read them mid-run (#266 MAJOR-2: the
   *  watchdog must tear down when unticked, not only stop arming). */
  onSettingsSaved?: () => void
}

export function registerConfigHandlers(hooks: ConfigHandlerHooks = {}): void {
  // Load all config in one round-trip. loadAllConfig returns the RENDERER keys
  // only (RENDERER_CONFIG_KEYS) -- the secret configs never cross this boundary.
  ipcMain.handle('config:loadAll', async () => {
    return loadAllConfig()
  })

  // Save a specific config key. `key` is a string from the renderer, not a
  // ConfigKey: the type annotation would be compile-time only, so it is checked
  // here against the renderer allowlist. An unregistered key and a secret key
  // are both refused (false, one warning) -- the renderer has no business
  // writing conductor-secret.json or ssh-credentials.json.
  ipcMain.handle('config:save', async (_event, key: unknown, data: unknown) => {
    if (!isRendererConfigKey(key)) {
      logWarn(`[config-handlers] config:save refused for key ${JSON.stringify(typeof key === 'string' ? key.slice(0, 64) : typeof key)}`)
      return false
    }
    const result = saveConfig(key, data)
    // Keep the tokenomics worker's cwd->config attribution dimension fresh when
    // the saved-configs list changes mid-run (otherwise a newly added/renamed
    // config wouldn't attribute until the next app restart).
    if (key === 'configs') {
      try { refreshTokenomicsConfigs() } catch { /* non-fatal */ }
    }
    if (result && key === 'settings') {
      try { hooks.onSettingsSaved?.() } catch { /* non-fatal */ }
    }
    return result
  })

  // Migrate localStorage data to CONFIG/ files
  ipcMain.handle('config:migrateFromLocalStorage', async (_event, data: Record<string, unknown>) => {
    logInfo(`[config-handlers] Migration requested with ${Object.keys(data).length} keys`)
    return migrateFromLocalStorage(data)
  })
}
