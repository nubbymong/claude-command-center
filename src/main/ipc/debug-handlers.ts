import { ipcMain, shell } from 'electron'
import type { BrowserWindow } from 'electron'
import {
  enableDebugMode,
  disableDebugMode,
  isDebugModeEnabled,
  getDebugDir,
} from '../debug-capture'
import { getLogDir, logInfo } from '../debug-logger'
import { IPC } from '../../shared/ipc-channels'
import { appWindowSender } from './trusted-sender'
import { listAccountLogFolders, openAccountLogFolder, realAccountFileFs } from '../account-folders'
import type { AccountFoldersSource, LogFolderDeps } from '../account-folders'

export function registerDebugHandlers(): void {
  ipcMain.handle('debug:enable', async () => {
    enableDebugMode()
    return true
  })

  ipcMain.handle('debug:disable', async () => {
    disableDebugMode()
    return true
  })

  ipcMain.handle('debug:isEnabled', async () => {
    return isDebugModeEnabled()
  })

  ipcMain.handle('debug:openFolder', async () => {
    // Open the log directory where app.log lives
    const dir = getLogDir()
    shell.openPath(dir)
    return dir
  })
}

/**
 * WP2 PR 4, P4.4 (row 56): each provider account's own log folders, beside
 * "Open log folder". Two channels keyed by account id and folder KIND; main
 * resolves the folder from `accounts` (asked afresh per request) and never
 * takes a path from the renderer. Both answer only the app's own window, its
 * main frame, checked before any argument is read; what a folder must pass
 * before the shell sees it is account-folders.ts's. `deps`: test seams.
 */
export function registerAccountLogFolderHandlers(
  getWindow: () => BrowserWindow | null,
  accounts: AccountFoldersSource,
  deps: Partial<LogFolderDeps> = {},
): void {
  const trusted = appWindowSender(getWindow)
  const d: LogFolderDeps = {
    fs: deps.fs ?? realAccountFileFs,
    openPath: deps.openPath ?? ((p) => shell.openPath(p)),
    platform: deps.platform ?? process.platform,
    log: deps.log ?? ((m) => logInfo(m)),
  }
  ipcMain.handle(IPC.DEBUG_ACCOUNT_LOG_FOLDERS, async (e) => {
    if (!trusted(e)) throw new Error('That request was not accepted.')
    try { return await listAccountLogFolders(accounts, d) } catch { return [] }
  })
  ipcMain.handle(IPC.DEBUG_OPEN_ACCOUNT_LOG_FOLDER, async (e, input: unknown) => {
    if (!trusted(e)) throw new Error('That request was not accepted.')
    try { return await openAccountLogFolder(input, accounts, d) } catch { return { ok: false, code: 'refused' } }
  })
}
