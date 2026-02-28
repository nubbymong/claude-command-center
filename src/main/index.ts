import { app, BrowserWindow, ipcMain, dialog, clipboard, safeStorage, Menu } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { randomBytes } from 'crypto'
import { registerPtyHandlers } from './ipc/pty-handlers'
import { registerUsageHandlers } from './ipc/usage-handlers'
import { registerDiscoveryHandlers } from './ipc/discovery-handlers'
import { killAllPty, gracefulExitAllPty } from './pty-manager'
import { registerLogHandlers } from './ipc/log-handlers'
import { closeAllLogs } from './session-logger'

import { deployStatuslineScript, configureClaudeSettings, startStatuslineWatcher } from './statusline-watcher'
import { registerDebugHandlers } from './ipc/debug-handlers'
import { disableDebugMode } from './debug-capture'
import { registerUpdateHandlers } from './ipc/update-handlers'
import { registerSetupHandlers, getResourcesDirectory } from './ipc/setup-handlers'
import { registerScreenshotHandlers } from './ipc/screenshot-handlers'
import { registerInsightsHandlers } from './ipc/insights-handlers'
import { registerNotesHandlers } from './ipc/notes-handlers'
import { registerVisionHandlers } from './ipc/vision-handlers'
import { registerConfigHandlers } from './ipc/config-handlers'
import { registerCloudAgentHandlers } from './ipc/cloud-agent-handlers'
import { registerTeamHandlers } from './ipc/team-handlers'
import { registerLegacyVersionHandlers } from './ipc/legacy-version-handlers'
import { registerAccountHandlers } from './ipc/account-handlers'
import { initAccounts } from './account-manager'
import { killAllAgents } from './cloud-agent-manager'
import { startServiceStatusPoller, stopServiceStatusPoller } from './service-status'
import { initUpdateWatcher, stopUpdateWatcher, getProjectRootPath, isPackagedApp } from './update-watcher'
import { startUpdateServer, stopUpdateServer } from './update-server'
import { startUpdateClient, stopUpdateClient } from './update-client'
import { saveSessionState, loadSessionState, clearSessionState, hasSavedSessionState, SessionState } from './session-state'
import { getConfigDir, ensureConfigDir } from './config-manager'
import { stopAllVisionManagers } from './vision-manager'

import { migrateRegistryKeys } from './registry'
import { installGlobalErrorHandlers, logInfo, logError, closeDebugLogger } from './debug-logger'

// Install global error handlers that log to file
installGlobalErrorHandlers()

// Migrate registry keys from old "Claude Conductor" → new "Claude Command Center"
migrateRegistryKeys()

// Lazy getter — can't call getConfigDir() at module load time
function getWindowStateFile(): string {
  return join(getConfigDir(), 'window-state.json')
}

interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  isMaximized: boolean
}

function loadWindowState(): WindowState {
  try {
    const file = getWindowStateFile()
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, 'utf-8'))
    }
  } catch {
    // ignore
  }
  return { width: 3200, height: 1800, isMaximized: false }
}

