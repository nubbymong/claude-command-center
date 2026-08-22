import { ipcMain, BrowserWindow } from 'electron'
import { startGlobalVision, stopGlobalVision, getGlobalVisionStatus, launchBrowser, tryReconnectGlobalVision, resetVisionRelaunchBreaker, isGlobalVisionRunning } from '../vision-manager'
import { createReadFailureLatch, loadConfigLatched, saveConfigLatched } from '../persist-latch'
import { isPackagedApp } from '../update-watcher'
import { resolveCdpPort } from '../../shared/cdp-ports'
import type { GlobalVisionConfig } from '../../shared/types'

/**
 * #371. `vision:getConfig` answering null for a read FAILURE is what makes this
 * one dangerous: the settings form renders its defaults for "not configured
 * yet", the user touches one control, and `vision:saveConfig` writes those
 * defaults over the config it never read. The old handler then returned
 * `{ ok: true }` unconditionally — it discarded `writeConfig`'s boolean — so a
 * failed save was reported to the user as a successful one either way.
 */
const visionLatch = createReadFailureLatch('vision-config')

/** Test seam — the latch is module state and outlives a test file otherwise. */
export function _resetVisionLatchForTest(): void {
  visionLatch.reset()
}

export function registerVisionHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('vision:start', async () => {
    const config = loadConfigLatched<GlobalVisionConfig>('visionGlobal', visionLatch)
    // Say WHICH kind of nothing this is. "Not configured" sends the user to the
    // settings panel, which — on a read failure — is exactly where they would
    // overwrite the config they still have (#371 MINOR-5).
    if (!config && visionLatch.failed()) {
      return { ok: false, error: 'Vision settings could not be read this time, so vision was not started. They are still on disk — try again in a moment.' }
    }
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
      // Manual Start re-arms auto-relaunch (clears any tripped circuit breaker).
      resetVisionRelaunchBreaker()
      const result = await launchBrowser(browser, debugPort, url, headless)
      // If vision was previously Stopped, stopGlobalVision tore down the manager
      // (globalManager=null), so tryReconnect would be a no-op and the browser
      // would sit on "launching…" forever. Recreate the manager in that case
      // (mirrors boot: launchBrowser then startGlobalVision); otherwise just nudge
      // the existing manager to reconnect to the freshly-spawned browser.
      if (isGlobalVisionRunning()) {
        tryReconnectGlobalVision()
      } else {
        const saved = loadConfigLatched<GlobalVisionConfig>('visionGlobal', visionLatch)
        await startGlobalVision({ ...(saved ?? {}), browser, debugPort, headless } as GlobalVisionConfig, getWindow)
      }
      return { ok: true, ...result }
    } catch (err: any) {
      return { ok: false, error: err?.message || 'Failed to launch browser' }
    }
  })

  /**
   * `generation` is the token `vision:getConfig` handed out with the config the
   * form was built from (#371 MAJOR-5).
   *
   * The latch alone is not enough here, because the stale state lives in the
   * RENDERER: `getConfig` fails, the panel renders defaults, then something
   * else — `vision:start`, the launch path — reads the file successfully and
   * clears the latch. A save arriving after that looks perfectly healthy and
   * writes the defaults over the real config. The token closes that window: it
   * changes on recovery, so a form built while the file was unreadable can
   * never save over the file once it is readable again.
   */
  ipcMain.handle('vision:saveConfig', async (_event, config: GlobalVisionConfig, generation?: number) => {
    if (typeof generation === 'number' && generation !== visionLatch.generation()) {
      return {
        ok: false,
        stale: true,
        error: 'Vision settings were not saved: these settings were shown before the settings file could be read, so saving them would overwrite the real ones. Reopen this panel to see what is actually saved.',
      }
    }
    // Report the real outcome. A refused save (the last read FAILED) and a
    // failed write both come back as ok:false rather than a false reassurance.
    const saved = saveConfigLatched('visionGlobal', config, visionLatch)
    if (saved) return { ok: true }
    return {
      ok: false,
      error: visionLatch.failed()
        ? 'Vision settings were not saved: the existing settings file could not be read, so it was left alone. Try again once it is readable.'
        : 'Vision settings could not be saved.',
    }
  })

  ipcMain.handle('vision:getConfig', async () => {
    const config = loadConfigLatched<GlobalVisionConfig>('visionGlobal', visionLatch)
    return {
      config,
      generation: visionLatch.generation(),
      /** True when `config` is null because the file could not be READ, rather
       *  than because there is none. The panel must not offer defaults as if
       *  this were a fresh install. */
      readFailed: visionLatch.failed(),
    }
  })
}
