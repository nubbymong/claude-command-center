import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { resolveFileForPreview, addSuppressedProject } from '../preview-manager'

export function registerPreviewHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.PREVIEW_OPEN_FILE, async (_event, filePath: string) => {
    return resolveFileForPreview(filePath)
  })

  ipcMain.on(IPC.PREVIEW_DISMISS_SERVER, (_event, projectPath: string) => {
    addSuppressedProject(projectPath)
  })
}
