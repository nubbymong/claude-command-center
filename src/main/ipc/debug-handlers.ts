import { ipcMain, shell } from 'electron'
import {
  enableDebugMode,
  disableDebugMode,
  isDebugModeEnabled,
  getDebugDir,
} from '../debug-capture'
import { getLogDir } from '../debug-logger'

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
