import { app, BrowserWindow, ipcMain, dialog, clipboard, Menu, session, shell } from 'electron'
import { join } from 'path'
import { tmpdir } from 'os'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { randomBytes } from 'crypto'
import { registerPtyHandlers } from './ipc/pty-handlers'
import { registerUsageHandlers } from './ipc/usage-handlers'
import { registerDiscoveryHandlers } from './ipc/discovery-handlers'
import { killAllPty, gracefulExitAllPty } from './pty-manager'
import { registerLogHandlers } from './ipc/log-handlers'
import { closeAllLogs } from './session-logger'

import { startStatuslineWatcher } from './statusline-watcher'
import { getProvider } from './providers'
import { registerDebugHandlers } from './ipc/debug-handlers'
import { disableDebugMode } from './debug-capture'
import { registerUpdateHandlers } from './ipc/update-handlers'
import { registerSetupHandlers, getResourcesDirectory } from './ipc/setup-handlers'
import { registerScreenshotHandlers } from './ipc/screenshot-handlers'
import { registerWebviewHandlers } from './ipc/webview-handlers'
import { closeAllWebviews } from './webview-manager'
import { registerInsightsHandlers } from './ipc/insights-handlers'
import { registerNotesHandlers } from './ipc/notes-handlers'
import { registerVisionHandlers } from './ipc/vision-handlers'
import { registerConfigHandlers } from './ipc/config-handlers'
import { registerCloudAgentHandlers } from './ipc/cloud-agent-handlers'
import { registerTeamHandlers } from './ipc/team-handlers'
import { registerLegacyVersionHandlers } from './ipc/legacy-version-handlers'
import { registerAccountHandlers } from './ipc/account-handlers'
import { registerMemoryHandlers } from './ipc/memory-handlers'
import { registerTokenomicsHandlers } from './ipc/tokenomics-handlers'
import { registerGitHubHandlers } from './ipc/github-handlers'
import { registerHooksHandlers } from './ipc/hooks-handlers'
import { HooksGateway } from './hooks/hooks-gateway'
import { setGateway, getGateway } from './hooks'
import { cleanupStaleHookEntries } from './hooks/boot-cleanup'
import { DEFAULT_HOOKS_PORT } from './hooks/hooks-types'
import { fetchModelPricing } from './tokenomics-manager'
import { initAccounts } from './account-manager'
import { killAllAgents } from './cloud-agent-manager'
import { startServiceStatusPoller, stopServiceStatusPoller } from './service-status'
import { initUpdateWatcher, stopUpdateWatcher, getProjectRootPath, isPackagedApp } from './update-watcher'
import { startUpdateServer, stopUpdateServer } from './update-server'
import { saveSessionState, loadSessionState, clearSessionState, hasSavedSessionState, SessionState } from './session-state'
import { getConfigDir, ensureConfigDir, snapshotConfig } from './config-manager'
import { stopGlobalVision, startGlobalVision, cleanupLegacyVisionMarkers, startConductorMcpServer, stopConductorMcpServer } from './vision-manager'
import { readConfig } from './config-manager'
import { loadCredential, saveCredential, deleteCredential } from './credential-store'
import type { GlobalVisionConfig } from '../shared/types'

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
let splashWindow: BrowserWindow | null = null

function getSplashImagePath(): { path: string; mime: string } | null {
  // In dev: repo root. In production: resources/ directory inside app.
  // Prefer PNG (new branded asset) then fall back to legacy WebP so
  // older installs that still ship the .webp keep working.
  const candidates: { name: string; mime: string }[] = [
    { name: 'splash.png', mime: 'image/png' },
    { name: 'splash.webp', mime: 'image/webp' },
  ]
  for (const c of candidates) {
    const dev = join(app.getAppPath(), c.name)
    if (existsSync(dev)) return { path: dev, mime: c.mime }
    const prod = join(process.resourcesPath, c.name)
    if (existsSync(prod)) return { path: prod, mime: c.mime }
  }
  return null
}

