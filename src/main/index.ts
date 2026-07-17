import { app, BrowserWindow, ipcMain, dialog, Menu, session, shell } from 'electron'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { randomBytes } from 'crypto'
import { registerPtyHandlers } from './ipc/pty-handlers'
import { registerUsageHandlers } from './ipc/usage-handlers'
import { registerDiscoveryHandlers } from './ipc/discovery-handlers'
import { killAllPty, gracefulExitAllPty, resolveClaudeForPty } from './pty-manager'
import { spawnClaudeHeadless } from './claude-headless'
import { parseClaudeVersion } from './sentinel/sentinel-version'
import { registerResumeHandlers } from './ipc/resume-handlers'
import { registerLogs2Handlers } from './ipc/logs2-handlers'

import { startStatuslineWatcher, setTranscriptPathSink, healGlobalStatusline } from './statusline-watcher'
import { registerProvider, getProvider } from './providers'
import { ClaudeProvider } from './providers/claude'
import { CodexProvider } from './providers/codex'
import { registerDebugHandlers } from './ipc/debug-handlers'
import { disableDebugMode } from './debug-capture'
import { registerUpdateHandlers } from './ipc/update-handlers'
import { registerSetupHandlers, getResourcesDirectory, getDataDirectory } from './ipc/setup-handlers'
import { ensureHelpWorkspace } from './help-workspace'
import { registerScreenshotHandlers } from './ipc/screenshot-handlers'
import { registerWebviewHandlers } from './ipc/webview-handlers'
import { closeAllWebviews } from './webview-manager'
import { registerInsightsHandlers } from './ipc/insights-handlers'
import { registerNotesHandlers } from './ipc/notes-handlers'
import { registerVisionHandlers } from './ipc/vision-handlers'
import { registerConfigHandlers } from './ipc/config-handlers'
import { registerAccountProfilesHandlers } from './ipc/account-profiles-handlers'
import { migrateProfilesToHomeLayout, cleanupSessionHomes, syncPrimaryCredentialsWithGlobal } from './account-profiles'
import { runFirstRunCapture } from './first-run-accounts'
import { backupRealClaudeOnce } from './claude-backup'
import { registerCloudAgentHandlers } from './ipc/cloud-agent-handlers'
import { registerTeamHandlers } from './ipc/team-handlers'
import { registerLegacyVersionHandlers } from './ipc/legacy-version-handlers'
import { registerMemoryHandlers } from './ipc/memory-handlers'
import { initTokenomics, shutdownTokenomics } from './tokenomics/tokenomics-service'
import { registerTokenomics2Handlers } from './ipc/tokenomics2-handlers'
import { registerGitHubHandlers } from './ipc/github-handlers'
import { registerHooksHandlers } from './ipc/hooks-handlers'
import { registerServiceHealthHandlers, getMergedDiagnostics } from './ipc/service-health-handlers'
import { PtyIntegrityMonitor, setPtyIntegrityMonitor, getPtyIntegrityMonitor } from './services/pty-integrity-monitor'
import { registerCodexHandlers } from './ipc/codex-handlers'
import { registerCodexReviewHandlers } from './ipc/codex-review-handlers'
import { registerRegistryHandlers } from './ipc/registry-handlers'
import { initSentinel, reconcileOnUpdate, sentinelStartupCheck } from './sentinel/index'
import { registerSentinelHandlers } from './ipc/sentinel-handlers'
import { registerChannelHandlers } from './ipc/channel-handlers'
import { startRulesEngine } from './channel-rules'
import { startEffortTracker } from './effort-tracker'
import { startAttentionSource } from './attention-source'
import { startJankDetector } from './jank-detector'
import { readClipboardImageWithRetry } from './clipboard-image'
import { readClipboardImageFilePath, type PasteableImage } from './clipboard-file'
import { HooksGateway } from './hooks/hooks-gateway'
import { setGateway, getGateway } from './hooks'
import { ServiceSupervisor } from './services/service-supervisor'
import { forkHooksChild } from './services/fork-hooks-child'
import { start as startLoopStallMonitor, stop as stopLoopStallMonitor } from './services/loop-stall-monitor'
import { initLogging, shutdownLogging, getTranscriptBinder } from './logging/logging-service'
import { detectOldLogArtifacts, executeWipe } from './logging/logs-wipe'
import { backfillCompanionDirsAsync, nodeFsCompanionDeps } from './logging/companion-dir'
import { cleanupStaleHookEntries, cleanupStaleMcpConfigs } from './hooks/boot-cleanup'
import { isSentinelEnabled } from '../shared/sentinel-enabled'
import { DEFAULT_HOOKS_PORT } from './hooks/hooks-types'
import { fetchModelPricing } from './tokenomics/tk-pricing'
import { killAllAgents } from './cloud-agent-manager'
import { startServiceStatusPoller, stopServiceStatusPoller, getLastServiceStatus } from './service-status'
import { initUpdateWatcher, stopUpdateWatcher, getProjectRootPath, isPackagedApp } from './update-watcher'
import { startUpdateServer, stopUpdateServer } from './update-server'
import { saveSessionState, loadSessionState, clearSessionState, hasSavedSessionState, SessionState } from './session-state'
import { getConfigDir, ensureConfigDir, snapshotConfig } from './config-manager'
import { stopGlobalVision, killSpawnedBrowser, cleanupLegacyVisionMarkers } from './vision-manager'
import { startConductorMcpServer, stopConductorMcpServer, startBrowserAtBoot } from './conductor-mcp-server'
import { readConfig } from './config-manager'
import { loadCredential, saveCredential, deleteCredential } from './credential-store'
import { resolveConductorMcpPort } from '../shared/mcp-ports'
import { IPC } from '../shared/ipc-channels'
import { safeExternalHttpsHref } from '../shared/safe-url'

