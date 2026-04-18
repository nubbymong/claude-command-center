// Re-export shared types so existing imports continue to work
export type {
  VisionConfig,
  SshConfig,
  LegacyVersion,
  SavedSession,
  SessionState,
  StatuslineData,
  RateLimitExtra,
  CloudAgent,
  CloudAgentStatus,
  InsightsRun,
  InsightsCatalogue,
  KpiMetric,
  InsightsData,
  KpiData,
  LogSession,
  LogEntry,
  NoteMetadata,
  AccountProfile,
  AgentTemplate,
  AgentModelOverride,
  TeamTemplate,
  TeamRun,
  TeamStep,
  TeamStepMode,
  TeamRunStep,
  TeamRunStatus,
  TokenomicsData,
  TokenomicsSyncProgress,
  TokenomicsSessionRecord,
  TokenomicsDailyAggregate,
  MemoryFile,
  MemoryProject,
  MemoryScanResult,
  SchemaWarning,
} from '../../shared/types'

// Import for use in the ElectronAPI interface
import type {
  SavedSession,
  SessionState,
  InsightsRun,
  InsightsCatalogue,
  InsightsData,
  KpiData,
  CloudAgent,
  TeamTemplate,
  TeamRun,
  AccountProfile,
  TokenomicsData,
  TokenomicsSyncProgress,
} from '../../shared/types'

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
        postCommand?: string
        startClaudeAfter?: boolean
        dockerContainer?: string
      }
      shellOnly?: boolean
      elevated?: boolean
      configId?: string
      configLabel?: string
      useResumePicker?: boolean
      legacyVersion?: {
        enabled: boolean
        version: string
      }
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
  storyboard: {
    start: () => Promise<{ x: number; y: number; width: number; height: number } | null>
    captureFrame: () => Promise<string | null>
    stop: () => Promise<string[]>
    isActive: () => Promise<boolean>
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
    start: () => Promise<{ ok: boolean; error?: string }>
    stop: () => Promise<{ ok: boolean }>
    status: () => Promise<{ running: boolean; connected: boolean; browser: string; mcpPort: number }>
    launch: (browser: string, debugPort: number, url?: string, headless?: boolean) => Promise<{ ok: boolean; pid?: number; command?: string; error?: string }>
    saveConfig: (config: { enabled: boolean; browser: 'chrome' | 'edge'; debugPort: number; mcpPort: number; url?: string; headless?: boolean }) => Promise<{ ok: boolean }>
    getConfig: () => Promise<{ enabled: boolean; browser: 'chrome' | 'edge'; debugPort: number; mcpPort: number; url?: string; headless?: boolean } | null>
    onStatusChanged: (callback: (data: { connected: boolean; browser: string; mcpPort: number }) => void) => () => void
  }
  legacyVersion: {
    fetchVersions: () => Promise<string[]>
    isInstalled: (version: string) => Promise<boolean>
    install: (version: string) => Promise<{ ok: boolean; error?: string }>
    remove: (version: string) => Promise<boolean>
    listInstalled: () => Promise<Array<{ version: string; sizeBytes: number }>>
    onInstallProgress: (cb: (data: { version: string; message: string }) => void) => () => void
  }
  cloudAgent: {
    dispatch: (agent: { name: string; description: string; projectPath: string; configId?: string; legacyVersion?: { enabled: boolean; version: string } }) => Promise<CloudAgent>
    cancel: (id: string) => Promise<boolean>
    remove: (id: string) => Promise<boolean>
    retry: (id: string) => Promise<CloudAgent | null>
    list: () => Promise<CloudAgent[]>
    getOutput: (id: string) => Promise<string>
    clearCompleted: () => Promise<number>
    onStatusChanged: (callback: (agent: CloudAgent) => void) => () => void
    onOutputChunk: (callback: (data: { id: string; chunk: string }) => void) => () => void
  }
  team: {
    list: () => Promise<TeamTemplate[]>
    save: (team: TeamTemplate) => Promise<TeamTemplate>
    delete: (id: string) => Promise<boolean>
    run: (teamId: string, projectPath?: string) => Promise<TeamRun | null>
    cancelRun: (runId: string) => Promise<boolean>
    listRuns: () => Promise<TeamRun[]>
    onRunStatusChanged: (callback: (run: TeamRun) => void) => () => void
  }
  serviceStatus: {
    onUpdate: (callback: (data: { status: string; description: string }) => void) => () => void
  }
  cli: {
    check: () => Promise<boolean>
  }
  tokenomics: {
    getData: () => Promise<TokenomicsData>
    seed: () => Promise<TokenomicsData>
    sync: () => Promise<TokenomicsData>
    onProgress: (callback: (data: TokenomicsSyncProgress) => void) => () => void
  }
  account: {
    list: () => Promise<AccountProfile[]>
    switch: (id: string) => Promise<{ ok: boolean; error?: string }>
    getActive: () => Promise<AccountProfile | null>
    saveCurrentAs: (id: string, label: string) => Promise<{ ok: boolean; error?: string }>
    rename: (id: string, newLabel: string) => Promise<{ ok: boolean; error?: string }>
  }
  memory: {
    scan: () => Promise<import('../../shared/types').MemoryScanResult>
    read: (filePath: string) => Promise<string>
    delete: (filePath: string) => Promise<void>
    writeFrontmatter: (filePath: string, frontmatter: { name?: string; description?: string; type?: string }) => Promise<void>
  }
  shell: {
    openExternal: (url: string) => Promise<void>
  }
  github: {
    getConfig: () => Promise<import('../../shared/github-types').GitHubConfig | null>
    updateConfig: (
      patch: Partial<import('../../shared/github-types').GitHubConfig>,
    ) => Promise<import('../../shared/github-types').GitHubConfig>
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
    oauthPoll: (flowId: string) => Promise<{
      ok: boolean
      profileId?: string
      error?: string
    }>
    oauthCancel: (flowId: string) => Promise<{ ok: boolean }>
    ghcliDetect: () => Promise<{ ok: boolean; users: string[] }>
    repoDetect: (cwd: string) => Promise<{ ok: boolean; slug: string | null }>
    updateSessionConfig: (
      sessionId: string,
      patch: Partial<import('../../shared/github-types').SessionGitHubIntegration>,
    ) => Promise<{ ok: boolean; error?: string }>
    getLocalGit: (
      cwd: string,
    ) => Promise<{
      ok: boolean
      state: import('../../shared/github-types').LocalGitState
    }>
    syncNow: (sessionId: string) => Promise<{ ok: boolean }>
    syncFocusedNow: () => Promise<{ ok: boolean }>
    syncPause: () => Promise<{ ok: boolean }>
    syncResume: () => Promise<{ ok: boolean }>
    getData: (
      slug: string,
    ) => Promise<{
      ok: boolean
      data: import('../../shared/github-types').RepoCache | null
    }>
    getSessionContext: (
      sessionId: string,
    ) => Promise<{
      ok: boolean
      data: import('../../shared/github-types').SessionContextResult | null
    }>
    onDataUpdate: (
      cb: (p: {
        slug: string
        data: import('../../shared/github-types').RepoCache
      }) => void,
    ) => () => void
    onSyncStateUpdate: (
      cb: (p: {
        slug: string
        state: 'syncing' | 'synced' | 'rate-limited' | 'error' | 'idle'
        at: number
        nextResetAt?: number
      }) => void,
    ) => () => void
    rerunActionsRun: (slug: string, runId: number) => Promise<{ ok: boolean }>
    mergePR: (
      slug: string,
      prNumber: number,
      method: 'merge' | 'squash' | 'rebase',
    ) => Promise<{ ok: boolean }>
    readyPR: (slug: string, prNumber: number) => Promise<{ ok: boolean }>
    replyToReview: (slug: string, threadId: string, body: string) => Promise<{ ok: boolean }>
    markNotifRead: (profileId: string, notifId: string) => Promise<{ ok: boolean }>
  }
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
    electronPlatform: NodeJS.Platform
  }
}

export {}
