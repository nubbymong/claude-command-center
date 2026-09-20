import { app, BrowserWindow, ipcMain, dialog, session, shell, powerMonitor } from 'electron'
import { join } from 'path'
import { homedir } from 'os'
import { existsSync, mkdirSync, readdirSync } from 'fs'
import { registerPtyHandlers } from './ipc/pty-handlers'
import { createSplashWindow, closeSplashWindow, SPLASH_MIN_MS, SPLASH_POST_READY_MS, splashShownAt } from './splash-window'
import { registerUsageHandlers } from './ipc/usage-handlers'
import { registerAccountWebHandlers } from './ipc/account-web-handlers'
import { sweepAbandonedProfiles } from './account-web/sign-in'
import { killAllPty, gracefulExitAllPty, isSessionWritable, writePty, writeSubmittedLine } from './pty-manager'
import { registerResumeHandlers } from './ipc/resume-handlers'
import { registerCliHandlers } from './ipc/cli-handlers'
import { registerClipboardHandlers } from './ipc/clipboard-handlers'
import { buildAndSetAppMenu } from './app-menu'
import { registerLogs2Handlers, registerLogsWipeHandlers } from './ipc/logs2-handlers'
import { registerCanvasHandlers } from './ipc/canvas-handlers'
import {
  registerCccUxSchemePrivileges,
  registerCccUxProtocolHandler,
  installCanvasFrameNavigationGuard,
  installCanvasPermissionGuard,
} from './canvas/ccc-ux-protocol'

