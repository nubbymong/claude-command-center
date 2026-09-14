/**
 * Config IPC Handlers — bridge between renderer and config-manager
 */

import { ipcMain } from 'electron'
import { loadAllConfig, saveConfig, migrateFromLocalStorage, isRendererConfigKey, readConfig } from '../config-manager'
import { deleteCredential } from '../credential-store'
import { isValidConfigsPayload, sshCredentialKeysToInvalidate } from '../config-save-guard'
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
    // The 'configs' value gets two extra guards the other renderer keys don't
    // need. Both are scoped to this key only; every other key saves exactly as
    // before (see saveConfig below).
    if (key === 'configs') {
      // Part 2 (defence in depth): reject a value that is not a well-formed
      // config array before it can reach disk, the invalidation comparison, or
      // the load-time migrations. Like the bad-key path: false + one warning,
      // and the data is never echoed.
      if (!isValidConfigsPayload(data)) {
        logWarn('[config-handlers] config:save refused: \'configs\' value is not a well-formed config array')
        return false
      }
      // Part 1 (load-bearing): a saved SSH config's credentials are keyed by the
      // config's ID, not pinned to its host, so a renderer that rewrites a saved
      // config's sshConfig.host/username/port while keeping the id would redirect
      // the stored password to a new destination on the next connect. Drop the
      // connection-bound credential slots of any config whose SSH identity
      // changed, in the SAME save. A legitimate edit re-prompts; a silent rewrite
      // is left with nothing to send. See config-save-guard.ts and the audit
      // comments at each loadCredential-then-connect site in pty-handlers.ts.
      const toDrop = sshCredentialKeysToInvalidate(readConfig('configs'), data)
      if (toDrop.length > 0) {
        let allDropped = true
        for (const credKey of toDrop) {
          if (!deleteCredential(credKey)) allDropped = false
        }
        // Fail CLOSED: if a connection-bound credential could not be dropped (an
        // unreadable/locked keychain file), do NOT persist the identity change —
        // the secret would otherwise stay recoverable by id and bound to the new
        // host. The old config is left intact; the renderer sees a failed save.
        if (!allDropped) {
          logWarn('[config-handlers] config:save refused: could not invalidate the SSH credential(s) for a config whose host/username/port changed; not persisting a change that would leave a stored secret bound to a new destination')
          return false
        }
      }
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