import { migrateRegistryKeys } from './registry'
import { installGlobalErrorHandlers, logInfo, logError, closeDebugLogger, setVerboseBaseline } from './debug-logger'

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
let _hooksSupervisor: ServiceSupervisor | null = null
function setHooksSupervisor(s: ServiceSupervisor): void { _hooksSupervisor = s }
function getHooksSupervisor(): ServiceSupervisor | null { return _hooksSupervisor }

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
  .disclaimer {
    position: fixed;
    bottom: 10px;
    left: 0;
    right: 0;
    text-align: center;
    font: 500 10px/1.3 system-ui, -apple-system, 'Segoe UI', sans-serif;
    letter-spacing: 0.2px;
    color: rgba(205, 214, 244, 0.82);
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.85), 0 0 2px rgba(0, 0, 0, 0.7);
    padding: 0 14px;
    pointer-events: none;
  }
</style></head><body>
  <img src="data:${splash.mime};base64,${imgData}" />
  <div class="disclaimer">Independent community project. Not affiliated with or endorsed by Anthropic.</div>
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
    // Windows: fully frameless with custom controls in the TitleBar.
    // macOS: keep the native traffic lights (hiddenInset) — frame:false there
    // removes them entirely and the custom right-docked controls read as a
    // broken window to Mac users. The renderer hides its custom controls and
    // left-pads the drag region on darwin (TitleBar.tsx).
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const }
      : { frame: false }),
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

  // Save clipboard image to a unique file in the host screenshots dir and return its
  // bare filename so the renderer can use the conductor MCP fetch_host_screenshot tool.
  // Returns { filename, path } so callers have both the bare name (for the MCP tool)
  // and the absolute path (for local-only flows that bypass MCP).
  ipcMain.handle('clipboard:saveImage', async (): Promise<PasteableImage> => {
    const screenshotsDir = join(getResourcesDirectory(), 'screenshots')
    // Retry the read so the FIRST Alt+V after copying an image reliably detects
    // it -- Windows' delayed-render clipboard can return empty on the first read
    // after the window gains focus, which was the "no image detected" miss.
    const img = await readClipboardImageWithRetry()
    if (img) {
      // [perf] resize + JPEG encode is the suspected clipboard-paste freeze; time it
      // with the source dimensions, since cost scales with input size.
      const __t0 = Date.now()
      const resized = constrainToMaxDim(img, 1920)
      const jpeg = resized.toJPEG(85)
      const __dt = Date.now() - __t0
      if (__dt > 150) {
        const s = img.getSize()
        logInfo(`[perf] clipboard-image resize+encode took ${__dt}ms (${s.width}x${s.height})`)
      }
      if (!existsSync(screenshotsDir)) mkdirSync(screenshotsDir, { recursive: true })
      const filename = `clipboard-${Date.now()}-${randomBytes(4).toString('hex')}.jpg`
      const filePath = join(screenshotsDir, filename)
      writeFileSync(filePath, jpeg)
      return { path: filePath }
    }
    // No bitmap on the clipboard — fall back to a copied image FILE (BUG-8).
    return readClipboardImageFilePath(screenshotsDir)
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
    // Async execFile (not execSync): this runs every 30s for the app's lifetime
    // from BottomBar, so a synchronous probe would stall PTY data delivery to
    // every terminal in lockstep. Same boolean result shape as before.
    const { execFile } = require('child_process')
    const { promisify } = require('util')
    const execFileAsync = promisify(execFile)
    try {
      if (process.platform === 'win32') {
        // windowsHide + piped stderr suppresses the "INFO: Could not find
        // files..." line `where` writes to stderr on a miss; execFile pipes
        // by default so the noise never reaches the parent's terminal between
        // the .exe and .cmd probes.
        const opts = { encoding: 'utf-8' as const, timeout: 5000, windowsHide: true }
        try {
          await execFileAsync('where', ['claude.exe'], opts)
          return true
        } catch { /* try .cmd */ }
        await execFileAsync('where', ['claude.cmd'], opts)
        return true
      } else {
        // Use login shell to pick up Homebrew/nvm PATH entries
        const shell = process.env.SHELL || '/bin/zsh'
        await execFileAsync(shell, ['-l', '-c', 'which claude'], { encoding: 'utf-8', timeout: 5000 })
        return true
      }
    } catch {
      return false
    }
  })

  // Onboarding "Find Claude": the resolved claude binary path (no command run).
  ipcMain.handle('cli:path', async () => {
    try {
      return resolveClaudeForPty()?.cmd ?? null
    } catch {
      return null
    }
  })

  // Onboarding "Find Claude": run `claude --version` on demand (user-approved).
  ipcMain.handle('cli:version', async () => {
    try {
      const res = await spawnClaudeHeadless(['--version'], 10000)
      return parseClaudeVersion(res.stdout) ?? parseClaudeVersion(res.stderr) ?? null
    } catch {
      return null
    }
  })

  // "Ask Command Center": stage (refresh) the help workspace and return its
  // path; the renderer launches a normal Claude session with this cwd so the
  // CLAUDE.md + app-knowledge.md docs prime the session.
  ipcMain.handle('help:workspace', async () => {
    try {
      return ensureHelpWorkspace(getResourcesDirectory())
    } catch {
      return null
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

    // Register built-in providers first — must happen before any code calls
    // getProvider('claude'), including deployStatuslineScript below.
    registerProvider(new ClaudeProvider())
    registerProvider(new CodexProvider())

    // Take a daily safety snapshot of the CONFIG directory BEFORE anything
    // writes to it (deploy/config below, window/handlers later, IPC saves
    // throughout the session). One snapshot per UTC day, last 7 retained
    // under CONFIG/_backups/YYYY-MM-DD/. Non-fatal if it fails.
    try { snapshotConfig() } catch (err) { console.warn('[main] snapshotConfig failed:', err) }

    // U2: heal installs that carry a legacy GLOBAL statusLine stanza + planted
    // ~/.claude/claude-multi-statusline.js from a prior CCC version. The statusline
    // is now delivered per-session (writeLocalSessionSettings), so plain `claude`
    // outside CCC gets its native line back. Best-effort, never blocks boot.
    try { healGlobalStatusline() } catch (err) { console.warn('[main] healGlobalStatusline failed:', err) }

    // Deploy the statusline script to the resources dir (per-session command +
    // SSH mounts). Fire-and-forget; no downstream consumers here.
    Promise.resolve()
      .then(() => getProvider('claude').deployStatuslineScript?.(getResourcesDirectory()))
      .then(() => getProvider('claude').deployResumePickerScript?.(getResourcesDirectory()))
      .then(() => getProvider('codex').deployResumePickerScript?.(getResourcesDirectory()))
      .catch((err) => console.warn('[main] Failed to deploy provider scripts:', err))
      // Resume-picker bug fix: backfill companion dirs so DIRECT-WORK
      // conversations (no subagent/workflow → no companion dir from the CLI) are
      // visible in the picker AND resumable via `claude --resume`. Idempotent,
      // additive, NEVER deletes. One sweep of the canonical projects store covers
      // every account (per-account .claude/projects are junctions to it). Runs
      // after the .catch so a deploy failure never skips it; off the synchronous
      // boot path (microtask) so it never delays window creation. Each session's
      // own resume path also ensures its companion dir, so this is a bulk
      // visibility pass, not a per-resume requirement.
      .then(() => {
        // #120: DEFER + CHUNK the companion-dir backfill. It was synchronous and
        // stat-stormed the whole projects store, freezing the event loop ~20-28s
        // at boot (blocking first paint). It is a non-critical bulk visibility
        // pass for the resume picker (each session ensures its own companion dir),
        // so run it well after first paint, via the async/yielding variant so it
        // never blocks the main thread.
        setTimeout(() => {
          const projectsRoot = join(homedir(), '.claude', 'projects')
          backfillCompanionDirsAsync(projectsRoot, nodeFsCompanionDeps)
            .then((res) => {
              if (res.created > 0) {
                console.log(`[main] companion-dir backfill: created ${res.created} companion dir(s) (scanned ${res.scanned} transcripts across ${res.projectFolders} project folders)`)
              }
            })
            .catch((err) => console.warn('[main] companion-dir backfill failed:', err))
        }, 5000)
      })

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
    registerResumeHandlers()
    // Logs v2 — first-run warned wipe of the OLD log artifacts (orphaned ~21 GB
    // logs.db + ~16 GB legacy logs/ tree + migration markers). The renderer drives
    // a blocking confirm modal: it DETECTs at startup, and only on the user's
    // confirm does CONFIRM actually delete. Detection-driven + idempotent (no
    // marker file — once deleted nothing is detected). executeWipe NEVER touches
    // ~/.claude / the safety backup / the logging settings (see logs-wipe.ts).
    ipcMain.handle(IPC.LOGS2_WIPE_DETECT, async () => {
      try {
        return detectOldLogArtifacts()
      } catch (err) {
        logError(`[logs2] wipe detect failed: ${(err as Error)?.message ?? err}`)
        return { present: false, totalBytes: 0, paths: [], settingsKeys: [] }
      }
    })
    ipcMain.handle(IPC.LOGS2_WIPE_CONFIRM, async () => {
      const res = executeWipe()
      logInfo(`[logs2] wiped ${res.deletedPaths.length} old log artifact(s), freed ${res.freedBytes} bytes, cleared keys: ${res.clearedKeys.join(', ') || '(none)'}`)
      return res
    })
    registerDebugHandlers()
    registerUpdateHandlers()
    registerSetupHandlers()
    registerRegistryHandlers(getResourcesDirectory())
    // Sentinel (spec 2026-06-11): optional service; OFF = no init, dot hidden, zero impact.
    // readConfig('settings') is available here (same pattern as the beta-channel read below).
    {
      const sentinelSettings = readConfig<{ sentinelEnabled?: boolean }>('settings')
      if (isSentinelEnabled(sentinelSettings?.sentinelEnabled)) {
        initSentinel(getResourcesDirectory())
        registerSentinelHandlers()
        reconcileOnUpdate()
        void sentinelStartupCheck()
      }
    }
    registerConfigHandlers()
    // Beta builds default to verbose logging (lightweight async DEBUG lines ->
    // app.log) so field issues are captured. NEVER on stable. This enables only
    // the verbose level, NOT the per-event hot-path TRACE logs and NOT the heavy
    // per-PTY debug capture (debugMode) -- so it's perf-neutral. Sticky baseline:
    // toggling debug mode off later won't silence it on beta.
    try {
      const ch = readConfig<{ updateChannel?: string }>('settings')?.updateChannel
      if (ch === 'beta') { setVerboseBaseline(true); logInfo('[boot] verbose logging enabled (beta channel)') }
    } catch { /* settings unreadable this early -- skip */ }
    registerAccountProfilesHandlers()
    // SAFETY: snapshot the real Claude config before the multi-account feature
    // does anything, so the user's original login is always recoverable.
    try { backupRealClaudeOnce() } catch (e) { logInfo(`[backup] snapshot skipped: ${e}`) }
    // One-time migration to the USERPROFILE fake-home isolation layout (older
    // profiles isolated only CLAUDE_CONFIG_DIR, which never isolated the account
    // identity). Idempotent + best-effort; never touches the real home.
    try { migrateProfilesToHomeLayout() } catch (e) { logInfo(`[profiles] home-layout migration skipped: ${e}`) }
    // Capture the current global login into a protected "primary" profile so no
    // session runs on the bare global ~/.claude (idempotent; best-effort).
    try { runFirstRunCapture() } catch (e) { logInfo(`[profiles] first-run capture skipped: ${e}`) }
    // Bug 2: migrate OFF the per-session-home model. Sessions of one account now
    // share its profile home (one rotating-OAuth store); salvage the freshest live
    // token out of any retired account-homes/<sessionId>/ into the profile home +
    // canonical (so no re-auth after upgrade), then KEEP + re-point those homes at
    // the shared store (UPGRADE GUARD -- a resumed pre-upgrade session may still
    // name an account-homes path, so we never delete it). Idempotent; bounded set.
    try { cleanupSessionHomes() } catch (e) { logInfo(`[profiles] session-home cleanup skipped: ${e}`) }
    // Auth-outside-CCC fix: heal a stale real global ~/.claude/.credentials.json on
    // launch (a prior session rotated the primary account's OAuth token, leaving
    // external `claude -p` on a dead refresh token). Freshest-wins + email-guarded.
    try { const r = syncPrimaryCredentialsWithGlobal(); if (r !== 'none') logInfo(`[profiles] primary<->global credential sync at launch: ${r}`) } catch (e) { logInfo(`[profiles] credential sync skipped: ${e}`) }
    registerScreenshotHandlers(getWindow)
    registerWebviewHandlers(getWindow)
    registerInsightsHandlers(getWindow)
    registerNotesHandlers()
    registerVisionHandlers(getWindow)
    registerCodexHandlers()
    registerCodexReviewHandlers()
    registerChannelHandlers()
    startRulesEngine()
    registerCloudAgentHandlers(getWindow)
    registerTeamHandlers(getWindow)
    registerLegacyVersionHandlers(getWindow)
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
    const emitToWindow = (channel: string, payload: unknown) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) {
        try { win.webContents.send(channel, payload) } catch { /* destroyed */ }
      }
    }
    // PTY-integrity monitor (D1 diagnostics). Lives in main; surfaces through the
    // SAME SERVICE_HEALTH_GET/UPDATE as the hooks supervisor via a merge so every
    // push carries BOTH snapshots (else one source would wipe the other in the UI).
    const getSup = () => getHooksSupervisor()
    const getPtyDiag = () => getPtyIntegrityMonitor()?.diagnostics() ?? null
    const pushDiagnostics = () => emitToWindow(IPC.SERVICE_HEALTH_UPDATE, getMergedDiagnostics(getSup, getPtyDiag))
    const ptyMonitor = new PtyIntegrityMonitor({ emit: pushDiagnostics })
    setPtyIntegrityMonitor(ptyMonitor)
    // Redirect ONLY SERVICE_HEALTH_UPDATE through the merge; every other channel
    // (HOOKS_STATUS, HOOKS_EVENT, ...) the supervisor/gateway emit passes through.
    const emitWithMerge = (channel: string, payload: unknown) =>
      channel === IPC.SERVICE_HEALTH_UPDATE ? pushDiagnostics() : emitToWindow(channel, payload)
    // Logs v2 (Task 8): route transcript paths the child gateway lifts from hook
    // POSTs into the binder. Resolved lazily — the binder is created later by
    // initLogging(), and is null when logging is disabled (then this is a no-op).
    const routeTranscriptPath = (sessionId: string, path: string) =>
      getTranscriptBinder()?.notifyTranscriptPath(sessionId, path)
    if (hooksEnabled) {
      // Supervised out-of-process gateway: a utilityProcess child runs the HooksGateway,
      // crash-isolated from the main thread, with restart/backoff + fail-open-to-in-process.
      const hooksSupervisor = new ServiceSupervisor({ forkChild: forkHooksChild, defaultPort: hooksPort, emit: emitWithMerge, onTranscriptPath: routeTranscriptPath })
      const hooksProxy = hooksSupervisor.start()   // forks the child + posts start (S1 replay-before-listen inside)
      setGateway(hooksProxy)                        // B1: consumers + handlers all use the proxy
      setHooksSupervisor(hooksSupervisor)           // module-scope ref for before-quit (S5)
    } else {
      // Hooks disabled: today's exact behavior — an in-process gateway exists (so
      // registerSession still mints secrets) but never binds; no child is forked.
      setGateway(new HooksGateway({ defaultPort: hooksPort, emit: emitWithMerge }))
    }
    // Session logging (Logs v2): start the transcripts worker supervisor (gated
    // on loggingEnabled, default true; no-op + no fork when disabled). The worker
    // closes dangling runs + resumes transcript tails itself on open. The native
    // dep (better-sqlite3) lives ONLY in the forked worker — this call stays
    // main-clean.
    // TODO(logs2 Phase 5): wipe the orphaned old byte-capture DB
    // (<dataDir>/logs.db) when the old stack is deleted — it is no longer
    // written or read by the live app.
    try {
      initLogging({ emit: emitWithMerge, dbPath: join(getDataDirectory(), 'transcripts.db') })
    } catch (err) {
      logError(`[logs] initLogging failed; session logging disabled this run: ${(err as Error)?.message ?? err}`)
    }
    // Logs v2 read surface (the transcript-chat viewer). Registered AFTER
    // initLogging so the new-messages push can subscribe to the live supervisor;
    // the request/response handlers resolve the supervisor lazily per call and
    // reject cleanly when logging is disabled.
    registerLogs2Handlers(getWindow)
    // Tokenomics rebuild: start the better-sqlite3 indexing worker supervisor
    // (forked; native dep lives ONLY in the worker — this stays main-clean) and
    // register the new read-surface handlers. The worker ingests from raw
    // transcripts on its own timer/fs-watch — the statusline tick no longer
    // feeds tokenomics (that path drove the ~30s UI freeze).
    try { initTokenomics({ emit: emitWithMerge }) } catch (err) { logError(`[tokenomics] init failed: ${(err as Error)?.message ?? err}`) }
    registerTokenomics2Handlers(getWindow)
    startEffortTracker()
    startAttentionSource()
    startJankDetector()
    // Main-process event-loop jank monitor: feeds the "Jank m/c" main half on the
    // Conductor services pill (getMergedDiagnostics stamps stallsLastMin() onto
    // every service). Stopped in before-quit.
    startLoopStallMonitor()
    registerHooksHandlers(getGateway()!)   // B1: handlers get whatever gateway backs the singleton
    // D1b: diagnostics IPC. The getter returns null in the hooks-disabled branch
    // (supervisor never set) -> the handler serves an honest synthetic "hooks off" snapshot.
    registerServiceHealthHandlers(getSup, getPtyDiag)
    if (hooksEnabled) {
      cleanupStaleHookEntries(new Set())   // supervisor.start() already fired proxy.start()
    }
    // U4: sweep leaked per-session mcp-<sid>.json sidecars (removed on normal
    // dispose; a crash leaves them). Independent of hooks.
    cleanupStaleMcpConfigs(new Set())

    // Shell — open URLs in system browser
    ipcMain.handle('shell:openExternal', async (_event, url: unknown) => {
      // P1.2: parse + require https rather than a startsWith prefix check, and
      // hand the OS only the normalized href (never raw renderer input).
      const href = safeExternalHttpsHref(url)
      if (href) await shell.openExternal(href)
    })

    // Fetch model pricing in background (non-blocking)
    fetchModelPricing().catch(() => {})

    // Clean up legacy CLAUDE.md vision markers
    cleanupLegacyVisionMarkers()

    // Start the Conductor MCP server unconditionally so the fetch_host_screenshot
    // tool is available for image transfer (snap, storyboard, clipboard paste)
    // in BOTH local and SSH sessions, regardless of whether browser vision is enabled.
    // P7.2: resolve port from build mode (dev binds 19433, prod 19333) so dev
    // + prod can coexist on the same machine without EADDRINUSE. The
    // GlobalVisionConfig.mcpPort field is now deprecated and ignored -- per-session
    // settings rewrite the mcpServers URL to this instance's actual port
    // (see per-session-settings.ts).
    const mcpPort = resolveConductorMcpPort(isPackagedApp())
    startConductorMcpServer(mcpPort).catch(err => {
      logError(`[main] Conductor MCP server startup failed: ${err?.message}`)
    })

    // P7.3: Browser-vision sub-tool auto-starts at boot (MCP server is always up).
    //
    // DEFERRED (boot resilience): launching headless Chrome is heavy and, on a
    // busy machine, competing with the renderer's initial load could starve the
    // main process and leave the window stuck/unshown. Wait until the renderer
    // has finished loading (+ a short settle), so the UI paints first, then bring
    // vision up. Fallback timer launches it anyway if the load signal never comes.
    {
      let visionStarted = false
      const startVisionOnce = () => {
        if (visionStarted) return
        visionStarted = true
        startBrowserAtBoot(getWindow).catch(err => {
          logError(`[main] Vision auto-start failed: ${err?.message}`)
        })
      }
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.once('did-finish-load', () => setTimeout(startVisionOnce, 1500))
      }
      setTimeout(startVisionOnce, 8000)
    }

    // Start update system
    // Dev mode: run the local update server + source watcher for live-reload workflow
    // Production mode: no local polling — updates are checked exclusively against
    //   GitHub releases via the check-for-updates button (see github-update.ts).
    // #120 boot-timing: temporary instrumentation to pinpoint the ~26s boot
    // stall. Logs each synchronous step's wall-clock duration. Remove once found.
    const bootStep = (label: string, fn: () => void) => {
      const s = performance.now()
      try { fn() } finally { logInfo(`[boot-timing] ${label}: ${Math.round(performance.now() - s)}ms`) }
    }

    const projectRoot = getProjectRootPath()
    if (!isPackagedApp()) {
      logInfo('[main] Dev mode: starting update server and local watcher')
      if (projectRoot) {
        bootStep('startUpdateServer', () => startUpdateServer(projectRoot))
      }
      bootStep('initUpdateWatcher', () => initUpdateWatcher(getWindow))
    } else {
      logInfo('[main] Production mode: updates via GitHub releases only')
    }

    // Start watching for statusline updates. Logs v2 (Task 8): register the
    // binder sink first so the continuous, exact transcript path carried by each
    // status JSON feeds discovery (lazy getter — no-op when logging is disabled).
    bootStep('setTranscriptPathSink', () => setTranscriptPathSink(routeTranscriptPath))
    bootStep('startStatuslineWatcher', () => startStatuslineWatcher(getWindow))

    // Start polling Anthropic service status
    bootStep('startServiceStatusPoller', () => startServiceStatusPoller(getWindow))
    // Let a freshly-mounted renderer pull the cached status immediately, rather
    // than waiting up to a full poll interval for the next push (the title-bar
    // status pills were blank until the next poll because the immediate poll
    // fired before the renderer subscribed, behind the startup splash).
    ipcMain.handle(IPC.SERVICE_STATUS_GET, () => getLastServiceStatus())
  }).catch((err) => {
    // A throw anywhere in the boot sequence above abandons every subsequent
    // subsystem registration (handlers, logging, hooks gateway, statusline,
    // service pollers) -- the window may still appear but be half-wired. Don't
    // ghost the user: log loudly and surface a dialog so a partial boot is
    // diagnosable rather than reported as random missing features.
    logError('[boot] startup failed -- the app may be partially initialised:', err)
    try {
      dialog.showErrorBox(
        'Claude Command Center failed to start cleanly',
        `Startup hit an error and some features may not work. Please restart the app.\n\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      )
    } catch { /* dialog unavailable (very early failure) */ }
  })

  app.on('before-quit', () => {
    logInfo('App quitting...')
    // S5: mark the supervisor shutting-down BEFORE killAllPty() so a hooks-child
    // exit during teardown does NOT trigger a restart (race-free shutdown).
    try { _hooksSupervisor?.shutdown() } catch { /* never started / hooks disabled */ }
    // Flush + tear down session logging BEFORE killAllPty so a final batch is
    // written and the worker shuts down cleanly. No-op when never init / disabled.
    try { shutdownLogging() } catch { /* never init / disabled */ }
    // Tear down the tokenomics indexing worker. No-op when never init.
    try { shutdownTokenomics() } catch { /* never init */ }
    stopServiceStatusPoller()
    stopLoopStallMonitor()
    stopUpdateWatcher()
    stopUpdateServer()
    disableDebugMode()
    stopGlobalVision()
    // stopGlobalVision is async + fire-and-forget here, so its trailing browser
    // teardown may not run before the process exits. killSpawnedBrowser is sync
    // + idempotent — call it directly so the headless Chrome tree dies on quit.
    killSpawnedBrowser()
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
