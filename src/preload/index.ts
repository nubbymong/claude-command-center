import { contextBridge, ipcRenderer } from 'electron'
import { IPC, ptyDataChannel, ptyExitChannel } from '../shared/ipc-channels'

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
        startClaudeAfter?: boolean
        dockerContainer?: string
      }
      configId?: string
      configLabel?: string
      useResumePicker?: boolean
      agentsConfig?: Array<{
        name: string; description: string; prompt: string
        model?: string; tools?: string[]
      }>
      flickerFree?: boolean
      powershellTool?: boolean
      effortLevel?: 'low' | 'medium' | 'high'
      disableAutoMemory?: boolean
    }) => Promise<void>
    write: (sessionId: string, data: string) => void
    resize: (sessionId: string, cols: number, rows: number) => void
    kill: (sessionId: string) => void
    onData: (sessionId: string, callback: (data: string) => void) => () => void
    onExit: (sessionId: string, callback: (exitCode: number) => void) => () => void
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
  storyboard: {
    start: () => Promise<{ x: number; y: number; width: number; height: number } | null>
    captureFrame: () => Promise<string | null>
    stop: () => Promise<string[]>
    isActive: () => Promise<boolean>
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
  storyboard: {
    start: () => ipcRenderer.invoke(IPC.STORYBOARD_START),
    captureFrame: () => ipcRenderer.invoke(IPC.STORYBOARD_CAPTURE_FRAME),
    stop: () => ipcRenderer.invoke(IPC.STORYBOARD_STOP),
    isActive: () => ipcRenderer.invoke(IPC.STORYBOARD_IS_ACTIVE),
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
}

// Expose platform for renderer-side platform checks
contextBridge.exposeInMainWorld('electronPlatform', process.platform)
contextBridge.exposeInMainWorld('electronAPI', electronAPI)