function saveWindowState(win: BrowserWindow): void {
  const bounds = win.getBounds()
  const state: WindowState = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    isMaximized: win.isMaximized()
  }
  try {
    ensureConfigDir()
    writeFileSync(getWindowStateFile(), JSON.stringify(state))
  } catch {
    // ignore
  }
}

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  const state = loadWindowState()

  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 1280,
    minHeight: 720,
    frame: false,
    backgroundColor: '#1E1E2E',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  if (state.isMaximized) {
    mainWindow.maximize()
  }

  mainWindow.on('ready-to-show', () => {
    if (process.env.E2E_HEADLESS === '1') {
      // Keep window off-screen for headless E2E tests
      mainWindow!.setPosition(-10000, -10000)
      mainWindow!.showInactive()
    } else {
      mainWindow!.show()
    }
  })

  // Track if we're allowing close (after graceful shutdown)
  let allowClose = false
  let closeRequestedOnce = false

  mainWindow.on('close', (e) => {
    if (mainWindow) saveWindowState(mainWindow)

    // If not yet allowed to close, prevent and notify renderer
    if (!allowClose) {
      // Second close attempt (e.g. from NSIS installer retry) — allow immediately
      if (closeRequestedOnce) {
        return
      }
      closeRequestedOnce = true
      e.preventDefault()
      mainWindow?.webContents.send('window:closeRequested')
    }
  })

  // Renderer calls this after saving sessions and graceful exit
  ipcMain.on('window:allowClose', () => {
    allowClose = true
    mainWindow?.close()
  })

  // Renderer calls this when user cancels the close dialog
  ipcMain.on('window:cancelClose', () => {
    closeRequestedOnce = false
  })

  // Window control IPC
  ipcMain.on('window:minimize', () => mainWindow?.minimize())
  ipcMain.on('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow?.maximize()
    }
  })
  // Window close is handled via IPC to support graceful shutdown
  // The renderer calls 'window:requestClose' which triggers graceful exit,
  // then calls 'window:forceClose' to actually close
  ipcMain.on('window:close', () => mainWindow?.close())
  ipcMain.on('window:forceClose', () => {
    if (mainWindow) {
      mainWindow.destroy()  // Force close without triggering close event
    }
  })
  ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized() ?? false)

  ipcMain.handle('dialog:openFolder', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: 'Select Working Directory'
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  // Clipboard image reading
  ipcMain.handle('clipboard:readImage', async () => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    // Resize if too large, save as JPEG for smaller context usage
    const size = img.getSize()
    const maxDim = 1920
    const resized = (size.width > maxDim || size.height > maxDim)
      ? img.resize({ width: Math.min(size.width, maxDim), height: Math.min(size.height, maxDim) })
      : img
    return resized.toJPEG(85).toString('base64')
  })

  // Save clipboard image to temp file and return the path
  ipcMain.handle('clipboard:saveImage', async () => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    // Resize large images to max 1920px and save as JPEG for smaller files
    const size = img.getSize()
    const maxDim = 1920
    const resized = (size.width > maxDim || size.height > maxDim)
      ? img.resize({ width: Math.min(size.width, maxDim), height: Math.min(size.height, maxDim) })
      : img
    const screenshotsDir = join(getResourcesDirectory(), 'screenshots')
    if (!existsSync(screenshotsDir)) mkdirSync(screenshotsDir, { recursive: true })
    const filename = `clipboard-${Date.now()}-${randomBytes(4).toString('hex')}.jpg`
    const filePath = join(screenshotsDir, filename)
    writeFileSync(filePath, resized.toJPEG(85))
    return filePath
  })

  // Encrypted credential storage using safeStorage — stored in CONFIG/
  function getCredentialsFile(): string {
    return join(getConfigDir(), 'ssh-credentials.json')
  }

  function loadCredentials(): Record<string, string> {
    try {
      const file = getCredentialsFile()
      if (existsSync(file)) {
        return JSON.parse(readFileSync(file, 'utf-8'))
      }
    } catch { /* ignore */ }
    return {}
  }

  function saveCredentials(creds: Record<string, string>): void {
    try {
      ensureConfigDir()
      writeFileSync(getCredentialsFile(), JSON.stringify(creds))
    } catch { /* ignore */ }
  }

  ipcMain.handle('credentials:save', async (_event, configId: string, password: string) => {
    if (!safeStorage.isEncryptionAvailable()) return false
    const encrypted = safeStorage.encryptString(password).toString('base64')
    const creds = loadCredentials()
    creds[configId] = encrypted
    saveCredentials(creds)
    return true
  })

  ipcMain.handle('credentials:load', async (_event, configId: string) => {
    if (!safeStorage.isEncryptionAvailable()) return null
    const creds = loadCredentials()
    const encrypted = creds[configId]
    if (!encrypted) return null
    try {
      return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
    } catch { return null }
  })

  ipcMain.handle('credentials:delete', async (_event, configId: string) => {
    const creds = loadCredentials()
    delete creds[configId]
    saveCredentials(creds)
    return true
  })

  // Session state persistence IPC handlers
  ipcMain.handle('session:save', async (_event, state: SessionState) => {
    return saveSessionState(state)
  })

  ipcMain.handle('session:load', async () => {
    return loadSessionState()
  })

  ipcMain.handle('session:clear', async () => {
    return clearSessionState()
  })

  ipcMain.handle('session:hasSaved', async () => {
    return hasSavedSessionState()
  })

  // Graceful shutdown - exit all Claude sessions cleanly
  ipcMain.handle('session:gracefulExit', async () => {
    await gracefulExitAllPty(5000)
    return true
  })

  // CLI availability check - tests that claude CLI exists (native .exe or npm .cmd)
  ipcMain.handle('cli:check', async () => {
    try {
      const { execSync } = require('child_process')
      // Try native CLI first, then npm wrapper
      try {
        execSync('where claude.exe', { encoding: 'utf-8', timeout: 5000, windowsHide: true })
        return true
      } catch { /* try .cmd */ }
      execSync('where claude.cmd', { encoding: 'utf-8', timeout: 5000, windowsHide: true })
      return true
    } catch {
      return false
    }
  })

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximized-changed', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximized-changed', false)
  })

  // Load renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Single instance lock (skip in dev so prod + dev can run side by side)
