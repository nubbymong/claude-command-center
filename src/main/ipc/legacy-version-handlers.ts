import { ipcMain, BrowserWindow } from 'electron'
import {
  initLegacyVersionManager,
  fetchAvailableVersions,
  isVersionInstalled,
  installVersion,
  removeVersion,
  listInstalledVersions,
} from '../legacy-version-manager'
import { providerLaunchRefusal } from '../provider-launch-gate'

export function registerLegacyVersionHandlers(getWindow: () => BrowserWindow | null): void {
  initLegacyVersionManager(getWindow)

  ipcMain.handle('legacyVersion:fetchVersions', async () => {
    return fetchAvailableVersions()
  })

  ipcMain.handle('legacyVersion:isInstalled', async (_event, version: string) => {
    return isVersionInstalled(version)
  })

  // WP2: installing a pinned Claude Code CLI is for launching it, and nothing
  // launches Claude Code while it is switched off: refused, in the answer's
  // own shape (provider-launch-gate.ts).
  ipcMain.handle('legacyVersion:install', async (_event, version: string) => {
    const refused = providerLaunchRefusal('claude')
    if (refused) return { ok: false, error: refused.message }
    return installVersion(version)
  })

  ipcMain.handle('legacyVersion:remove', async (_event, version: string) => {
    return removeVersion(version)
  })

  ipcMain.handle('legacyVersion:listInstalled', async () => {
    return listInstalledVersions()
  })
}
