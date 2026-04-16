import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { startTranscriptWatcher, stopTranscriptWatcher } from '../transcript-watcher'
import { logInfo, logError } from '../debug-logger'

export function registerTranscriptHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.TRANSCRIPT_START, async (_event, sessionId: string, workingDirectory: string) => {
    const win = getWindow()
    if (!win) return
    try {
      logInfo(`[transcript-handlers] Starting transcript watcher for session ${sessionId} (${workingDirectory})`)
      startTranscriptWatcher(win, sessionId, workingDirectory)
    } catch (err) {
      logError(`[transcript-handlers] Failed to start watcher for ${sessionId}: ${err}`)
    }
  })

  ipcMain.on(IPC.TRANSCRIPT_STOP, (_event, sessionId: string) => {
    try {
      stopTranscriptWatcher(sessionId)
    } catch (err) {
      logError(`[transcript-handlers] Failed to stop watcher for ${sessionId}: ${err}`)
    }
  })
}
