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
    cancelClose: () => void
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
      shellOnly?: boolean
      elevated?: boolean
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
      contextWindowSize?: number
      inputTokens?: number
      outputTokens?: number
      costUsd?: number
      totalDurationMs?: number
      linesAdded?: number
      linesRemoved?: number
      rateLimitCurrent?: number
      rateLimitCurrentResets?: string
      rateLimitWeekly?: number
      rateLimitWeeklyResets?: string
      rateLimitExtra?: {
        enabled: boolean
        utilization: number
        usedUsd: number
        limitUsd: number
      }
    }) => void) => () => void
  }
  debug: {
    onDebug: (callback: (data: any) => void) => () => void
    enable: () => Promise<boolean>
    disable: () => Promise<boolean>
    isEnabled: () => Promise<boolean>
    openFolder: () => Promise<string>
  }
  usage: {
    getSessionUsage: (sessionId: string) => Promise<any>
    getTotalUsage: () => Promise<any>
    getUsageHistory: (hours: number) => Promise<any>
  }
  logs: {
    list: () => Promise<Array<{
      configLabel: string
      sessionId: string
      logDir: string
      startTime?: number
      endTime?: number
      size: number
    }>>
    read: (logDir: string, offset?: number, limit?: number) => Promise<{
      entries: Array<{ ts: number; type: string; data?: string }>
      total: number
    }>
    search: (logDir: string, query: string) => Promise<Array<{ ts: number; type: string; data?: string }>>
    cleanup: (retentionDays?: number) => Promise<number>
  }
  discovery: {
    getProjects: () => Promise<any>
    getSessionHistory: (projectPath: string) => Promise<any>
  }
  update: {
    check: () => Promise<boolean>
    getVersion: () => Promise<string | null>
    installAndRestart: () => Promise<boolean>
    hasSourcePath: () => Promise<boolean>
    getSourcePath: () => Promise<string>
    setSourcePath: (path: string) => Promise<boolean>
    selectSourcePath: () => Promise<{ path?: string; error?: string } | null>
    onAvailable: (callback: (available: boolean, version?: string) => void) => () => void
    onSourceConfigured: (callback: (configured: boolean) => void) => () => void
  }
  setup: {
    isComplete: () => Promise<boolean>
    getDefaultDataDir: () => Promise<string>
    selectDataDir: () => Promise<string | null>
    setDataDir: (dir: string) => Promise<boolean>
    getDataDir: () => Promise<string>
    getResourcesDir: () => Promise<string>
    selectResourcesDir: () => Promise<string | null>
    setResourcesDir: (dir: string) => Promise<boolean>
    isCliReady: () => Promise<boolean>
    spawnCliSetup: (cols: number, rows: number) => Promise<string>
    killCliSetup: () => Promise<boolean>
  }
  screenshot: {
    captureRectangle: () => Promise<string | null>
    captureWindow: (sourceId: string) => Promise<string | null>
    listWindows: () => Promise<Array<{ id: string; name: string; thumbnail: string }>>
    listRecent: () => Promise<Array<{ filename: string; path: string; timestamp: number; thumbnail: string }>>
    cleanup: (maxAgeDays: number) => Promise<number>
  }
  session: {
    save: (state: SessionState) => Promise<boolean>
    load: () => Promise<SessionState | null>
    clear: () => Promise<boolean>
    hasSaved: () => Promise<boolean>
    gracefulExit: () => Promise<boolean>
  }
  insights: {
    run: () => Promise<string>
    getCatalogue: () => Promise<InsightsCatalogue>
    getReport: (runId: string) => Promise<string | null>
    getKpis: (runId: string) => Promise<KpiData | null>
    getLatest: () => Promise<InsightsRun | null>
    isRunning: () => Promise<boolean>
    seed: () => Promise<string | null>
    onStatusChanged: (callback: (run: InsightsRun) => void) => () => void
  }
  notes: {
    list: () => Promise<Array<{ id: string; label: string; color: string; configId?: string; createdAt: number }>>
    load: (id: string) => Promise<string | null>
    save: (id: string, label: string, content: string, color: string, configId?: string) => Promise<boolean>
    delete: (id: string) => Promise<boolean>
    reorder: (ids: string[]) => Promise<boolean>
  }
  vision: {
    start: (sessionId: string, debugPort: number, browser: string) => Promise<{ ok: boolean; proxyPort?: number; error?: string }>
    stop: (sessionId: string) => Promise<{ ok: boolean }>
    status: (sessionId: string) => Promise<{ connected: boolean; browser: string | null; proxyPort: number }>
    launch: (browser: string, debugPort: number, url?: string) => Promise<{ ok: boolean; pid?: number; command?: string; error?: string }>
    getPrompt: () => Promise<string | null>
    onStatusChanged: (callback: (data: { sessionId: string; connected: boolean; browser: string; proxyPort: number }) => void) => () => void
  }
  cli: {
    check: () => Promise<boolean>
  }
}

export interface SavedSession {
  id: string
  configId?: string
  label: string
  workingDirectory: string
  model: string
  color: string
  sessionType: 'local' | 'ssh'
  shellOnly?: boolean
  partnerTerminalPath?: string
  partnerElevated?: boolean
  sshConfig?: {
    host: string
    port: number
    username: string
    remotePath: string
    hasPassword?: boolean
    postCommand?: string
    hasSudoPassword?: boolean
    startClaudeAfter?: boolean
    dockerContainer?: string
  }
  visionConfig?: {
    enabled: boolean
    browser: 'chrome' | 'edge'
    debugPort: number
    url?: string
  }
}

export interface SessionState {
  sessions: SavedSession[]
  activeSessionId: string | null
  savedAt: number
}

export interface InsightsRun {
  id: string
  timestamp: number
  status: 'running' | 'extracting_kpis' | 'complete' | 'failed'
  statusMessage?: string
  error?: string
}

export interface InsightsCatalogue {
  runs: InsightsRun[]
}

export interface KpiMetric {
  value: number
  label: string
  format?: 'number' | 'percent' | 'duration'
  goodDirection?: 'up' | 'down' | 'neutral'
}

export interface InsightsData {
  period?: { start?: string; end?: string; days?: number }
  summary?: {
    improvements?: string[]
    regressions?: string[]
    suggestions?: string[]
  }
  kpis?: Record<string, Record<string, KpiMetric>>
  lists?: Record<string, Array<{ name: string; count: number }>>
  [key: string]: any
}

// Keep KpiData as alias for backward compat
export type KpiData = InsightsData

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
