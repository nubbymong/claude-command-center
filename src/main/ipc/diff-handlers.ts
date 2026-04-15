import { ipcMain, BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { getGitDiff, getGitDiffStats } from '../diff-generator'
import { startFileWatcher, stopFileWatcher } from '../file-watcher'
import { logInfo } from '../debug-logger'

// Track which sessions have file watchers, with their cwd
const subscribedSessions = new Map<string, string>()

export function registerDiffHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(IPC.DIFF_GET, async (_event, sessionId: string) => {
    const cwd = subscribedSessions.get(sessionId)
    if (!cwd) return []
    return getGitDiff(cwd)
  })

  ipcMain.handle(IPC.DIFF_SUBSCRIBE, async (_event, sessionId: string, cwd?: string) => {
    const win = getWindow()
    if (!win) return
    // cwd will be passed from the renderer, or we use the tracked one
    const workDir = cwd || subscribedSessions.get(sessionId)
    if (!workDir) {
      logInfo(`[diff-handlers] No working directory for session ${sessionId}`)
      return
    }
    subscribedSessions.set(sessionId, workDir)
    await startFileWatcher(win, sessionId, workDir)
  })

  ipcMain.on(IPC.DIFF_UNSUBSCRIBE, (_event, sessionId: string) => {
    stopFileWatcher(sessionId)
    subscribedSessions.delete(sessionId)
  })

  ipcMain.handle(IPC.DIFF_STATS, async (_event, sessionId: string) => {
    const cwd = subscribedSessions.get(sessionId)
    if (!cwd) return { added: 0, removed: 0 }
    return getGitDiffStats(cwd)
  })
}