import { startStatuslineWatcher, setTranscriptPathSink, setStatuslineUsageSink, healGlobalStatusline } from './statusline-watcher'
import { recordLiveUsageForSession } from './usage/account-usage'
import { registerProvider, getProvider } from './providers'
import { ClaudeProvider } from './providers/claude'
import { CodexProvider } from './providers/codex'
import { registerDebugHandlers } from './ipc/debug-handlers'
import { disableDebugMode } from './debug-capture'
import { registerUpdateHandlers } from './ipc/update-handlers'
import { adoptRenamedRepoIfLive } from './github-update'
import { registerSetupHandlers, getResourcesDirectory, getDataDirectory } from './ipc/setup-handlers'
// Direct from data-paths, not the handlers barrel: this runs at module scope
// before app-ready, so it must not pull the IPC registration side of that module
// in ahead of time.
import { devSessionDataDir } from './data-paths'
import { ensureHelpWorkspace } from './help-workspace'
import { registerScreenshotHandlers } from './ipc/screenshot-handlers'
import { registerDiagnosticsHandlers } from './ipc/diagnostics-handlers'
import { registerWebviewHandlers } from './ipc/webview-handlers'
import { closeAllWebviews } from './webview-manager'
import { closeAllAccountPanes, closeAccountPanesForProfile } from './account-web/account-pane'
import { onPartitionRevoked } from './account-web/partition-revocation'
import { removeWebSession } from './account-web/session-store'
import { registerInsightsHandlers } from './ipc/insights-handlers'
import { registerNotesHandlers } from './ipc/notes-handlers'
import { registerVisionHandlers } from './ipc/vision-handlers'
import { registerConfigHandlers } from './ipc/config-handlers'
import { registerAccountProfilesHandlers } from './ipc/account-profiles-handlers'
import { migrateProfilesToHomeLayout, cleanupSessionHomes, syncPrimaryCredentialsWithGlobal, repairSharedProjectJunctions } from './account-profiles'
import { runFirstRunCapture } from './first-run-accounts'
import { backupRealClaudeOnce } from './claude-backup'
import { registerCloudAgentHandlers } from './ipc/cloud-agent-handlers'
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
import { registerExeHandlers, stopAllCapturedRuns } from './ipc/exe-handlers'
import { registerRegistryHandlers } from './ipc/registry-handlers'
import { initSentinel, reconcileOnUpdate, sentinelStartupCheck } from './sentinel/index'
import { registerSentinelHandlers } from './ipc/sentinel-handlers'
import { registerChannelHandlers } from './ipc/channel-handlers'
import { registerWatchdogHandlers } from './ipc/watchdog-handlers'
import { initWatchdogManager, getWatchdogManager } from './watchdog/watchdog-manager'
import { startRulesEngine } from './channel-rules'
import { startEffortTracker } from './effort-tracker'
import { startCanvasMarkerQueue } from './canvas/canvas-marker-delivery'
import { startAttentionSource } from './attention-source'
import { startJankDetector } from './jank-detector'
import { HooksGateway } from './hooks/hooks-gateway'
import { setGateway, getGateway, isExactBindSourceActive } from './hooks'
import { ServiceSupervisor } from './services/service-supervisor'
import { forkHooksChild } from './services/fork-hooks-child'
import { start as startLoopStallMonitor, stop as stopLoopStallMonitor } from './services/loop-stall-monitor'
import { initLogging, shutdownLogging, getTranscriptBinder } from './logging/logging-service'
import { backfillCompanionDirsAsync, nodeFsCompanionDeps } from './logging/companion-dir'
import { cleanupStaleHookEntries, cleanupStaleMcpConfigs } from './hooks/boot-cleanup'
import { isSentinelEnabled } from '../shared/sentinel-enabled'
import { resolveHooksPort } from './hooks/hooks-types'
import { fetchModelPricing } from './tokenomics/tk-pricing'
import { killAllAgents } from './cloud-agent-manager'
import { startServiceStatusPoller, stopServiceStatusPoller, getLastServiceStatus } from './service-status'
import { initUpdateWatcher, stopUpdateWatcher, getProjectRootPath, isPackagedApp } from './update-watcher'
import { startUpdateServer, stopUpdateServer } from './update-server'
import { saveSessionState, loadSessionState, clearSessionState, hasSavedSessionState, SessionState } from './session-state'
import { createSessionDurability } from './session-durability'
import { resolveResumeTargetFromTranscript } from './logging/transcript-discovery'
import { getConfigDir, snapshotConfig, readConfig } from './config-manager'
import { stopGlobalVision, killSpawnedBrowser, cleanupLegacyVisionMarkers } from './vision-manager'
import { startConductorMcpServer, stopConductorMcpServer, startBrowserAtBoot } from './conductor-mcp-server'
import { loadWindowState, clampToVisibleDisplay, saveWindowStateFor } from './window-state'
import { registerCredentialHandlers } from './ipc/credentials-handlers'
import { resolveConductorMcpPort } from '../shared/mcp-ports'
import { IPC } from '../shared/ipc-channels'
import { safeExternalHttpsHref } from '../shared/safe-url'
import { CSP_POLICY } from '../shared/csp-policy'

import { migrateRegistryKeys } from './registry'
import { installGlobalErrorHandlers, logInfo, logError, closeDebugLogger, setVerboseBaseline } from './debug-logger'
import { createCloseCoordinator, onAllWindowsClosed } from './window-close-coordinator'

// Install global error handlers that log to file
installGlobalErrorHandlers()

// #397: the cross-exit session-state durability core. `session:save` routes every
// renderer writer (autosave, account flush, GitHub flush, Save-&-Close) through
// saveEnriched — enriching each Claude session's exact resume target from the live
// transcript binder — so EVERY persisted file is resumable, not only the graceful
// close (Group 1), and the old autosave-clobber race dissolves. flushOnExit persists
// the cached state on any non-graceful exit (Group 2); noteCleared drops the cache
// on an intentional clear so the flush never resurrects a discarded set (F1). The
// binder is read lazily per call — it may init after this module loads.
const sessionDurability = createSessionDurability({
  enrichDeps: {
    // #480: exact bind is the source of truth; the heuristic path is used only as
    // the hooks-off fallback (gated by isExactBindSourceActive) so this main-side
    // enrichment can never persist a cross-prone heuristic guess in the default
    // (hooks-on) config — matching the resume-handlers IPC.
    getExactResumeTarget: (id) => getTranscriptBinder()?.getExactResumeTarget(id) ?? null,
    getLatestTranscriptPath: (id) => getTranscriptBinder()?.getLatestTranscriptPath(id) ?? null,
    isExactBindSourceActive,
    resolveResumeTargetFromTranscript,
  },
  save: saveSessionState,
  log: logInfo,
})

