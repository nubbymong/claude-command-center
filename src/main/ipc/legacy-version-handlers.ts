import { ipcMain, BrowserWindow } from 'electron'
import {
  initLegacyVersionManager,
  fetchAvailableVersions,
  isVersionInstalled,
  installVersion,
  removeVersion,
  listInstalledVersions,
} from '../legacy-version-manager'

export function registerLegacyVersionHandlers(getWindow: () => BrowserWindow | null): void {
  initLegacyVersionManager(getWindow)

  ipcMain.handle('legacyVersion:fetchVersions', async () => {
    return fetchAvailableVersions()
  })

  ipcMain.handle('legacyVersion:isInstalled', async (_event, version: string) => {
    return isVersionInstalled(version)
  })

  ipcMain.handle('legacyVersion:install', async (_event, version: string) => {
    return installVersion(version)
  })

  ipcMain.handle('legacyVersion:remove', async (_event, version: string) => {
    return removeVersion(version)
  })

  ipcMain.handle('legacyVersion:listInstalled', async () => {
    return listInstalledVersions()
  })
}