function createSplashWindow(): void {
  const splash = getSplashImagePath()
  if (!splash) {
    logInfo('[splash] Splash image not found, skipping')
    return
  }

  // Write the wrapper HTML (with the image inlined as base64) to a temp file
  // and load it via loadFile. The previous approach passed the entire
  // base64-encoded HTML as a `data:text/html` URL into loadURL — fine for
  // the 89 KB legacy splash.webp, but the new 1.5 MB branded splash.png
  // produces a >2 MB URL that exceeds Electron's practical loadURL size
  // limit; loadURL silently never reaches ready-to-show and the window is
  // created but never shown. Writing to disk + loadFile has no size limit,
  // and keeping the img as `data:` (not `file://`) sidesteps Chromium's
  // file://-to-file:// cross-origin block without having to disable
  // webSecurity.
  const imgData = readFileSync(splash.path).toString('base64')
  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; }
  body {
    background: transparent;
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100vh;
    overflow: hidden;
    opacity: 0;
    animation: fadeIn 0.6s ease-out 0.1s forwards;
  }
  @keyframes fadeIn { to { opacity: 1; } }
  img { width: 100%; height: 100%; object-fit: contain; }
</style></head><body>
  <img src="data:${splash.mime};base64,${imgData}" />
</body></html>`

  const tmpHtml = join(tmpdir(), 'claude-command-center-splash.html')
  try {
    writeFileSync(tmpHtml, html, 'utf-8')
  } catch (err) {
    logInfo(`[splash] Failed to write splash HTML to ${tmpHtml}: ${err}`)
    return
  }

  splashWindow = new BrowserWindow({
    width: 420,
    height: 420,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    center: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  splashWindow.loadFile(tmpHtml)
  splashWindow.once('ready-to-show', () => {
    splashWindow?.show()
  })
}

function closeSplashWindow(): void {
  if (!splashWindow || splashWindow.isDestroyed()) return
  // Fade out by sending a message, then destroy after delay
  splashWindow.webContents.executeJavaScript(`
    document.body.style.transition = 'opacity 0.4s ease-in';
    document.body.style.opacity = '0';
  `).catch(() => {})
  setTimeout(() => {
    if (splashWindow && !splashWindow.isDestroyed()) {
      splashWindow.destroy()
    }
    splashWindow = null
  }, 500)
}

function clampToVisibleDisplay(state: WindowState): WindowState {
  const { screen } = require('electron')
  const displays = screen.getAllDisplays()
  const primaryWorkArea = screen.getPrimaryDisplay().workArea

  // Clamp size to primary display work area
  const width = Math.min(state.width, primaryWorkArea.width)
  const height = Math.min(state.height, primaryWorkArea.height)

  // If no position saved, center on primary display
  if (state.x === undefined || state.y === undefined) {
    return {
      ...state,
      width,
      height,
      x: primaryWorkArea.x + Math.round((primaryWorkArea.width - width) / 2),
      y: primaryWorkArea.y + Math.round((primaryWorkArea.height - height) / 2),
    }
  }

  // Check if saved position is visible on any display
  const isVisible = displays.some((display: Electron.Display) => {
    const wa = display.workArea
    return (
      state.x! >= wa.x - 100 &&
      state.y! >= wa.y - 100 &&
      state.x! < wa.x + wa.width - 50 &&
      state.y! < wa.y + wa.height - 50
    )
  })

  if (isVisible) {
    return { ...state, width, height }
  }

  // Off-screen: center on primary display
  return {
    ...state,
    width,
    height,
    x: primaryWorkArea.x + Math.round((primaryWorkArea.width - width) / 2),
    y: primaryWorkArea.y + Math.round((primaryWorkArea.height - height) / 2),
  }
}

function createWindow(): void {
  const state = clampToVisibleDisplay(loadWindowState())

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
      sandbox: true
    }
  })

  // Prevent navigation away from the app
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' }
  })

  const splashShownAt = Date.now()

  mainWindow.on('ready-to-show', () => {
    if (process.env.E2E_HEADLESS === '1') {
      mainWindow!.setPosition(-10000, -10000)
      mainWindow!.showInactive()
      closeSplashWindow()
    } else {
      // Ensure splash shows for at least 2 seconds
      const elapsed = Date.now() - splashShownAt
      const remaining = Math.max(0, 2000 - elapsed)
      setTimeout(() => {
        // Maximize BEFORE show to avoid flash of non-maximized window
        if (state.isMaximized) mainWindow!.maximize()
        mainWindow!.show()
        closeSplashWindow()
      }, remaining)
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

  // Constrain to longest-edge max while preserving aspect ratio.
  // Passing both width and height to nativeImage.resize() distorts non-square images.
  const constrainToMaxDim = (img: Electron.NativeImage, maxDim: number) => {
    const size = img.getSize()
    if (size.width <= maxDim && size.height <= maxDim) return img
    if (size.width >= size.height) {
      return img.resize({ width: maxDim, quality: 'good' as const })
    }
    return img.resize({ height: maxDim, quality: 'good' as const })
  }

  // Clipboard image reading (legacy — kept for compatibility, prefer saveImage)
  ipcMain.handle('clipboard:readImage', async () => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const resized = constrainToMaxDim(img, 1920)
    return resized.toJPEG(85).toString('base64')
  })

  // Save clipboard image to a unique file in the host screenshots dir and return its
  // bare filename so the renderer can use the conductor MCP fetch_host_screenshot tool.
  // Returns { filename, path } so callers have both the bare name (for the MCP tool)
  // and the absolute path (for local-only flows that bypass MCP).
  ipcMain.handle('clipboard:saveImage', async () => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const resized = constrainToMaxDim(img, 1920)
    const screenshotsDir = join(getResourcesDirectory(), 'screenshots')
    if (!existsSync(screenshotsDir)) mkdirSync(screenshotsDir, { recursive: true })
    const filename = `clipboard-${Date.now()}-${randomBytes(4).toString('hex')}.jpg`
    const filePath = join(screenshotsDir, filename)
    writeFileSync(filePath, resized.toJPEG(85))
    return filePath
  })

  // Encrypted credential storage using safeStorage — delegated to credential-store module
  ipcMain.handle('credentials:save', async (_event, configId: string, password: string) => {
    return saveCredential(configId, password)
  })

  ipcMain.handle('credentials:load', async (_event, configId: string) => {
    return loadCredential(configId)
  })

  ipcMain.handle('credentials:delete', async (_event, configId: string) => {
    return deleteCredential(configId)
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

  // CLI availability check - tests that claude CLI exists
  // Windows: tries native .exe then npm .cmd via 'where'
  // macOS/Linux: uses 'which' to find 'claude' in PATH
  ipcMain.handle('cli:check', async () => {
    try {
      const { execSync } = require('child_process')
      if (process.platform === 'win32') {
        try {
          execSync('where claude.exe', { encoding: 'utf-8', timeout: 5000, windowsHide: true })
          return true
        } catch { /* try .cmd */ }
        execSync('where claude.cmd', { encoding: 'utf-8', timeout: 5000, windowsHide: true })
        return true
      } else {
        // Use login shell to pick up Homebrew/nvm PATH entries
        const shell = process.env.SHELL || '/bin/zsh'
        execSync(`${shell} -l -c "which claude"`, { encoding: 'utf-8', timeout: 5000 })
        return true
      }
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
    // On macOS, include the app name menu (About, Hide, Quit) and Window menu (macOS convention)
    const menuTemplate: Electron.MenuItemConstructorOptions[] = []

    if (process.platform === 'darwin') {
      menuTemplate.push({
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      })
    }

    menuTemplate.push({
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
    })

    if (process.platform === 'darwin') {
      menuTemplate.push({
        label: 'Window',
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          { role: 'front' }
        ]
      })
    }

    const menu = Menu.buildFromTemplate(menuTemplate)
    Menu.setApplicationMenu(menu)

    // Take a daily safety snapshot of the CONFIG directory BEFORE anything
    // writes to it (deploy/config below, window/handlers later, IPC saves
    // throughout the session). One snapshot per UTC day, last 7 retained
    // under CONFIG/_backups/YYYY-MM-DD/. Non-fatal if it fails.
    try { snapshotConfig() } catch (err) { console.warn('[main] snapshotConfig failed:', err) }

    // Deploy statusline script (Claude provider) — also configures
    // ~/.claude/settings.json statusLine stanza internally. Fire-and-forget;
    // the original sync calls (deployStatuslineScript + configureClaudeSettings)
    // had no downstream consumers in this boot sequence, so awaiting isn't needed.
    Promise.resolve()
      .then(() => getProvider('claude').deployStatuslineScript?.(getResourcesDirectory()))
      .catch((err) => console.warn('[main] Failed to deploy statusline:', err))

    // Content Security Policy
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: file:; font-src 'self' data: https://fonts.gstatic.com; connect-src 'self' ws://localhost:* http://localhost:*"
          ]
        }
      })
    })

    createSplashWindow()
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
    registerWebviewHandlers(getWindow)
    registerInsightsHandlers(getWindow)
    registerNotesHandlers()
    registerVisionHandlers(getWindow)
    registerCloudAgentHandlers(getWindow)
    registerTeamHandlers(getWindow)
    registerLegacyVersionHandlers(getWindow)
    registerAccountHandlers()
    registerTokenomicsHandlers(getWindow)
    registerMemoryHandlers()
    // GitHub sidebar — reads/writes github-config.json + encrypted auth profiles
    // under the CONFIG dir alongside other app config. Session-level integration
    // state piggybacks on the existing session-state persistence helpers.
    registerGitHubHandlers({
      resourcesDir: getConfigDir(),
      getWindow,
      loadSessions: async () => loadSessionState()?.sessions ?? [],
      saveSessions: async (sessions) => {
        const existing = loadSessionState()
        saveSessionState({
          sessions,
          activeSessionId: existing?.activeSessionId ?? null,
          savedAt: Date.now(),
        })
      },
    })

    // HTTP Hooks Gateway: loopback HTTP server that Claude Code calls when a hook
    // fires (PreToolUse, PostToolUse, etc.). Bound to 127.0.0.1 with per-session
    // UUID secrets. Renderer consumes events via the HOOKS_EVENT IPC channel.
    const hooksSettings = readConfig<{ hooksEnabled?: boolean; hooksPort?: number }>('settings')
    const hooksEnabled = hooksSettings?.hooksEnabled !== false
    const hooksPort = hooksSettings?.hooksPort ?? DEFAULT_HOOKS_PORT
    const hooksGateway = new HooksGateway({
      defaultPort: hooksPort,
      emit: (channel, payload) => {
        const win = getWindow()
        if (win && !win.isDestroyed()) {
          try { win.webContents.send(channel, payload) } catch { /* destroyed */ }
        }
      },
    })
    setGateway(hooksGateway)
    registerHooksHandlers(hooksGateway)
    if (hooksEnabled) {
      cleanupStaleHookEntries(new Set())
      hooksGateway.start().catch((err) => {
        logError(`[hooks] Gateway failed to start: ${err?.message ?? err}`)
      })
    }

    // Shell — open URLs in system browser
    ipcMain.handle('shell:openExternal', async (_event, url: string) => {
      if (typeof url === 'string' && url.startsWith('https://')) {
        await shell.openExternal(url)
      }
    })

    // Auto-detect current account from credentials (fire-and-forget)
    initAccounts().catch(() => {})

    // Fetch model pricing in background (non-blocking)
    fetchModelPricing().catch(() => {})

    // Clean up legacy CLAUDE.md vision markers
    cleanupLegacyVisionMarkers()

    // Start the Conductor MCP server unconditionally so the fetch_host_screenshot
    // tool is available for image transfer (snap, storyboard, clipboard paste)
    // in BOTH local and SSH sessions, regardless of whether browser vision is enabled.
    const visionConfig = readConfig<GlobalVisionConfig>('visionGlobal')
    const mcpPort = visionConfig?.mcpPort || 19333
    startConductorMcpServer(mcpPort).catch(err => {
      logError(`[main] Conductor MCP server startup failed: ${err?.message}`)
    })

    // Auto-start global vision (browser CDP) if configured. The MCP server is
    // already running — startGlobalVision just attaches the browser manager.
    if (visionConfig?.enabled) {
      startGlobalVision(visionConfig, getWindow).catch(err => {
        logError(`[main] Vision auto-start failed: ${err?.message}`)
      })
    }

    // Start update system
    // Dev mode: run the local update server + source watcher for live-reload workflow
    // Production mode: no local polling — updates are checked exclusively against
    //   GitHub releases via the check-for-updates button (see github-update.ts).
    const projectRoot = getProjectRootPath()
    if (!isPackagedApp()) {
      logInfo('[main] Dev mode: starting update server and local watcher')
      if (projectRoot) {
        startUpdateServer(projectRoot)
      }
      initUpdateWatcher(getWindow)
    } else {
      logInfo('[main] Production mode: updates via GitHub releases only')
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
    disableDebugMode()
    closeAllLogs()
    stopGlobalVision()
    stopConductorMcpServer()
    killAllAgents()
    killAllPty()
    closeAllWebviews()
    // Pull from the singleton barrel — `hooksGateway` declared inside the
     // app.whenReady() callback above is out of scope here, which threw an
     // uncaught ReferenceError on every quit and crashed the app before it
     // could emit any cleanup logs (visible in dev logs as the trigger that
     // killed an actively-spawning PTY mid-launch and removed its
     // settings-<sid>.json before claude could read it).
    try { getGateway()?.stop().catch(() => { /* ignore shutdown error */ }) } catch { /* gateway never started */ }
    closeDebugLogger()
  })

  app.on('window-all-closed', () => {
    // On macOS, apps conventionally stay running when all windows are closed.
    // The user must explicitly quit via Cmd+Q or the app menu.
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })

  // On macOS, re-create the window when the dock icon is clicked and no windows exist
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
}

export { mainWindow }