// Multi-instance (dev alongside prod): a dev build must NOT share prod's data
// dir (CONFIG/sessions/transcripts/profiles). Point it at a dedicated dev root
// BEFORE anything reads the data dir or forks a worker (workers inherit this
// env). The ccc launcher may set it too — respect an existing value. No-op for
// a packaged (prod) build, so production behaviour is completely unchanged.
if (!app.isPackaged && !process.env.CCC_DEV_DATA_DIR) {
  const base =
    process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support', 'Claude Conductor')
      : process.platform === 'linux'
        ? join(homedir(), '.claude-conductor', 'data')
        : join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'Claude Command Center')
  process.env.CCC_DEV_DATA_DIR = join(base, 'dev')
}

// ...and point Electron's SESSION data at the dev root too (#261). `persist:`
// partitions live under `sessionData`, which defaults to `userData`, so without
// this a dev instance wrote the per-account claude.ai web sessions (#216) into the
// very same %APPDATA%\claude-conductor\Partitions a PROD install uses — dev and
// prod shared them, signing out in one revoked the other, and `ccc --clean` left a
// live sessionKey on disk because the partition was never under the dev data dir.
//
// MUST be before app-ready and before any session exists, which is why it sits at
// module scope next to the block above. Dev/E2E only: `devSessionDataDir` returns
// null for a packaged build, so production keeps Electron's default and nobody
// gets logged out by a path move.
const devSessionDir = devSessionDataDir(process.env, app.isPackaged)
if (devSessionDir) {
  try {
    mkdirSync(devSessionDir, { recursive: true })
    app.setPath('sessionData', devSessionDir)
    // Logged via logInfo, NOT console.log: debug-logger does not patch console or
    // hook stdout, so a console line reaches the terminal and the `ccc` tee but
    // never the debug log an operator actually reads — and it is absent entirely
    // under a bare `npm run dev`. The failure mode here is invisible otherwise:
    // partitions just appear in the shared location and nothing says they did.
    logInfo(`[setup] Dev session data redirected to: ${devSessionDir}`)
    warnAboutOrphanedSharedPartitions(devSessionDir)
  } catch (err) {
    // Not fatal: worst case partitions land in the default location, which is
    // exactly the pre-#261 behaviour. Say so rather than failing to boot.
    logError(`[setup] could not redirect dev sessionData to ${devSessionDir}: ${(err as Error)?.message ?? err}`)
  }
}

/**
 * Point out claude.ai partitions this dev instance left in the SHARED location
 * before the redirect existed (#261).
 *
 * WARN, NEVER DELETE. Those directories hold live `sessionKey` cookies and after
 * the redirect nothing references them: `ccc --clean` cannot reach them (wrong
 * root) and `sweepAbandonedProfiles` only walks `<dataDir>/account-web`. So they
 * would sit there forever, which is the very complaint the redirect is meant to
 * fix. But automatic removal is NOT safe: `ccc --seed-accounts` copies prod's
 * account profiles into dev, so a partition named for a dev profile id can be
 * the PROD install's live session. Deleting it would sign the user out of their
 * real account to tidy up a dev artifact. Naming the path and leaving the choice
 * to a human is the correct trade here.
 */
function warnAboutOrphanedSharedPartitions(newLocation: string): void {
  try {
    const shared = join(app.getPath('userData'), 'Partitions')
    if (shared === join(newLocation, 'Partitions') || !existsSync(shared)) return
    const orphans = readdirSync(shared).filter((n) => n.startsWith('claude-web-'))
    if (!orphans.length) return
    logInfo(
      `[setup] ${orphans.length} claude.ai web session partition(s) remain in the SHARED location `
      + `and are no longer used by this dev instance: ${shared}. They hold live session cookies. `
      + `Remove them by hand ONLY if you are sure they are not your production install's `
      + `(see docs/dev-alongside-prod.md).`,
    )
  } catch { /* advisory only — never let a warning break boot */ }
}

