import { contextBridge, ipcRenderer } from 'electron'
import { IPC, ptyDataChannel, ptyExitChannel } from '../shared/ipc-channels'
import type { HookEvent, HooksGatewayStatus } from '../shared/hook-types'

export interface ElectronAPI {
  config: {
    loadAll: () => Promise<{ data: Record<string, unknown>; needsMigration: boolean }>
    save: (key: string, data: unknown) => Promise<boolean>
    migrateFromLocalStorage: (data: Record<string, unknown>) => Promise<boolean>
  }
  window: {
    minimize: () => void
    maximize: () => void
    close: () => void
    forceClose: () => void
    allowClose: () => void
    isMaximized: () => Promise<boolean>
    onMaximizedChanged: (callback: (maximized: boolean) => void) => () => void
    onCloseRequested: (callback: () => void) => () => void
  }
  dialog: {
    openFolder: () => Promise<string | null>
  }
  clipboard: {
    readImage: () => Promise<string | null>
    saveImage: () => Promise<string | null>
  }
  credentials: {
    save: (configId: string, password: string) => Promise<boolean>
    load: (configId: string) => Promise<string | null>
    delete: (configId: string) => Promise<boolean>
  }
  pty: {
    spawn: (sessionId: string, options?: {
      cwd?: string
      cols?: number
      rows?: number
      ssh?: {
        host: string
        port: number
        username: string
        remotePath: string
        postCommand?: string
      }
      configId?: string
      configLabel?: string
      useResumePicker?: boolean
      agentsConfig?: Array<{
        name: string; description: string; prompt: string
        model?: string; tools?: string[]
      }>
      effortLevel?: 'low' | 'medium' | 'high'
      disableAutoMemory?: boolean
    }) => Promise<void>
    write: (sessionId: string, data: string) => void
    resize: (sessionId: string, cols: number, rows: number) => void
    kill: (sessionId: string) => void
    onData: (sessionId: string, callback: (data: string) => void) => () => void
    onExit: (sessionId: string, callback: (exitCode: number) => void) => () => void
  }
  ssh: {
    /** Manually trigger the post-connect command stage. */
    runPostCommand: (sessionId: string) => Promise<void>
    /** Manually trigger the Claude launch stage. */
    launchClaude: (sessionId: string) => Promise<void>
    /** User opts out of any further auto-writes; PTY is theirs to drive. */
    skip: (sessionId: string) => Promise<void>
    /** One-shot query of the current flow state, used to recover from
     * a missed initial push (renderer subscribes after main has already
     * emitted). */
    getState: (sessionId: string) => Promise<{ state: string; info?: string }>
    /** Subscribe to flow-state changes for a session. */
    onFlowState: (sessionId: string, callback: (msg: { state: string; info?: string }) => void) => () => void
  }
  statusline: {
    onUpdate: (callback: (data: {
      sessionId: string
      model?: string
      contextUsedPercent?: number
      contextRemainingPercent?: number
      costUsd?: number
      totalDurationMs?: number
      linesAdded?: number
      linesRemoved?: number
    }) => void) => () => void
  }
  debug: {
    onDebug: (callback: (data: unknown) => void) => () => void
    enable: () => Promise<boolean>
    disable: () => Promise<boolean>
    isEnabled: () => Promise<boolean>
    openFolder: () => Promise<string>
  }
  usage: {
    getSessionUsage: (sessionId: string) => Promise<unknown>
    getTotalUsage: () => Promise<unknown>
    getUsageHistory: (hours: number) => Promise<unknown>
  }
  logs: {
    list: () => Promise<unknown[]>
    read: (logDir: string, offset?: number, limit?: number) => Promise<{ entries: unknown[]; total: number }>
    search: (logDir: string, query: string) => Promise<unknown[]>
    cleanup: (retentionDays?: number) => Promise<number>
  }
  discovery: {
    getProjects: () => Promise<unknown>
    getSessionHistory: (projectPath: string) => Promise<unknown>
  }
  update: {
    check: () => Promise<boolean>
    installAndRestart: () => Promise<boolean>
    onAvailable: (callback: (available: boolean) => void) => () => void
    onServerConnected: (callback: (connected: boolean) => void) => () => void
  }
  screenshot: {
    captureRectangle: () => Promise<string | null>
    captureWindow: (sourceId: string) => Promise<string | null>
    listWindows: () => Promise<Array<{ id: string; name: string; thumbnail: string }>>
    listRecent: () => Promise<Array<{ filename: string; path: string; timestamp: number; thumbnail: string }>>
    cleanup: (maxAgeDays: number) => Promise<number>
  }
  webview: {
    /** HEAD probe (CORS-bypass) — used by the activation poller. */
    check: (url: string) => Promise<{ reachable: boolean; status?: number }>
    /** Create a per-session WebContentsView and attach it at the given bounds. */
    open: (sessionId: string, url: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<boolean>
    /** Detach + destroy the session's view. */
    close: (sessionId: string) => Promise<boolean>
    /** Re-position on resize/scroll. */
    setBounds: (sessionId: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<void>
    /** Attach/detach without destroying — used to hide on session switch. */
    setVisible: (sessionId: string, visible: boolean) => Promise<void>
    /** Force-reload bypassing cache. */
    reload: (sessionId: string) => Promise<void>
    /** Capture as PNG dataURL — used by the freeze flow. */
    capture: (sessionId: string) => Promise<string | null>
    navBack: (sessionId: string) => Promise<void>
    navForward: (sessionId: string) => Promise<void>
    goHome: (sessionId: string) => Promise<void>
    /** Emergency: destroy every WebContentsView. Used by the global Esc / "Close webview" pill. */
    closeAll: () => Promise<boolean>
    /**
     * Subscribe to "user pressed Esc inside a WebContentsView". Without
     * this, key events go to the embedded webContents and never reach
     * the App-level Esc handler — so a stuck/oversized view couldn't
     * be dismissed by keyboard. Returns an unsubscribe fn.
     */
    onEscapePressed: (handler: (sessionId: string) => void) => () => void
  }
  session: {
    save: (state: unknown) => Promise<boolean>
    load: () => Promise<unknown | null>
    clear: () => Promise<boolean>
    hasSaved: () => Promise<boolean>
    gracefulExit: () => Promise<boolean>
  }
  notes: {
    list: () => Promise<Array<{ id: string; label: string; color: string; configId?: string; createdAt: number }>>
    load: (id: string) => Promise<string | null>
    save: (id: string, label: string, content: string, color: string, configId?: string) => Promise<boolean>
    delete: (id: string) => Promise<boolean>
    reorder: (ids: string[]) => Promise<boolean>
  }
  shell: {
    openExternal: (url: string) => Promise<void>
  }
  codex: {
    status: () => Promise<{
      installed: boolean
      version: string | null
      authMode: 'chatgpt' | 'api-key' | 'none'
      planType?: string
      accountId?: string
      hasOpenAiApiKeyEnv: boolean
    }>
    login: (payload: { mode: 'chatgpt' | 'api-key' | 'device'; apiKey?: string }) => Promise<{
      ok: boolean
      browserUrl?: string
      deviceCode?: string
      error?: string
    }>
    logout: () => Promise<{ ok: boolean }>
    testConnection: () => Promise<{ ok: boolean; message: string }>
  }
  github: GitHubBridge
  hooks: HooksBridge
}

interface HooksBridge {
  toggle: (enabled: boolean) => Promise<HooksGatewayStatus>
  getBuffer: (sessionId: string) => Promise<HookEvent[]>
  getStatus: () => Promise<HooksGatewayStatus>
  onEvent: (cb: (e: HookEvent) => void) => () => void
  onSessionEnded: (cb: (sid: string) => void) => () => void
  onDropped: (cb: (p: { sessionId: string }) => void) => () => void
  onStatus: (cb: (s: HooksGatewayStatus) => void) => () => void
}

// GitHub sidebar bridge — see Phase A-H plan. 'GitHubBridge' is declared
// inline here so preload doesn't need to pull types from src/shared at
// compile time; the renderer-facing d.ts in src/renderer/types/electron.d.ts
// redeclares this shape with precise return types sourced from
// shared/github-types.ts.
interface GitHubBridge {
  getConfig: () => Promise<unknown>
  updateConfig: (patch: unknown) => Promise<unknown>
  addPat: (input: {
    kind: 'pat-classic' | 'pat-fine-grained'
    label: string
    rawToken: string
    allowedRepos?: string[]
  }) => Promise<{ ok: boolean; id?: string; error?: string }>
  adoptGhCli: (username: string) => Promise<{ ok: boolean; id?: string; error?: string }>
  removeProfile: (id: string) => Promise<{ ok: boolean }>
  renameProfile: (id: string, label: string) => Promise<{ ok: boolean }>
  testProfile: (id: string) => Promise<{
    ok: boolean
    username?: string
    scopes?: string[]
    expiresAt?: number
    error?: string
  }>
  oauthStart: (mode: 'public' | 'private') => Promise<{
    flowId: string
    userCode: string
    verificationUri: string
    expiresIn: number
    interval: number
  }>
  oauthPoll: (flowId: string) => Promise<{ ok: boolean; profileId?: string; error?: string }>
  oauthCancel: (flowId: string) => Promise<{ ok: boolean }>
  ghcliDetect: () => Promise<{ ok: boolean; users: string[] }>
  repoDetect: (cwd: string) => Promise<{ ok: boolean; slug: string | null }>
  updateSessionConfig: (
    sessionId: string,
    patch: unknown,
  ) => Promise<{ ok: boolean; error?: string }>
  getLocalGit: (cwd: string) => Promise<{ ok: boolean; state: unknown }>
  syncNow: (sessionId: string) => Promise<{ ok: boolean }>
  syncFocusedNow: () => Promise<{ ok: boolean }>
  syncPause: () => Promise<{ ok: boolean }>
  syncResume: () => Promise<{ ok: boolean }>
  notifyFocusChanged: (sessionId: string | null) => void
  getData: (slug: string) => Promise<{ ok: boolean; data: unknown }>
  getSessionContext: (sessionId: string) => Promise<{ ok: boolean; data: unknown }>
  onDataUpdate: (cb: (p: { slug: string; data: unknown }) => void) => () => void
  onSyncStateUpdate: (
    cb: (p: {
      slug: string
      state: 'syncing' | 'synced' | 'rate-limited' | 'error' | 'idle'
      at: number
      nextResetAt?: number
    }) => void,
  ) => () => void
  onNotificationsUpdate: (
    cb: (p: { profileId: string; items: unknown[] }) => void,
  ) => () => void
  rerunActionsRun: (slug: string, runId: number) => Promise<{ ok: boolean; error?: string }>
  mergePR: (
    slug: string,
    prNumber: number,
    method: 'merge' | 'squash' | 'rebase',
  ) => Promise<{ ok: boolean; error?: string }>
  readyPR: (slug: string, prNumber: number) => Promise<{ ok: boolean; error?: string }>
  replyToReview: (
    slug: string,
    threadId: string,
    body: string,
  ) => Promise<{ ok: boolean; error?: string }>
  markNotifRead: (profileId: string, notifId: string) => Promise<{ ok: boolean; error?: string }>
}

const electronAPI: ElectronAPI = {
  config: {
    loadAll: () => ipcRenderer.invoke(IPC.CONFIG_LOAD_ALL),
    save: (key, data) => ipcRenderer.invoke(IPC.CONFIG_SAVE, key, data),
    migrateFromLocalStorage: (data) => ipcRenderer.invoke(IPC.CONFIG_MIGRATE, data),
  },
  window: {
    minimize: () => ipcRenderer.send(IPC.WINDOW_MINIMIZE),
    maximize: () => ipcRenderer.send(IPC.WINDOW_MAXIMIZE),
    close: () => ipcRenderer.send(IPC.WINDOW_CLOSE),
    forceClose: () => ipcRenderer.send(IPC.WINDOW_FORCE_CLOSE),
    allowClose: () => ipcRenderer.send(IPC.WINDOW_ALLOW_CLOSE),
    cancelClose: () => ipcRenderer.send(IPC.WINDOW_CANCEL_CLOSE),
    isMaximized: () => ipcRenderer.invoke(IPC.WINDOW_IS_MAXIMIZED),
    onMaximizedChanged: (callback) => {
      const handler = (_: unknown, maximized: boolean) => callback(maximized)
      ipcRenderer.on(IPC.WINDOW_MAXIMIZED_CHANGED, handler)
      return () => ipcRenderer.removeListener(IPC.WINDOW_MAXIMIZED_CHANGED, handler)
    },
    onCloseRequested: (callback) => {
      const handler = () => callback()
      ipcRenderer.on(IPC.WINDOW_CLOSE_REQUESTED, handler)
      return () => ipcRenderer.removeListener(IPC.WINDOW_CLOSE_REQUESTED, handler)
    }
  },
  dialog: {
    openFolder: () => ipcRenderer.invoke(IPC.DIALOG_OPEN_FOLDER)
  },
  clipboard: {
    readImage: () => ipcRenderer.invoke(IPC.CLIPBOARD_READ_IMAGE),
    saveImage: () => ipcRenderer.invoke(IPC.CLIPBOARD_SAVE_IMAGE)
  },
  credentials: {
    save: (configId, password) => ipcRenderer.invoke(IPC.CREDENTIALS_SAVE, configId, password),
    load: (configId) => ipcRenderer.invoke(IPC.CREDENTIALS_LOAD, configId),
    delete: (configId) => ipcRenderer.invoke(IPC.CREDENTIALS_DELETE, configId)
  },
  pty: {
    spawn: (sessionId, options) =>
      ipcRenderer.invoke(IPC.PTY_SPAWN, sessionId, options),
    write: (sessionId, data) =>
      ipcRenderer.send(IPC.PTY_WRITE, sessionId, data),
    resize: (sessionId, cols, rows) =>
      ipcRenderer.send(IPC.PTY_RESIZE, sessionId, cols, rows),
    kill: (sessionId) => ipcRenderer.send(IPC.PTY_KILL, sessionId),
    onData: (sessionId, callback) => {
      const channel = ptyDataChannel(sessionId)
      const handler = (_: unknown, data: string) => callback(data)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
    onExit: (sessionId, callback) => {
      const channel = ptyExitChannel(sessionId)
      const handler = (_: unknown, exitCode: number) => callback(exitCode)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    }
  },
  ssh: {
    runPostCommand: (sessionId: string) =>
      ipcRenderer.invoke(IPC.SSH_FLOW_RUN_POSTCOMMAND, sessionId),
    launchClaude: (sessionId: string) =>
      ipcRenderer.invoke(IPC.SSH_FLOW_LAUNCH_CLAUDE, sessionId),
    skip: (sessionId: string) =>
      ipcRenderer.invoke(IPC.SSH_FLOW_SKIP, sessionId),
    getState: (sessionId: string) =>
      ipcRenderer.invoke(IPC.SSH_FLOW_GET_STATE, sessionId),
    onFlowState: (sessionId: string, callback: (msg: { state: string; info?: string }) => void) => {
      const channel = `${IPC.SSH_FLOW_STATE}:${sessionId}`
      const handler = (_: unknown, msg: { state: string; info?: string }) => callback(msg)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
  },
  statusline: {
    onUpdate: (callback) => {
      const handler = (_: unknown, data: unknown) => callback(data as any)
      ipcRenderer.on(IPC.STATUSLINE_UPDATE, handler)
      return () => ipcRenderer.removeListener(IPC.STATUSLINE_UPDATE, handler)
    }
  },
  debug: {
    onDebug: (callback: (data: unknown) => void) => {
      const handler = (_: unknown, data: unknown) => callback(data)
      ipcRenderer.on(IPC.DEBUG_ON_DEBUG, handler)
      return () => ipcRenderer.removeListener(IPC.DEBUG_ON_DEBUG, handler)
    },
    enable: () => ipcRenderer.invoke(IPC.DEBUG_ENABLE),
    disable: () => ipcRenderer.invoke(IPC.DEBUG_DISABLE),
    isEnabled: () => ipcRenderer.invoke(IPC.DEBUG_IS_ENABLED),
    openFolder: () => ipcRenderer.invoke(IPC.DEBUG_OPEN_FOLDER)
  },
  usage: {
    getSessionUsage: (sessionId) =>
      ipcRenderer.invoke(IPC.USAGE_SESSION, sessionId),
    getTotalUsage: () => ipcRenderer.invoke(IPC.USAGE_TOTAL),
    getUsageHistory: (hours) => ipcRenderer.invoke(IPC.USAGE_HISTORY, hours)
  },
  logs: {
    list: () => ipcRenderer.invoke(IPC.LOGS_LIST),
    read: (logDir, offset, limit) => ipcRenderer.invoke(IPC.LOGS_READ, logDir, offset, limit),
    search: (logDir, query) => ipcRenderer.invoke(IPC.LOGS_SEARCH, logDir, query),
    cleanup: (retentionDays) => ipcRenderer.invoke(IPC.LOGS_CLEANUP, retentionDays)
  },
  discovery: {
    getProjects: () => ipcRenderer.invoke(IPC.DISCOVERY_PROJECTS),
    getSessionHistory: (projectPath) =>
      ipcRenderer.invoke(IPC.DISCOVERY_SESSIONS, projectPath)
  },
  update: {
    check: () => ipcRenderer.invoke(IPC.UPDATE_CHECK),
    getVersion: () => ipcRenderer.invoke(IPC.UPDATE_GET_VERSION),
    installAndRestart: () => ipcRenderer.invoke(IPC.UPDATE_INSTALL_RESTART),
    hasSourcePath: () => ipcRenderer.invoke(IPC.UPDATE_HAS_SOURCE_PATH),
    getSourcePath: () => ipcRenderer.invoke(IPC.UPDATE_GET_SOURCE_PATH),
    setSourcePath: (path: string) => ipcRenderer.invoke(IPC.UPDATE_SET_SOURCE_PATH, path),
    selectSourcePath: () => ipcRenderer.invoke(IPC.UPDATE_SELECT_SOURCE_PATH),
    onAvailable: (callback) => {
      const handler = (_: unknown, available: boolean, version?: string) => callback(available, version)
      ipcRenderer.on(IPC.UPDATE_AVAILABLE, handler)
      return () => ipcRenderer.removeListener(IPC.UPDATE_AVAILABLE, handler)
    },
    onSourceConfigured: (callback: (configured: boolean) => void) => {
      const handler = (_: unknown, configured: boolean) => callback(configured)
      ipcRenderer.on(IPC.UPDATE_SOURCE_CONFIGURED, handler)
      return () => ipcRenderer.removeListener(IPC.UPDATE_SOURCE_CONFIGURED, handler)
    },
    onServerConnected: (callback: (connected: boolean) => void) => {
      const handler = (_: unknown, connected: boolean) => callback(connected)
      ipcRenderer.on(IPC.UPDATE_SERVER_CONNECTED, handler)
      return () => ipcRenderer.removeListener(IPC.UPDATE_SERVER_CONNECTED, handler)
    }
  },
  setup: {
    isComplete: () => ipcRenderer.invoke(IPC.SETUP_IS_COMPLETE),
    getDefaultDataDir: () => ipcRenderer.invoke(IPC.SETUP_GET_DEFAULT_DATA_DIR),
    selectDataDir: () => ipcRenderer.invoke(IPC.SETUP_SELECT_DATA_DIR),
    setDataDir: (dir: string) => ipcRenderer.invoke(IPC.SETUP_SET_DATA_DIR, dir),
    getDataDir: () => ipcRenderer.invoke(IPC.SETUP_GET_DATA_DIR),
    getResourcesDir: () => ipcRenderer.invoke(IPC.SETUP_GET_RESOURCES_DIR),
    selectResourcesDir: () => ipcRenderer.invoke(IPC.SETUP_SELECT_RESOURCES_DIR),
    setResourcesDir: (dir: string) => ipcRenderer.invoke(IPC.SETUP_SET_RESOURCES_DIR, dir),
    isCliReady: () => ipcRenderer.invoke(IPC.SETUP_IS_CLI_READY),
    spawnCliSetup: (cols: number, rows: number) => ipcRenderer.invoke(IPC.SETUP_SPAWN_CLI_SETUP, cols, rows),
    killCliSetup: () => ipcRenderer.invoke(IPC.SETUP_KILL_CLI_SETUP),
  },
  screenshot: {
    captureRectangle: () => ipcRenderer.invoke(IPC.SCREENSHOT_CAPTURE_RECTANGLE),
    captureWindow: (sourceId: string) => ipcRenderer.invoke(IPC.SCREENSHOT_CAPTURE_WINDOW, sourceId),
    listWindows: () => ipcRenderer.invoke(IPC.SCREENSHOT_LIST_WINDOWS),
    listRecent: () => ipcRenderer.invoke(IPC.SCREENSHOT_LIST_RECENT),
    cleanup: (maxAgeDays: number) => ipcRenderer.invoke(IPC.SCREENSHOT_CLEANUP, maxAgeDays)
  },
  webview: {
    check: (url: string) => ipcRenderer.invoke(IPC.WEBVIEW_CHECK, url),
    open: (sessionId: string, url: string, bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke(IPC.WEBVIEW_OPEN, sessionId, url, bounds),
    close: (sessionId: string) => ipcRenderer.invoke(IPC.WEBVIEW_CLOSE, sessionId),
    setBounds: (sessionId: string, bounds: { x: number; y: number; width: number; height: number }) => ipcRenderer.invoke(IPC.WEBVIEW_SET_BOUNDS, sessionId, bounds),
    setVisible: (sessionId: string, visible: boolean) => ipcRenderer.invoke(IPC.WEBVIEW_SET_VISIBLE, sessionId, visible),
    reload: (sessionId: string) => ipcRenderer.invoke(IPC.WEBVIEW_RELOAD, sessionId),
    capture: (sessionId: string) => ipcRenderer.invoke(IPC.WEBVIEW_CAPTURE, sessionId),
    navBack: (sessionId: string) => ipcRenderer.invoke(IPC.WEBVIEW_NAV_BACK, sessionId),
    navForward: (sessionId: string) => ipcRenderer.invoke(IPC.WEBVIEW_NAV_FORWARD, sessionId),
    goHome: (sessionId: string) => ipcRenderer.invoke(IPC.WEBVIEW_GO_HOME, sessionId),
    closeAll: () => ipcRenderer.invoke(IPC.WEBVIEW_CLOSE_ALL),
    onEscapePressed: (handler: (sessionId: string) => void) => {
      const fn = (_e: unknown, sessionId: string) => handler(sessionId)
      ipcRenderer.on(IPC.WEBVIEW_ESCAPE_PRESSED, fn)
      return () => ipcRenderer.removeListener(IPC.WEBVIEW_ESCAPE_PRESSED, fn)
    },
  },
  session: {
    save: (state: unknown) => ipcRenderer.invoke(IPC.SESSION_SAVE, state),
    load: () => ipcRenderer.invoke(IPC.SESSION_LOAD),
    clear: () => ipcRenderer.invoke(IPC.SESSION_CLEAR),
    hasSaved: () => ipcRenderer.invoke(IPC.SESSION_HAS_SAVED),
    gracefulExit: () => ipcRenderer.invoke(IPC.SESSION_GRACEFUL_EXIT)
  },
  insights: {
    run: () => ipcRenderer.invoke(IPC.INSIGHTS_RUN),
    getCatalogue: () => ipcRenderer.invoke(IPC.INSIGHTS_GET_CATALOGUE),
    getReport: (runId: string) => ipcRenderer.invoke(IPC.INSIGHTS_GET_REPORT, runId),
    getKpis: (runId: string) => ipcRenderer.invoke(IPC.INSIGHTS_GET_KPIS, runId),
    getLatest: () => ipcRenderer.invoke(IPC.INSIGHTS_GET_LATEST),
    isRunning: () => ipcRenderer.invoke(IPC.INSIGHTS_IS_RUNNING),
    seed: () => ipcRenderer.invoke(IPC.INSIGHTS_SEED),
    onStatusChanged: (callback: (run: unknown) => void) => {
      const handler = (_: unknown, run: unknown) => callback(run)
      ipcRenderer.on(IPC.INSIGHTS_STATUS_CHANGED, handler)
      return () => ipcRenderer.removeListener(IPC.INSIGHTS_STATUS_CHANGED, handler)
    }
  },
  notes: {
    list: () => ipcRenderer.invoke(IPC.NOTES_LIST),
    load: (id: string) => ipcRenderer.invoke(IPC.NOTES_LOAD, id),
    save: (id: string, label: string, content: string, color: string, configId?: string) =>
      ipcRenderer.invoke(IPC.NOTES_SAVE, id, label, content, color, configId),
    delete: (id: string) => ipcRenderer.invoke(IPC.NOTES_DELETE, id),
    reorder: (ids: string[]) => ipcRenderer.invoke(IPC.NOTES_REORDER, ids),
  },
  legacyVersion: {
    fetchVersions: () => ipcRenderer.invoke(IPC.LEGACY_FETCH_VERSIONS),
    isInstalled: (version: string) => ipcRenderer.invoke(IPC.LEGACY_IS_INSTALLED, version),
    install: (version: string) => ipcRenderer.invoke(IPC.LEGACY_INSTALL, version),
    remove: (version: string) => ipcRenderer.invoke(IPC.LEGACY_REMOVE, version),
    listInstalled: () => ipcRenderer.invoke(IPC.LEGACY_LIST_INSTALLED),
    onInstallProgress: (cb: (data: { version: string; message: string }) => void) => {
      const handler = (_: unknown, data: any) => cb(data)
      ipcRenderer.on(IPC.LEGACY_INSTALL_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC.LEGACY_INSTALL_PROGRESS, handler)
    },
  },
  vision: {
    start: () => ipcRenderer.invoke(IPC.VISION_START),
    stop: () => ipcRenderer.invoke(IPC.VISION_STOP),
    status: () => ipcRenderer.invoke(IPC.VISION_STATUS),
    launch: (browser: string, debugPort: number, url?: string, headless?: boolean) =>
      ipcRenderer.invoke(IPC.VISION_LAUNCH, browser, debugPort, url, headless ?? true),
    saveConfig: (config: any) => ipcRenderer.invoke(IPC.VISION_SAVE_CONFIG, config),
    getConfig: () => ipcRenderer.invoke(IPC.VISION_GET_CONFIG),
    onStatusChanged: (callback: (data: { connected: boolean; browser: string; mcpPort: number }) => void) => {
      const handler = (_: unknown, data: any) => callback(data)
      ipcRenderer.on(IPC.VISION_STATUS_CHANGED, handler)
      return () => ipcRenderer.removeListener(IPC.VISION_STATUS_CHANGED, handler)
    }
  },
  cloudAgent: {
    dispatch: (params: { name: string; description: string; projectPath: string; configId?: string }) =>
      ipcRenderer.invoke(IPC.CLOUD_AGENT_DISPATCH, params),
    cancel: (id: string) => ipcRenderer.invoke(IPC.CLOUD_AGENT_CANCEL, id),
    remove: (id: string) => ipcRenderer.invoke(IPC.CLOUD_AGENT_REMOVE, id),
    retry: (id: string) => ipcRenderer.invoke(IPC.CLOUD_AGENT_RETRY, id),
    list: () => ipcRenderer.invoke(IPC.CLOUD_AGENT_LIST),
    getOutput: (id: string) => ipcRenderer.invoke(IPC.CLOUD_AGENT_GET_OUTPUT, id),
    clearCompleted: () => ipcRenderer.invoke(IPC.CLOUD_AGENT_CLEAR_COMPLETED),
    onStatusChanged: (callback: (agent: any) => void) => {
      const handler = (_: unknown, agent: any) => callback(agent)
      ipcRenderer.on(IPC.CLOUD_AGENT_STATUS_CHANGED, handler)
      return () => ipcRenderer.removeListener(IPC.CLOUD_AGENT_STATUS_CHANGED, handler)
    },
    onOutputChunk: (callback: (data: { id: string; chunk: string }) => void) => {
      const handler = (_: unknown, data: any) => callback(data)
      ipcRenderer.on(IPC.CLOUD_AGENT_OUTPUT_CHUNK, handler)
      return () => ipcRenderer.removeListener(IPC.CLOUD_AGENT_OUTPUT_CHUNK, handler)
    },
  },
  team: {
    list: () => ipcRenderer.invoke(IPC.TEAM_LIST),
    save: (team: any) => ipcRenderer.invoke(IPC.TEAM_SAVE, team),
    delete: (id: string) => ipcRenderer.invoke(IPC.TEAM_DELETE, id),
    run: (teamId: string, projectPath?: string) => ipcRenderer.invoke(IPC.TEAM_RUN, teamId, projectPath),
    cancelRun: (runId: string) => ipcRenderer.invoke(IPC.TEAM_CANCEL_RUN, runId),
    listRuns: () => ipcRenderer.invoke(IPC.TEAM_LIST_RUNS),
    onRunStatusChanged: (callback: (run: any) => void) => {
      const handler = (_: unknown, run: any) => callback(run)
      ipcRenderer.on(IPC.TEAM_RUN_STATUS_CHANGED, handler)
      return () => ipcRenderer.removeListener(IPC.TEAM_RUN_STATUS_CHANGED, handler)
    },
  },
  serviceStatus: {
    onUpdate: (callback: (data: any) => void) => {
      const handler = (_: unknown, data: any) => callback(data)
      ipcRenderer.on(IPC.SERVICE_STATUS, handler)
      return () => ipcRenderer.removeListener(IPC.SERVICE_STATUS, handler)
    }
  },
  cli: {
    check: () => ipcRenderer.invoke(IPC.CLI_CHECK)
  },
  tokenomics: {
    getData: () => ipcRenderer.invoke(IPC.TOKENOMICS_GET_DATA),
    seed: () => ipcRenderer.invoke(IPC.TOKENOMICS_SEED),
    sync: () => ipcRenderer.invoke(IPC.TOKENOMICS_SYNC),
    onProgress: (callback: (data: any) => void) => {
      const handler = (_: unknown, data: any) => callback(data)
      ipcRenderer.on(IPC.TOKENOMICS_PROGRESS, handler)
      return () => ipcRenderer.removeListener(IPC.TOKENOMICS_PROGRESS, handler)
    },
  },
  account: {
    list: () => ipcRenderer.invoke(IPC.ACCOUNT_LIST),
    switch: (id: string) => ipcRenderer.invoke(IPC.ACCOUNT_SWITCH, id),
    getActive: () => ipcRenderer.invoke(IPC.ACCOUNT_GET_ACTIVE),
    saveCurrentAs: (id: string, label: string) => ipcRenderer.invoke(IPC.ACCOUNT_SAVE_CURRENT_AS, id, label),
    rename: (id: string, newLabel: string) => ipcRenderer.invoke(IPC.ACCOUNT_RENAME, id, newLabel),
  },
  memory: {
    scan: () => ipcRenderer.invoke('memory:scan'),
    read: (filePath: string) => ipcRenderer.invoke('memory:read', filePath),
    delete: (filePath: string) => ipcRenderer.invoke('memory:delete', filePath),
    writeFrontmatter: (filePath: string, frontmatter: { name?: string; description?: string; type?: string }) =>
      ipcRenderer.invoke('memory:writeFrontmatter', filePath, frontmatter),
  },
  shell: {
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  },
  codex: {
    status: () => ipcRenderer.invoke(IPC.CODEX_STATUS),
    login: (payload) => ipcRenderer.invoke(IPC.CODEX_LOGIN, payload),
    logout: () => ipcRenderer.invoke(IPC.CODEX_LOGOUT),
    testConnection: () => ipcRenderer.invoke(IPC.CODEX_TEST_CONNECTION),
  },
  github: {
    getConfig: () => ipcRenderer.invoke(IPC.GITHUB_CONFIG_GET),
    updateConfig: (patch) => ipcRenderer.invoke(IPC.GITHUB_CONFIG_UPDATE, patch),
    addPat: (input) => ipcRenderer.invoke(IPC.GITHUB_PROFILE_ADD_PAT, input),
    adoptGhCli: (username) => ipcRenderer.invoke(IPC.GITHUB_PROFILE_ADOPT_GHCLI, username),
    removeProfile: (id) => ipcRenderer.invoke(IPC.GITHUB_PROFILE_REMOVE, id),
    renameProfile: (id, label) => ipcRenderer.invoke(IPC.GITHUB_PROFILE_RENAME, id, label),
    testProfile: (id) => ipcRenderer.invoke(IPC.GITHUB_PROFILE_TEST, id),
    oauthStart: (mode) => ipcRenderer.invoke(IPC.GITHUB_OAUTH_START, mode),
    oauthPoll: (flowId) => ipcRenderer.invoke(IPC.GITHUB_OAUTH_POLL, flowId),
    oauthCancel: (flowId) => ipcRenderer.invoke(IPC.GITHUB_OAUTH_CANCEL, flowId),
    ghcliDetect: () => ipcRenderer.invoke(IPC.GITHUB_GHCLI_DETECT),
    repoDetect: (cwd) => ipcRenderer.invoke(IPC.GITHUB_REPO_DETECT, cwd),
    updateSessionConfig: (sessionId, patch) =>
      ipcRenderer.invoke(IPC.GITHUB_SESSION_CONFIG_UPDATE, sessionId, patch),
    getLocalGit: (cwd) => ipcRenderer.invoke(IPC.GITHUB_LOCALGIT_GET, cwd),
    syncNow: (sessionId) => ipcRenderer.invoke(IPC.GITHUB_SYNC_NOW, sessionId),
    syncFocusedNow: () => ipcRenderer.invoke(IPC.GITHUB_SYNC_FOCUSED_NOW),
    notifyFocusChanged: (sessionId: string | null) =>
      ipcRenderer.send(IPC.GITHUB_FOCUS_CHANGED, sessionId),
    syncPause: () => ipcRenderer.invoke(IPC.GITHUB_SYNC_PAUSE),
    syncResume: () => ipcRenderer.invoke(IPC.GITHUB_SYNC_RESUME),
    getData: (slug) => ipcRenderer.invoke(IPC.GITHUB_DATA_GET, slug),
    getSessionContext: (sessionId) =>
      ipcRenderer.invoke(IPC.GITHUB_SESSION_CONTEXT_GET, sessionId),
    onDataUpdate: (cb) => {
      const l = (_e: Electron.IpcRendererEvent, p: unknown) =>
        cb(p as Parameters<typeof cb>[0])
      ipcRenderer.on(IPC.GITHUB_DATA_UPDATE, l)
      return () => ipcRenderer.removeListener(IPC.GITHUB_DATA_UPDATE, l)
    },
    onSyncStateUpdate: (cb) => {
      const l = (_e: Electron.IpcRendererEvent, p: unknown) =>
        cb(p as Parameters<typeof cb>[0])
      ipcRenderer.on(IPC.GITHUB_SYNC_STATE_UPDATE, l)
      return () => ipcRenderer.removeListener(IPC.GITHUB_SYNC_STATE_UPDATE, l)
    },
    onNotificationsUpdate: (cb) => {
      const l = (_e: Electron.IpcRendererEvent, p: unknown) =>
        cb(p as Parameters<typeof cb>[0])
      ipcRenderer.on(IPC.GITHUB_NOTIFICATIONS_UPDATE, l)
      return () => ipcRenderer.removeListener(IPC.GITHUB_NOTIFICATIONS_UPDATE, l)
    },
    rerunActionsRun: (slug, runId) =>
      ipcRenderer.invoke(IPC.GITHUB_ACTIONS_RERUN, slug, runId),
    mergePR: (slug, prNumber, method) =>
      ipcRenderer.invoke(IPC.GITHUB_PR_MERGE, slug, prNumber, method),
    readyPR: (slug, prNumber) => ipcRenderer.invoke(IPC.GITHUB_PR_READY, slug, prNumber),
    replyToReview: (slug, threadId, body) =>
      ipcRenderer.invoke(IPC.GITHUB_REVIEW_REPLY, slug, threadId, body),
    markNotifRead: (profileId, notifId) =>
      ipcRenderer.invoke(IPC.GITHUB_NOTIF_MARK_READ, profileId, notifId),
  },
  hooks: {
    toggle: (enabled) => ipcRenderer.invoke(IPC.HOOKS_TOGGLE, { enabled }),
    getBuffer: (sessionId) => ipcRenderer.invoke(IPC.HOOKS_GET_BUFFER, { sessionId }),
    getStatus: () => ipcRenderer.invoke(IPC.HOOKS_GET_STATUS),
    onEvent: (cb) => {
      const handler = (_: unknown, e: HookEvent) => cb(e)
      ipcRenderer.on(IPC.HOOKS_EVENT, handler)
      return () => ipcRenderer.removeListener(IPC.HOOKS_EVENT, handler)
    },
    onSessionEnded: (cb) => {
      const handler = (_: unknown, sid: string) => cb(sid)
      ipcRenderer.on(IPC.HOOKS_SESSION_ENDED, handler)
      return () => ipcRenderer.removeListener(IPC.HOOKS_SESSION_ENDED, handler)
    },
    onDropped: (cb) => {
      const handler = (_: unknown, p: { sessionId: string }) => cb(p)
      ipcRenderer.on(IPC.HOOKS_DROPPED, handler)
      return () => ipcRenderer.removeListener(IPC.HOOKS_DROPPED, handler)
    },
    onStatus: (cb) => {
      const handler = (_: unknown, s: HooksGatewayStatus) => cb(s)
      ipcRenderer.on(IPC.HOOKS_STATUS, handler)
      return () => ipcRenderer.removeListener(IPC.HOOKS_STATUS, handler)
    },
  },
}

// Expose platform for renderer-side platform checks
contextBridge.exposeInMainWorld('electronPlatform', process.platform)
contextBridge.exposeInMainWorld('electronAPI', electronAPI)
