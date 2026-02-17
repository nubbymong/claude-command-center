import { contextBridge, ipcRenderer } from 'electron'

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
        password?: string
        postCommand?: string
        sudoPassword?: string
      }
      configLabel?: string
      useResumePicker?: boolean
      visionConfig?: {
        enabled: boolean
        browser: 'chrome' | 'edge'
        debugPort: number
      }
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
    loadAll: () => ipcRenderer.invoke('config:loadAll'),
    save: (key, data) => ipcRenderer.invoke('config:save', key, data),
    migrateFromLocalStorage: (data) => ipcRenderer.invoke('config:migrateFromLocalStorage', data),
  },
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close: () => ipcRenderer.send('window:close'),
    forceClose: () => ipcRenderer.send('window:forceClose'),
    allowClose: () => ipcRenderer.send('window:allowClose'),
    cancelClose: () => ipcRenderer.send('window:cancelClose'),
    isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
    onMaximizedChanged: (callback) => {
      const handler = (_: unknown, maximized: boolean) => callback(maximized)
      ipcRenderer.on('window:maximized-changed', handler)
      return () => ipcRenderer.removeListener('window:maximized-changed', handler)
    },
    onCloseRequested: (callback) => {
      const handler = () => callback()
      ipcRenderer.on('window:closeRequested', handler)
      return () => ipcRenderer.removeListener('window:closeRequested', handler)
    }
  },
  dialog: {
    openFolder: () => ipcRenderer.invoke('dialog:openFolder')
  },
  clipboard: {
    readImage: () => ipcRenderer.invoke('clipboard:readImage'),
    saveImage: () => ipcRenderer.invoke('clipboard:saveImage')
  },
  credentials: {
    save: (configId, password) => ipcRenderer.invoke('credentials:save', configId, password),
    load: (configId) => ipcRenderer.invoke('credentials:load', configId),
    delete: (configId) => ipcRenderer.invoke('credentials:delete', configId)
  },
  pty: {
    spawn: (sessionId, options) =>
      ipcRenderer.invoke('pty:spawn', sessionId, options),
    write: (sessionId, data) =>
      ipcRenderer.send('pty:write', sessionId, data),
    resize: (sessionId, cols, rows) =>
      ipcRenderer.send('pty:resize', sessionId, cols, rows),
    kill: (sessionId) => ipcRenderer.send('pty:kill', sessionId),
    onData: (sessionId, callback) => {
      const channel = `pty:data:${sessionId}`
      const handler = (_: unknown, data: string) => callback(data)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    },
    onExit: (sessionId, callback) => {
      const channel = `pty:exit:${sessionId}`
      const handler = (_: unknown, exitCode: number) => callback(exitCode)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    }
  },
  statusline: {
    onUpdate: (callback) => {
      const handler = (_: unknown, data: unknown) => callback(data as any)
      ipcRenderer.on('statusline:update', handler)
      return () => ipcRenderer.removeListener('statusline:update', handler)
    }
  },
  debug: {
    onDebug: (callback: (data: unknown) => void) => {
      const handler = (_: unknown, data: unknown) => callback(data)
      ipcRenderer.on('claude:debug', handler)
      return () => ipcRenderer.removeListener('claude:debug', handler)
    },
    enable: () => ipcRenderer.invoke('debug:enable'),
    disable: () => ipcRenderer.invoke('debug:disable'),
    isEnabled: () => ipcRenderer.invoke('debug:isEnabled'),
    openFolder: () => ipcRenderer.invoke('debug:openFolder')
  },
  usage: {
    getSessionUsage: (sessionId) =>
      ipcRenderer.invoke('usage:session', sessionId),
    getTotalUsage: () => ipcRenderer.invoke('usage:total'),
    getUsageHistory: (hours) => ipcRenderer.invoke('usage:history', hours)
  },
  logs: {
    list: () => ipcRenderer.invoke('logs:list'),
    read: (logDir, offset, limit) => ipcRenderer.invoke('logs:read', logDir, offset, limit),
    search: (logDir, query) => ipcRenderer.invoke('logs:search', logDir, query),
    cleanup: (retentionDays) => ipcRenderer.invoke('logs:cleanup', retentionDays)
  },
  discovery: {
    getProjects: () => ipcRenderer.invoke('discovery:projects'),
    getSessionHistory: (projectPath) =>
      ipcRenderer.invoke('discovery:sessions', projectPath)
  },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    getVersion: () => ipcRenderer.invoke('update:getVersion'),
    installAndRestart: () => ipcRenderer.invoke('update:installAndRestart'),
    hasSourcePath: () => ipcRenderer.invoke('update:hasSourcePath'),
    getSourcePath: () => ipcRenderer.invoke('update:getSourcePath'),
    setSourcePath: (path: string) => ipcRenderer.invoke('update:setSourcePath', path),
    selectSourcePath: () => ipcRenderer.invoke('update:selectSourcePath'),
    onAvailable: (callback) => {
      const handler = (_: unknown, available: boolean, version?: string) => callback(available, version)
      ipcRenderer.on('update:available', handler)
      return () => ipcRenderer.removeListener('update:available', handler)
    },
    onSourceConfigured: (callback: (configured: boolean) => void) => {
      const handler = (_: unknown, configured: boolean) => callback(configured)
      ipcRenderer.on('update:sourceConfigured', handler)
      return () => ipcRenderer.removeListener('update:sourceConfigured', handler)
    },
    onServerConnected: (callback: (connected: boolean) => void) => {
      const handler = (_: unknown, connected: boolean) => callback(connected)
      ipcRenderer.on('update:serverConnected', handler)
      return () => ipcRenderer.removeListener('update:serverConnected', handler)
    }
  },
  setup: {
    isComplete: () => ipcRenderer.invoke('setup:isComplete'),
    getDefaultDataDir: () => ipcRenderer.invoke('setup:getDefaultDataDir'),
    selectDataDir: () => ipcRenderer.invoke('setup:selectDataDir'),
    setDataDir: (dir: string) => ipcRenderer.invoke('setup:setDataDir', dir),
    getDataDir: () => ipcRenderer.invoke('setup:getDataDir'),
    getResourcesDir: () => ipcRenderer.invoke('setup:getResourcesDir'),
    selectResourcesDir: () => ipcRenderer.invoke('setup:selectResourcesDir'),
    setResourcesDir: (dir: string) => ipcRenderer.invoke('setup:setResourcesDir', dir),
    isCliReady: () => ipcRenderer.invoke('setup:isCliReady'),
    spawnCliSetup: (cols: number, rows: number) => ipcRenderer.invoke('setup:spawnCliSetup', cols, rows),
    killCliSetup: () => ipcRenderer.invoke('setup:killCliSetup'),
  },
  screenshot: {
    captureRectangle: () => ipcRenderer.invoke('screenshot:captureRectangle'),
    captureWindow: (sourceId: string) => ipcRenderer.invoke('screenshot:captureWindow', sourceId),
    listWindows: () => ipcRenderer.invoke('screenshot:listWindows'),
    listRecent: () => ipcRenderer.invoke('screenshot:listRecent'),
    cleanup: (maxAgeDays: number) => ipcRenderer.invoke('screenshot:cleanup', maxAgeDays)
  },
  session: {
    save: (state: unknown) => ipcRenderer.invoke('session:save', state),
    load: () => ipcRenderer.invoke('session:load'),
    clear: () => ipcRenderer.invoke('session:clear'),
    hasSaved: () => ipcRenderer.invoke('session:hasSaved'),
    gracefulExit: () => ipcRenderer.invoke('session:gracefulExit')
  },
  insights: {
    run: () => ipcRenderer.invoke('insights:run'),
    getCatalogue: () => ipcRenderer.invoke('insights:getCatalogue'),
    getReport: (runId: string) => ipcRenderer.invoke('insights:getReport', runId),
    getKpis: (runId: string) => ipcRenderer.invoke('insights:getKpis', runId),
    getLatest: () => ipcRenderer.invoke('insights:getLatest'),
    isRunning: () => ipcRenderer.invoke('insights:isRunning'),
    seed: () => ipcRenderer.invoke('insights:seed'),
    onStatusChanged: (callback: (run: unknown) => void) => {
      const handler = (_: unknown, run: unknown) => callback(run)
      ipcRenderer.on('insights:statusChanged', handler)
      return () => ipcRenderer.removeListener('insights:statusChanged', handler)
    }
  },
  notes: {
    list: () => ipcRenderer.invoke('notes:list'),
    load: (id: string) => ipcRenderer.invoke('notes:load', id),
    save: (id: string, label: string, content: string, color: string, configId?: string) =>
      ipcRenderer.invoke('notes:save', id, label, content, color, configId),
    delete: (id: string) => ipcRenderer.invoke('notes:delete', id),
    reorder: (ids: string[]) => ipcRenderer.invoke('notes:reorder', ids),
  },
  vision: {
    start: (sessionId: string, debugPort: number, browser: string) =>
      ipcRenderer.invoke('vision:start', sessionId, debugPort, browser),
    stop: (sessionId: string) => ipcRenderer.invoke('vision:stop', sessionId),
    status: (sessionId: string) => ipcRenderer.invoke('vision:status', sessionId),
    launch: (browser: string, debugPort: number, url?: string) =>
      ipcRenderer.invoke('vision:launch', browser, debugPort, url),
    onStatusChanged: (callback: (data: { sessionId: string; connected: boolean; browser: string; proxyPort: number }) => void) => {
      const handler = (_: unknown, data: any) => callback(data)
      ipcRenderer.on('vision:statusChanged', handler)
      return () => ipcRenderer.removeListener('vision:statusChanged', handler)
    }
  },
  cli: {
    check: () => ipcRenderer.invoke('cli:check')
  }
}

contextBridge.exposeInMainWorld('electronAPI', electronAPI)