// Migrate registry keys from old "Claude Conductor" → new "Claude Command Center"
migrateRegistryKeys()

// Agent Canvas serving scheme (ccc-ux://). Privilege registration is only
// honoured BEFORE app ready, so it lives here at module scope; the actual
// protocol handler is installed inside whenReady, before any window exists.
registerCccUxSchemePrivileges()

let mainWindow: BrowserWindow | null = null
// rc.14 review F2/F3: ONE decision for "may the app go away", shared by the
// window's close event and the app's before-quit (window-close-coordinator.ts).
// The teardown body is assigned where the app wiring lives (see before-quit);
// the coordinator exists before any window so its IPC listeners can be
// registered once per process (registerMainWindowIpc).
let quitTeardown: () => void = () => {}
const closeCoordinator = createCloseCoordinator({
  hasWindow: () => !!mainWindow && !mainWindow.isDestroyed(),
  askRenderer: () => { mainWindow?.webContents.send('window:closeRequested') },
  closeWindow: () => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close() },
  quit: () => { app.quit() },
  teardown: () => { quitTeardown() },
})
let _hooksSupervisor: ServiceSupervisor | null = null
function setHooksSupervisor(s: ServiceSupervisor): void { _hooksSupervisor = s }
function getHooksSupervisor(): ServiceSupervisor | null { return _hooksSupervisor }

