import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { initModelRegistry, getRegistry, onRegistryReload } from '../model-registry-service'

export function registerRegistryHandlers(resourcesDir: string): void {
  initModelRegistry(resourcesDir)
  onRegistryReload((reg) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try { w.webContents.send(IPC.REGISTRY_UPDATE, reg) } catch { /* window destroyed */ }
    }
  })
  ipcMain.handle(IPC.REGISTRY_GET, () => getRegistry())
}
