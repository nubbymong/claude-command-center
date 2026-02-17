import { ipcMain, BrowserWindow } from 'electron'
import { spawnPty, writePty, resizePty, killPty, SSHOptions } from '../pty-manager'
import { logUserInput, isDebugModeEnabled } from '../debug-capture'
import { startVisionForSession } from '../vision-manager'
import { logInfo } from '../debug-logger'

export function registerPtyHandlers(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle('pty:spawn', async (_event, sessionId: string, options?: {
    cwd?: string
    cols?: number
    rows?: number
    ssh?: SSHOptions
    shellOnly?: boolean
    configLabel?: string
    useResumePicker?: boolean
    visionConfig?: { enabled: boolean; browser: 'chrome' | 'edge'; debugPort: number }
  }) => {
    const win = getWindow()
    if (!win) throw new Error('No window available')

    // Start vision BEFORE spawning PTY so env vars are available
    if (options?.visionConfig?.enabled) {
      try {
        const proxyPort = await startVisionForSession(sessionId, options.visionConfig.debugPort, options.visionConfig.browser, getWindow)
        logInfo(`[pty] Vision started for ${sessionId}, proxy port ${proxyPort}`)
        // Notify renderer of initial connected state
        const { getVisionStatus } = require('../vision-manager')
        const status = getVisionStatus(sessionId)
        if (status) {
          win.webContents.send('vision:statusChanged', {
            sessionId,
            connected: status.connected,
            browser: status.browser,
            proxyPort: status.proxyPort
          })
        }
      } catch (err: any) {
        logInfo(`[pty] Vision start deferred for ${sessionId}: ${err?.message || err}`)
      }
    }

    spawnPty(win, sessionId, options)
  })

  ipcMain.on('pty:write', (_event, sessionId: string, data: string) => {
    if (isDebugModeEnabled()) {
      logUserInput(sessionId, data, 'inputBar')
    }
    writePty(sessionId, data)
  })

  ipcMain.on('pty:resize', (_event, sessionId: string, cols: number, rows: number) => {
    resizePty(sessionId, cols, rows)
  })

  ipcMain.on('pty:kill', (_event, sessionId: string) => {
    killPty(sessionId)
  })
}
