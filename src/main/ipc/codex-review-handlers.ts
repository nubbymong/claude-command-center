import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { getUsage, onUsageRecorded } from '../codex-review-usage'

export function registerCodexReviewHandlers(): void {
  ipcMain.handle(IPC.CODEX_REVIEW_USAGE_GET, (_e, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null
    return getUsage(sessionId)
  })

  // Push updates to all renderer windows whenever a review is recorded.
  onUsageRecorded((sessionId, record) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.CODEX_REVIEW_USAGE_UPDATED, { sessionId, record })
      }
    }
  })
}
