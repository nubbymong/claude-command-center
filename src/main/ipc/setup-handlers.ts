import { ipcMain, app, dialog, BrowserWindow } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { homedir } from 'os'
import * as pty from 'node-pty'
import { logInfo } from '../debug-logger'
import { getInstallPath } from '../update-watcher'
import { resolveClaudeForPty } from '../pty-manager'
import { readRegistry, writeRegistry } from '../registry'

// Lazy getter for default data dir - can't call app.getPath() at module load time
function getDefaultDataDir(): string {
  if (process.platform === 'darwin') {
    return path.join(app.getPath('home'), 'Library', 'Application Support', 'Claude Conductor')
  }
  if (process.platform === 'linux') {
    return path.join(app.getPath('home'), '.claude-conductor', 'data')
  }
  // Windows
  return path.join(app.getPath('localAppData'), 'Claude Command Center')
}

// Cache registry values — they don't change during the app's lifetime
// (only set during installer wizard or setup dialog, which restarts the app)
let cachedDataDir: string | null = null
let cachedResourcesDir: string | null = null
let dataDirFromRegistry = false // true if DataDirectory was found in registry

// Read data directory from registry (cached after first call)
export function getDataDirectory(): string {
  if (cachedDataDir) return cachedDataDir

  const regVal = readRegistry('DataDirectory')
  if (regVal) {
    cachedDataDir = regVal
    dataDirFromRegistry = true
    logInfo(`[setup] Data directory from registry: ${cachedDataDir}`)
    return cachedDataDir
  }

  cachedDataDir = getDefaultDataDir()
  logInfo(`[setup] Data directory default: ${cachedDataDir}`)
  return cachedDataDir
}

// Read resources directory from registry (cached after first call)
export function getResourcesDirectory(): string {
  if (cachedResourcesDir) return cachedResourcesDir

  const regVal = readRegistry('ResourcesDirectory')
  if (regVal) {
    cachedResourcesDir = regVal
    logInfo(`[setup] Resources directory from registry: ${cachedResourcesDir}`)
    return cachedResourcesDir
  }

  cachedResourcesDir = path.join(getDataDirectory(), 'resources')
  logInfo(`[setup] Resources directory fallback: ${cachedResourcesDir}`)
  return cachedResourcesDir
}

// Set resources directory in registry and create folders
function setResourcesDirectory(resourcesDir: string): boolean {
  try {
    fs.mkdirSync(path.join(resourcesDir, 'insights'), { recursive: true })
    fs.mkdirSync(path.join(resourcesDir, 'screenshots'), { recursive: true })
    fs.mkdirSync(path.join(resourcesDir, 'skills'), { recursive: true })
    fs.mkdirSync(path.join(resourcesDir, 'scripts'), { recursive: true })
    fs.mkdirSync(path.join(resourcesDir, 'status'), { recursive: true })

    writeRegistry('ResourcesDirectory', resourcesDir)

    cachedResourcesDir = resourcesDir // Update cache
    logInfo(`[setup] Resources directory set to: ${resourcesDir}`)
    return true
  } catch (err) {
    logInfo(`[setup] Failed to set resources directory: ${err}`)
    return false
  }
}

// Check if setup is complete (uses cached registry/config check)
export function isSetupComplete(): boolean {
  // Ensure getDataDirectory() has been called at least once to populate cache
  getDataDirectory()
  return dataDirFromRegistry
}

// Set data directory in registry and create folders
function setDataDirectory(dataDir: string): boolean {
  try {
    // Create directory structure
    fs.mkdirSync(path.join(dataDir, 'sessions'), { recursive: true })
    fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true })
    fs.mkdirSync(path.join(dataDir, 'debug'), { recursive: true })
    fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true })

    writeRegistry('DataDirectory', dataDir)

    cachedDataDir = dataDir // Update cache
    dataDirFromRegistry = true
    logInfo(`[setup] Data directory set to: ${dataDir}`)
    return true
  } catch (err) {
    logInfo(`[setup] Failed to set data directory: ${err}`)
    return false
  }
}

/**
 * Convert a filesystem path to Claude's project folder name convention.
 * e.g. C:\Users\nicho\AppData\Local\Programs\claude-conductor
 *   -> C--Users-nicho-AppData-Local-Programs-claude-conductor
 */
function pathToClaudeProjectFolder(fsPath: string): string {
  return fsPath
    .replace(/:/g, '-')     // Colons become hyphens (C: -> C-)
    .replace(/[\\/]+/g, '-') // Path separators become hyphens
}

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

  ipcMain.handle('setup:spawnCliSetup', async (event, cols: number, rows: number) => {
    const sessionId = '__cli_setup__'
    const installPath = getInstallPath()
    const cwd = installPath && fs.existsSync(installPath) ? installPath : homedir()

    const { cmd } = resolveClaudeForPty()
    logInfo(`[setup] Spawning CLI setup PTY: ${cmd} in ${cwd}`)

    cliSetupPty = pty.spawn(cmd, [], {
      name: 'xterm-256color',
      cols: cols || 100,
      rows: rows || 20,
      cwd,
      env: process.env as Record<string, string>,
      useConpty: false
    })

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