// rc.14 review F3 (aicc_planning#47): everything in here registers a
// PROCESS-GLOBAL ipcMain listener. On macOS the app outlives its last window
// and the dock click calls createWindow() again; a second ipcMain.handle() for
// a channel THROWS (Electron rejects duplicate handlers), which left the
// reopened window hidden and unloaded -- or crashed the app through the
// rethrowing uncaught-exception handler. So this runs ONCE per process, not
// once per window. Every handler reaches the window through the module-level
// `mainWindow` (never a closure over one createWindow() call), and the
// close-dialog state lives in `closeCoordinator` for the same reason.
let windowIpcRegistered = false
function registerMainWindowIpc(): void {
  if (windowIpcRegistered) return
  windowIpcRegistered = true
  // Renderer calls this after saving sessions and graceful exit
  ipcMain.on('window:allowClose', () => closeCoordinator.onAllowClose())

  // Renderer calls this when user cancels the close dialog
  ipcMain.on('window:cancelClose', () => closeCoordinator.onCancelClose())

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
    // #397 Group 2: destroy() bypasses the 'close' event and the graceful save;
    // persist the last-known session state before the window is torn down.
    sessionDurability.flushOnExit('window:forceClose')
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

  registerClipboardHandlers()

  // Encrypted credential storage using safeStorage. save/delete are keyed to the
  // app's own id shape (credentials-handlers.ts): a renderer can address the
  // SSH/sudo/argsecret/cmdsecret namespaces of a real config or command and
  // nothing else, so it cannot overwrite or delete an arbitrary key (private
  // advisory, 2026-08-22).
  registerCredentialHandlers()

  // No 'credentials:load' handler: a credential's value is injected into the
  // shell environment at spawn (pty-handlers) and never handed to the renderer.

  // Session state persistence IPC handlers
  ipcMain.handle('session:save', async (_event, state: SessionState) => {
    return sessionDurability.saveEnriched(state)
  })

  ipcMain.handle('session:load', async () => {
    return loadSessionState()
  })

  ipcMain.handle('session:clear', async () => {
    const ok = clearSessionState()
    // #397 F1: a successful clear is the user intentionally discarding the saved set
    // (Don't-open / Close-without-saving). Drop the cache so the exit-time flush
    // cannot resurrect it on the next launch.
    if (ok) sessionDurability.noteCleared()
    return ok
  })

  ipcMain.handle('session:hasSaved', async () => {
    return hasSavedSessionState()
  })

  // Graceful shutdown - exit all Claude sessions cleanly
  ipcMain.handle('session:gracefulExit', async () => {
    await gracefulExitAllPty(5000)
    return true
  })

  registerCliHandlers()
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

  // rc.14 review F3: a (re)created window starts with a fresh close decision --
  // the previous window's Save left `allowClose` set in the shared coordinator.
  closeCoordinator.onWindowCreated()

  // Prevent navigation away from the app
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  // ...and the SUBFRAME half, which `will-navigate` does not cover: an Agent
  // Canvas frame may never leave the canvas+version it was mounted for. See
  // installCanvasFrameNavigationGuard for the two primitives that closes.
  installCanvasFrameNavigationGuard(mainWindow.webContents)

  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' }
  })

  mainWindow.on('ready-to-show', () => {
    if (process.env.E2E_HEADLESS === '1') {
      mainWindow!.setPosition(-10000, -10000)
      mainWindow!.showInactive()
      closeSplashWindow()
    } else {
      // Hold the splash until its lockup has formed AND for a beat after the
      // window is ready, so the finished brand mark is clearly shown before the
      // reveal (the main window stays hidden behind the splash during the hold).
      const elapsed = Date.now() - splashShownAt
      const wait = Math.max(0, SPLASH_MIN_MS - elapsed) + SPLASH_POST_READY_MS
      setTimeout(() => {
        // Maximize BEFORE show to avoid flash of non-maximized window
        if (state.isMaximized) mainWindow!.maximize()
        mainWindow!.show()
        closeSplashWindow()
      }, wait)
    }
  })

  mainWindow.on('close', (e) => {
    if (mainWindow) saveWindowStateFor(mainWindow)
    // Ask-before-close lives in the coordinator, shared with before-quit so
    // Cmd+Q on macOS gets the same dialog BEFORE any teardown (rc.14 review F2).
    closeCoordinator.onWindowClose(() => e.preventDefault())
  })

  // #397 Group 2: a renderer crash / OOM kills the window before it can run its
  // graceful save. Persist the last-known session state so the sessions survive.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    sessionDurability.flushOnExit(`render-process-gone (${details?.reason ?? 'unknown'})`)
    // A renderer that is gone can never answer window:closeRequested: a close
    // or quit already held on it would otherwise hold forever, and a later one
    // would hang the same way (adversarial pass on #598). A clean exit is the
    // renderer going away on purpose (a reload, a navigation), not a death:
    // the next renderer in this window can still be asked.
    if (details?.reason !== 'clean-exit') closeCoordinator.onRendererGone()
  })

  // Process-global IPC (window controls, dialogs, clipboard, session state, CLI
  // probes): registered once, see registerMainWindowIpc.
  registerMainWindowIpc()

  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximized-changed', true)
  })
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximized-changed', false)
  })

  // DEV instance labeling: stamp the OS window/taskbar title so a dev window is
  // unmistakable next to a running prod window. Guard page-title-updated so the
  // renderer's <title> can't overwrite it. No-op in prod.
  if (!app.isPackaged) {
    const devTitle = 'AI Code Conductor — DEV'
    mainWindow.on('page-title-updated', (e) => { e.preventDefault(); mainWindow?.setTitle(devTitle) })
    mainWindow.setTitle(devTitle)
  }

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
    // Refresh the help workspace at boot (#586), not only on Ask launch: the
    // installed helper skill's body POINTS at help/app-knowledge.md, so the
    // docs must match the running app version before any session invokes the
    // skill -- which can happen without Ask Conductor ever being opened.
    // Best-effort: a failure here leaves the Ask-launch refresh as the
    // fallback, exactly as before.
    try {
      const rd = getResourcesDirectory()
      if (rd) ensureHelpWorkspace(rd, { appVersion: app.getVersion() })
    } catch { /* fail-closed handled at Ask launch */ }

    // #397 Group 2: exit paths that skip app 'before-quit'. An OS shutdown/logoff
    // (powerMonitor; macOS/Linux) and SIGTERM (task-manager terminate / OS teardown)
    // can end the app without the window-close flow running. Persist sessions first.
    powerMonitor.on('shutdown', () => sessionDurability.flushOnExit('powerMonitor shutdown'))
    powerMonitor.on('suspend', () => sessionDurability.flushOnExit('powerMonitor suspend'))
    // Only SIGTERM. SIGINT is intentionally LEFT to Node's default so a console
    // Ctrl+C on a dev run still terminates in one press — a SIGINT handler here
    // re-entered the vetoable graceful-close dialog and left the app alive
    // (adversarial-review round-2). Flush, then exit HARD: app.quit() would be
    // vetoed by that same dialog, so a signal must not route through it.
    process.on('SIGTERM', () => {
      sessionDurability.flushOnExit('SIGTERM')
      app.exit(0)
    })

    // Expose dev/prod build mode to the renderer for DEV labeling (title + badge
    // + accent). Registered early so the renderer can read it on first paint.
    ipcMain.handle(IPC.APP_IS_DEV, () => !app.isPackaged)

    buildAndSetAppMenu()

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

    // Content Security Policy. This header path only reaches the renderer in
    // dev (loadURL → http://localhost); the packaged renderer loads via
    // file://, which a header cannot reach — that build is covered by the
    // matching <meta> CSP in src/renderer/index.html. Both use CSP_POLICY so
    // dev and prod enforce the identical policy.
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      // ccc-ux:// (Agent Canvas) responses carry their OWN per-mode CSP set by
      // the protocol handler — replacing it with the renderer policy here would
      // both weaken the canvas policy (localhost connect-src) and break its
      // content (script-src 'wasm-unsafe-eval' only). Pass them through.
      if (details.url.startsWith('ccc-ux://')) {
        callback({ responseHeaders: details.responseHeaders })
        return
      }
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [CSP_POLICY]
        }
      })
    })

    // Agent Canvas content serving — must be registered before any renderer
    // exists so a restored session's canvas iframe can load immediately.
    registerCccUxProtocolHandler()
    // ...and canvas content gets no powerful features. Same session, so this is
    // origin-scoped rather than blanket (the app's own clipboard writes go
    // through the same handler) — see installCanvasPermissionGuard.
    installCanvasPermissionGuard(session.defaultSession)

    createSplashWindow()
    try {
      createWindow()
    } catch (err) {
      // A failed main-window creation must not leave the splash pinned
      // on-screen forever (the backstop would eventually catch it, but
      // close now so a fatal boot doesn't hang behind an orphan splash).
      logInfo(`[main] createWindow failed: ${err}`)
      closeSplashWindow()
      throw err
    }

    const getWindow = () => mainWindow
    registerPtyHandlers(getWindow)
    registerUsageHandlers()
    registerAccountWebHandlers()
    // #439: when a partition is wiped (sign-out / delete / cancelled sign-in),
    // sign-in.ts emits a revocation through the decoupling seam; wire the owners
    // here so it never has to import their heavy graphs. Both run synchronously.
    onPartitionRevoked(removeWebSession)
    onPartitionRevoked(closeAccountPanesForProfile)
    // #216: a crash or forced quit can leave a sign-in browser profile behind, and
    // each one holds a live claude.ai session. Sweep them at boot.
    try { sweepAbandonedProfiles(getDataDirectory()) } catch { /* best effort */ }
    registerResumeHandlers()
    // Ahead of initLogging + the register*() run below on purpose: nothing
    // between here and there may throw and skip the first-run wipe prompt.
    registerLogsWipeHandlers()
    registerDebugHandlers()
    registerUpdateHandlers()
    // Pre-emptive repo-rename handling: if the app has been renamed on GitHub
    // (claude-command-center -> ai-code-conductor) adopt + persist the new repo
    // for updates; else stay on the current one. Non-blocking, fail-safe.
    void adoptRenamedRepoIfLive()
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
    registerConfigHandlers({
      // #266 MAJOR-2: unticking the watchdog must tear down RUNNING watchers.
      onSettingsSaved: () => getWatchdogManager()?.applySettings(),
    })
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
    // Self-heal the per-profile shared junctions (projects/memory/agents/skills/
    // commands/plugins): recover an orphaned REAL projects dir into the shared
    // store (#131), AND rebuild any BROKEN junction -- most importantly a
    // self-referential one (target === link), an ELOOP that wedges memory/projects
    // recall and resume. Idempotent + best-effort; only touches per-profile shared
    // links + the shared store.
    try { repairSharedProjectJunctions() } catch (e) { logInfo(`[profiles] shared-junction repair skipped: ${e}`) }
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
    registerDiagnosticsHandlers(getWindow)
    registerWebviewHandlers(getWindow)
    registerInsightsHandlers(getWindow)
    registerNotesHandlers()
    registerVisionHandlers(getWindow)
    registerCodexHandlers()
    registerCodexReviewHandlers()
    registerExeHandlers()
    registerChannelHandlers()
    startRulesEngine()
    registerCloudAgentHandlers(getWindow)
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
        // Through the durability core, never saveSessionState directly: a
        // direct write leaves the exit-flush cache stale, so the flush on
        // quit would overwrite this very patch with the pre-patch state —
        // reverting the GitHub binding (or a cleanup that removed one) on
        // the next launch (independent review of #413, R3).
        sessionDurability.saveEnriched({
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
    const hooksPort = hooksSettings?.hooksPort ?? resolveHooksPort(isPackagedApp())
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
    const getWatchdogDiag = () => getWatchdogManager()
    const pushDiagnostics = () => emitToWindow(IPC.SERVICE_HEALTH_UPDATE, getMergedDiagnostics(getSup, getPtyDiag, getWatchdogDiag))
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
    // Agent Canvas (2.2): renderer read surface + change push over the canvas
    // store. Serving itself is the ccc-ux:// protocol registered above.
    registerCanvasHandlers(getWindow)
    // Tokenomics rebuild: start the better-sqlite3 indexing worker supervisor
    // (forked; native dep lives ONLY in the worker — this stays main-clean) and
    // register the new read-surface handlers. The worker ingests from raw
    // transcripts on its own timer/fs-watch — the statusline tick no longer
    // feeds tokenomics (that path drove the ~30s UI freeze).
    try { initTokenomics({ emit: emitWithMerge }) } catch (err) { logError(`[tokenomics] init failed: ${(err as Error)?.message ?? err}`) }
    registerTokenomics2Handlers(getWindow)
    startEffortTracker()
    // #580: the canvas marker queue watches the same hook stream for the agent's
    // turn boundary, so a verdict filed mid-turn is held rather than swallowed.
    // Both ends are injected here so the canvas IPC module needs no static
    // import of pty-manager or the gateway (see canvas-marker-delivery.ts).
    startCanvasMarkerQueue({
      // The same submit shape every other programmatic line into the Claude TUI
      // uses (the watchdog retry, the command buttons, the launch line).
      write: (sessionId, line) => writeSubmittedLine(sessionId, line),
      subscribe: (cb) => {
        const gw = getGateway()
        if (!gw) return
        gw.subscribe((e) => { if (e.sessionId) cb(e.sessionId, e.event) })
      },
    })
    startAttentionSource()
    startJankDetector()
    // Main-process event-loop jank monitor: feeds the "Jank m/c" main half on the
    // Conductor services pill (getMergedDiagnostics stamps stallsLastMin() onto
    // every service). Stopped in before-quit.
    startLoopStallMonitor()
    registerHooksHandlers(getGateway()!)   // B1: handlers get whatever gateway backs the singleton
    // Session Watchdog (#235): wired after the gateway singleton exists so its
    // StopFailure subscription binds immediately. send() submits the retry the
    // same way the command-button / launch paths do — writePty(text + '\r') —
    // which is the proven way to submit into the Claude TUI. (The channel-bus
    // paste envelope does NOT submit: formatTier1 ends at the bracketed-paste
    // close with no trailing Enter, so it only drafts. A bracketed paste with a
    // fused Enter is also swallowed by the Ink/React TUI.) The retry text is
    // already sanitized in config.ts to a single control-char-free line, so the
    // lone appended '\r' is the only submit and cannot be broken out of.
    initWatchdogManager({
      getWindow,
      isSessionAlive: isSessionWritable,
      send: (sessionId, text) => {
        writeSubmittedLine(sessionId, text)
      },
      // Refresh the services view live when a watchdog state changes; routed
      // through the same merge so the push carries every source (#235).
      onHealthChange: () => pushDiagnostics(),
    })
    registerWatchdogHandlers()
    // D1b: diagnostics IPC. The getter returns null in the hooks-disabled branch
    // (supervisor never set) -> the handler serves an honest synthetic "hooks off" snapshot.
    registerServiceHealthHandlers(getSup, getPtyDiag, getWatchdogDiag)
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
    startConductorMcpServer(mcpPort, getWindow).catch(err => {
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

    // Start watching for statusline updates. Logs v2 (Task 8): register the
    // binder sink first so the continuous, exact transcript path carried by each
    // status JSON feeds discovery (lazy getter — no-op when logging is disabled).
    setTranscriptPathSink(routeTranscriptPath)
    // Plan P2: harvest each live session's delivered usage so the account-usage
    // page can reuse an OPEN account's figure rather than making a redundant call.
    setStatuslineUsageSink(recordLiveUsageForSession)
    startStatuslineWatcher(getWindow)

    // Start polling Anthropic service status
    startServiceStatusPoller(getWindow)
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
        'AI Code Conductor failed to start cleanly',
        `Startup hit an error and some features may not work. Please restart the app.\n\n${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
      )
    } catch { /* dialog unavailable (very early failure) */ }
  })

  // rc.14 review F2 (aicc_planning#46): on macOS, Cmd+Q emits before-quit
  // BEFORE any window close, so this body used to run -- every PTY, MCP,
  // logging, the watchdog -- and only then did the close dialog appear; Cancel
  // restored nothing. The coordinator now holds the first before-quit while a
  // window is up, asks the renderer, and re-issues the quit once the close is
  // allowed; this body runs on THAT pass, exactly once.
  quitTeardown = () => {
    logInfo('App quitting...')
    // #397 Group 2: persist sessions BEFORE the logging teardown below tears the
    // transcript binder down — flushing after that would lose the resume targets.
    sessionDurability.flushOnExit('before-quit')
    // S5: mark the supervisor shutting-down BEFORE killAllPty() so a hooks-child
    // exit during teardown does NOT trigger a restart (race-free shutdown).
    try { _hooksSupervisor?.shutdown() } catch { /* never started / hooks disabled */ }
    // Flush + tear down session logging BEFORE killAllPty so a final batch is
    // written and the worker shuts down cleanly. No-op when never init / disabled.
    try { shutdownLogging() } catch { /* never init / disabled */ }
    // Tear down the tokenomics indexing worker. No-op when never init.
    try { shutdownTokenomics() } catch { /* never init */ }
try { getWatchdogManager()?.disposeAll() } catch { /* never init */ }
    // Kill any GUI-subsystem tool still being captured (#379). Its stdio is
    // piped to us, so leaving it running orphans a process nobody can see.
    try { stopAllCapturedRuns() } catch { /* never started */ }
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
    closeAllAccountPanes()
    // Pull from the singleton barrel — `hooksGateway` declared inside the
     // app.whenReady() callback above is out of scope here, which threw an
     // uncaught ReferenceError on every quit and crashed the app before it
     // could emit any cleanup logs (visible in dev logs as the trigger that
     // killed an actively-spawning PTY mid-launch and removed its
     // settings-<sid>.json before claude could read it).
    try { getGateway()?.stop().catch(() => { /* ignore shutdown error */ }) } catch { /* gateway never started */ }
    closeDebugLogger()
  }
  app.on('before-quit', (e) => closeCoordinator.onBeforeQuit(() => e.preventDefault()))

  app.on('window-all-closed', () => {
    // On macOS, apps conventionally stay running when all windows are closed
    // (the user quits via Cmd+Q or the app menu) -- but not their PTYs: rc.15
    // review R6, see onAllWindowsClosed.
    onAllWindowsClosed({ platform: process.platform, quit: () => app.quit(), endStragglerPtys: killAllPty })
  })

  // On macOS, re-create the window when the dock icon is clicked and no windows exist
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
}

export { mainWindow }