const isDev = !app.isPackaged
const gotTheLock = isDev ? true : app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
} else {
  if (!isDev) {
    app.on('second-instance', () => {
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore()
        mainWindow.focus()
      }
    })
  }

  app.whenReady().then(() => {
    // Set up application menu with Edit roles so Ctrl+C/V/X/A work in frameless window
    const menu = Menu.buildFromTemplate([
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
    ])
    Menu.setApplicationMenu(menu)

    // Deploy statusline script and configure Claude settings
    try {
      deployStatuslineScript()
      configureClaudeSettings()
    } catch (err) {
      console.warn('[main] Failed to deploy statusline:', err)
    }

    createWindow()

    const getWindow = () => mainWindow
    registerPtyHandlers(getWindow)
    registerUsageHandlers()
    registerDiscoveryHandlers()
    registerLogHandlers()
    registerDebugHandlers()
    registerUpdateHandlers()
    registerSetupHandlers()
    registerConfigHandlers()
    registerScreenshotHandlers(getWindow)
    registerInsightsHandlers(getWindow)
    registerNotesHandlers()
    registerVisionHandlers(getWindow)
    registerCloudAgentHandlers(getWindow)
    registerTeamHandlers(getWindow)
    registerLegacyVersionHandlers(getWindow)
    registerAccountHandlers()

    // Auto-detect current account from credentials (fire-and-forget)
    initAccounts().catch(() => {})

    // Start update system
    // Dev mode: run update server to push notifications to production clients
    // Production mode: connect to dev server as client to receive push notifications
    const projectRoot = getProjectRootPath()
    if (!isPackagedApp()) {
      // Dev mode - start update server and also the local watcher
      logInfo('[main] Dev mode: starting update server and local watcher')
      if (projectRoot) {
        startUpdateServer(projectRoot)
      }
      initUpdateWatcher(getWindow)
    } else {
      // Production mode - connect to dev server as client
      logInfo('[main] Production mode: starting update client')
      startUpdateClient(getWindow)
      // Also keep local watcher as fallback for file-based detection
      initUpdateWatcher(getWindow)
    }

    // Start watching for statusline updates
    startStatuslineWatcher(getWindow)

    // Start polling Anthropic service status
    startServiceStatusPoller(getWindow)
  })

  app.on('before-quit', () => {
    logInfo('App quitting...')
    stopServiceStatusPoller()
    stopUpdateWatcher()
    stopUpdateServer()
    stopUpdateClient()
    disableDebugMode()
    closeAllLogs()
    stopAllVisionManagers()
    killAllAgents()
    killAllPty()
    closeDebugLogger()
  })

  app.on('window-all-closed', () => {
    app.quit()
  })
}

export { mainWindow }
