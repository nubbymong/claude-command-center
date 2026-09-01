import { ipcMain, dialog, BrowserWindow } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { homedir } from 'os'
import * as pty from 'node-pty'
import { logInfo } from '../debug-logger'
import { getInstallPath } from '../update-watcher'
import { resolveClaudeForPty } from '../pty-manager'
import { probeClaudeCli } from '../claude-cli-probe'
import {
  getDataDirectory,
  getResourcesDirectory,
  setDataDirectory,
  setResourcesDirectory,
  isDataDirFromRegistry,
} from '../data-paths'

export { getDataDirectory, getResourcesDirectory } from '../data-paths'

// Check if setup is complete (uses cached registry/config check)
export function isSetupComplete(): boolean {
  // Ensure getDataDirectory() has been called at least once to populate cache
  getDataDirectory()
  return isDataDirFromRegistry()
}

// Shared helper lives in utils/claude-project-path. Both this module and the
// GitHub transcript loader map cwd → Claude's ~/.claude/projects/<folder>/
// convention; keeping one source of truth avoids drift if the convention
// ever changes upstream.
import { pathToClaudeProjectFolder } from '../utils/claude-project-path'

/**
 * Check if the install path is already trusted by Claude CLI.
 * Looks for a matching folder in ~/.claude/projects/
 */
export function isCliReady(): boolean {
  const installPath = getInstallPath()
  if (!installPath) return false

  const claudeProjectsDir = path.join(homedir(), '.claude', 'projects')
  if (!fs.existsSync(claudeProjectsDir)) return false

  const expectedFolder = pathToClaudeProjectFolder(installPath)
  const projectFolders = fs.readdirSync(claudeProjectsDir)

  for (const folder of projectFolders) {
    if (folder === expectedFolder) {
      logInfo(`[setup] CLI is ready — found trusted project: ${folder}`)
      return true
    }
  }

  logInfo(`[setup] CLI not ready — expected ${expectedFolder} in ~/.claude/projects/`)
  return false
}

// Track CLI setup PTY
let cliSetupPty: pty.IPty | null = null

export function writeCliSetupPty(data: string): void {
  cliSetupPty?.write(data)
}

export function registerSetupHandlers(): void {
  ipcMain.handle('setup:isComplete', async () => {
    return isSetupComplete()
  })

  ipcMain.handle('setup:getDefaultDataDir', async () => {
    const dir = getDataDirectory()
    logInfo(`[setup] IPC getDefaultDataDir returning: ${dir}`)
    return dir
  })

  ipcMain.handle('setup:selectDataDir', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Data Directory',
      defaultPath: getDataDirectory()
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('setup:setDataDir', async (_event, dataDir: string) => {
    return setDataDirectory(dataDir)
  })

  ipcMain.handle('setup:getDataDir', async () => {
    return getDataDirectory()
  })

  ipcMain.handle('setup:getResourcesDir', async () => {
    const dir = getResourcesDirectory()
    logInfo(`[setup] IPC getResourcesDir returning: ${dir}`)
    return dir
  })

  ipcMain.handle('setup:selectResourcesDir', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select Resources Directory',
      defaultPath: getResourcesDirectory()
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle('setup:setResourcesDir', async (_event, resourcesDir: string) => {
    return setResourcesDirectory(resourcesDir)
  })

  ipcMain.handle('setup:isCliReady', async () => {
    return isCliReady()
  })

  // Is the CLI INSTALLED at all? Distinct from isCliReady (which asks whether
  // the install folder is trusted, and answers "no" identically for "missing
  // binary" and "binary present, folder not trusted yet"). First-run setup
  // hard-stops on this one. Fail CLOSED: a probe that throws reports "not
  // installed" with the reason, and the step offers Retry.
  ipcMain.handle('setup:probeCli', async () => {
    try {
      return probeClaudeCli()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      logInfo(`[setup] Claude CLI probe failed: ${message}`)
      return { installed: false, probe: `probe failed: ${message}` }
    }
  })

  ipcMain.handle('setup:spawnCliSetup', async (event, cols: number, rows: number) => {
    const sessionId = '__cli_setup__'
    const installPath = getInstallPath()
    const cwd = installPath && fs.existsSync(installPath) ? installPath : homedir()

    const { cmd } = resolveClaudeForPty()
    logInfo(`[setup] Spawning CLI setup PTY: ${cmd} in ${cwd}`)

    if (process.platform === 'win32') {
      // Windows: spawn claude directly
      cliSetupPty = pty.spawn(cmd, [], {
        name: 'xterm-256color',
        cols: cols || 100,
        rows: rows || 20,
        cwd,
        env: process.env as Record<string, string>
      })
    } else {
      // macOS/Linux: spawn interactive login shell so PATH includes Homebrew etc.
      const shell = process.env.SHELL || '/bin/zsh'
      cliSetupPty = pty.spawn(shell, ['-l'], {
        name: 'xterm-256color',
        cols: cols || 100,
        rows: rows || 20,
        cwd,
        env: process.env as Record<string, string>,
      })
      // Send the claude command after a brief delay for shell init
      setTimeout(() => {
        if (cliSetupPty) cliSetupPty.write(`${cmd}\r`)
      }, 500)
    }

    const win = BrowserWindow.fromWebContents(event.sender)

    cliSetupPty.onData((data) => {
      if (win && !win.isDestroyed()) {
        win.webContents.send(`pty:data:${sessionId}`, data)
      }
    })

    cliSetupPty.onExit(({ exitCode }) => {
      logInfo(`[setup] CLI setup PTY exited with code ${exitCode}`)
      if (win && !win.isDestroyed()) {
        win.webContents.send(`pty:exit:${sessionId}`, exitCode)
      }
      cliSetupPty = null
    })

    return sessionId
  })

  ipcMain.handle('setup:killCliSetup', async () => {
    if (cliSetupPty) {
      try {
        cliSetupPty.kill()
      } catch { /* ignore */ }
      cliSetupPty = null
      logInfo('[setup] CLI setup PTY killed')
    }
    return true
  })
}
