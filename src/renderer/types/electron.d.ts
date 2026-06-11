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
  NoteMetadata,
  AgentTemplate,
  AgentModelOverride,
  TeamTemplate,
  TeamRun,
  TeamStep,
  TeamStepMode,
  TeamRunStep,
  TeamRunStatus,
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
} from '../../shared/types'
import type { HookEvent, HooksGatewayStatus } from '../../shared/hook-types'
export type { HookEvent, HookEventKind, HooksGatewayStatus } from '../../shared/hook-types'
import type { ModelRegistry } from '../../shared/model-registry'
export type { ModelRegistry } from '../../shared/model-registry'
import type { SentinelStateSnapshot } from '../../shared/sentinel-types'
export type { SentinelStateSnapshot, SentinelFinding, FindingKind, FindingSeverity, FindingStatus } from '../../shared/sentinel-types'
import type {
  ChannelPayload,
  ChannelEnvelopeMeta,
  LedgerRecord,
  ChannelRule,
  StandingApproval,
  FeatureState,
  StandingApprovalTool,
  StandingApprovalTtl,
} from '../../shared/channel-types'
export type {
  ChannelPayload, ChannelEnvelopeMeta, LedgerRecord,
  ChannelRule, StandingApproval, FeatureState,
} from '../../shared/channel-types'

// Mirror of the main-process service-status payload (src/main/service-status.ts).
// Declared locally so the renderer/web tsconfig doesn't pull a main-process
// module (with its Node imports) into its type graph.
export interface ServiceComponentStatus {
  id: string
  label: string
  status: string
  name: string
}
export interface ServiceStatusPayload {
  fetchedAt: string
  claudeCode: ServiceComponentStatus | null
  claudeAi: ServiceComponentStatus | null
  api: ServiceComponentStatus | null
  worst: string
}

export interface ElectronAPI {
  config: {
    loadAll: () => Promise<{ data: Record<string, unknown>; needsMigration: boolean }>
    save: (key: string, data: unknown) => Promise<boolean>
    migrateFromLocalStorage: (data: Record<string, unknown>) => Promise<boolean>
  }
  accountProfiles: {
    list: () => Promise<import('../../shared/account-types').AccountProfile[]>
    rename: (id: string, name: string) => Promise<{ ok: boolean }>
    delete: (id: string) => Promise<{ ok: boolean }>
    refreshIdentity: (id: string) => Promise<{ ok: boolean; email: string | null; configDir?: string }>
    create: (name?: string) => Promise<import('../../shared/account-types').AccountProfile>
    globalEmail: () => Promise<string | null>
    captureDetected: (sessionId: string, name?: string) => Promise<import('../../shared/account-types').AccountProfile | null>
    onAccountNewDetected: (cb: (data: { sessionId: string; profileId: string; email: string }) => void) => () => void
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
        dockerContainer?: string
      }
      shellOnly?: boolean
      elevated?: boolean
      configId?: string
      configLabel?: string
      loggingEnabled?: boolean
      useResumePicker?: boolean
      legacyVersion?: {
        enabled: boolean
        version: string
      }
      agentsConfig?: Array<{
        name: string; description: string; prompt: string
        model?: string; tools?: string[]
      }>
      effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode'
      disableAutoMemory?: boolean
      enableCodexReview?: boolean
      resume?: { uuid: string; cwd: string }
      model?: string
      profileId?: string
      provider?: 'claude' | 'codex'
      codexOptions?: {
        model?: string
        reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'
        permissionsPreset: 'read-only' | 'standard' | 'auto' | 'unrestricted'
      }
    }) => Promise<void>
    write: (sessionId: string, data: string) => void
    resize: (sessionId: string, cols: number, rows: number) => void
    kill: (sessionId: string) => void
    onData: (sessionId: string, callback: (data: string) => void) => () => void
    onExit: (sessionId: string, callback: (exitCode: number) => void) => () => void
  }
  ptyIntegrity: {
    report: (report: import('../../shared/service-health').PtyIntegrityReport) => void
  }
  ssh: {
    runPostCommand: (sessionId: string) => Promise<void>
    launchClaude: (sessionId: string) => Promise<void>
    skip: (sessionId: string) => Promise<void>
    getState: (sessionId: string) => Promise<{ state: string; info?: string }>
    onFlowState: (sessionId: string, callback: (msg: { state: string; info?: string }) => void) => () => void
  }
  statusline: {
    onUpdate: (callback: (data: StatuslineData) => void) => () => void
  }
  effort: {
    onUpdate: (callback: (data: { sessionId: string; effortLevel: string }) => void) => () => void
  }
  registry: {
    get(): Promise<ModelRegistry>
    onUpdate(cb: (reg: ModelRegistry) => void): () => void
  }
  sentinel: {
    getState(): Promise<SentinelStateSnapshot | null>
    apply(id: string): Promise<{ ok: boolean; error?: string }>
    revert(id: string): Promise<void>
    setStatus(id: string, status: 'dismissed' | 'muted'): Promise<void>
    rerun(): Promise<void>
    onUpdate(cb: (snap: SentinelStateSnapshot) => void): () => void
  }
  accountIdentity: {
    get: (sessionId: string) => Promise<{ email: string; colourKey: string } | null>
    onUpdate: (callback: (data: { sessionId: string; email: string; colourKey: string }) => void) => () => void
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
  logsdb: {
    /** T8b (bug #5): exact-conversation resume target for a session, or null. */
    getResumeTarget: (sessionId: string) => Promise<{ uuid: string; cwd: string } | null>
  }
  logsWipe: {
    /** Detect the OLD log artifacts (logs.db*, legacy logs/ tree, migration markers). */
    detect: () => Promise<{
      present: boolean
      totalBytes: number
      paths: string[]
      settingsKeys: string[]
    }>
    /** Delete the detected artifacts + clear the 2 legacy-migration settings keys. */
    confirm: () => Promise<{
      deletedPaths: string[]
      clearedKeys: string[]
      freedBytes: number
    }>
  }
  /** Logs v2 — the transcript-chat read surface (routes through the transcripts worker). */
  logs2: {
    listSlots: () => Promise<Array<{
      slotKey: string
      configId: string | null
      configLabel: string
      accountEmail: string | null
      lastActive: number
      runCount: number
      messageCount: number
    }>>
    readMessages: (args: {
      scope: { configId: string } | { sessionId: string }
      anchor?: 'tail' | { runId: number; idx: number }
      dir?: 'older' | 'newer'
      limit?: number
    }) => Promise<Array<{
      runId: number
      idx: number
      ts: number
      role: string
      kind: string
      content: string
      toolName: string | null
      toolMeta: string | null
    }>>
    turnSummary: (args: { scope: { configId: string } | { sessionId: string } }) => Promise<Array<{
      runId: number
      idx: number
      role: string
      kind: string
      ts: number
      toolName: string | null
    }>>
    search: (args: { query: string; limit?: number }) => Promise<Array<{
      runId: number
      idx: number
      configId: string | null
      sessionId: string
      snippet: string
    }>>
    deleteSlot: (args: { scope: { configId: string } | { sessionId: string } }) =>
      Promise<{ deletedRuns: number; deletedMessages: number }>
    clearAll: () => Promise<{ deletedRuns: number; deletedMessages: number }>
    ingestStatus: (args: { sessionId: string }) => Promise<{
      transcripts: { path: string; status: string; ord: number }[]
      messageCount: number
    } | null>
    /** Live push from the worker when a tailed transcript appends messages. */
    onNewMessages: (cb: (e: { sessionId: string; configId: string | null; count: number }) => void) => () => void
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
  webview: {
    check: (url: string) => Promise<{ reachable: boolean; status?: number }>
    open: (sessionId: string, url: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<boolean>
    close: (sessionId: string) => Promise<boolean>
    setBounds: (sessionId: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<void>
    setVisible: (sessionId: string, visible: boolean) => Promise<void>
    reload: (sessionId: string) => Promise<void>
    capture: (sessionId: string) => Promise<string | null>
    navBack: (sessionId: string) => Promise<void>
    navForward: (sessionId: string) => Promise<void>
    goHome: (sessionId: string) => Promise<void>
    closeAll: () => Promise<boolean>
    onEscapePressed: (handler: (sessionId: string) => void) => () => void
  }
  session: {
    save: (state: SessionState) => Promise<boolean>
    load: () => Promise<SessionState | null>
    clear: () => Promise<boolean>
    hasSaved: () => Promise<boolean>
    gracefulExit: () => Promise<boolean>
  }
  insights: {
    run: (opts?: { profileId?: string }) => Promise<string>
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
    saveConfig: (config: { enabled?: boolean; browser: 'chrome' | 'edge'; debugPort: number; mcpPort?: number; url?: string; headless?: boolean }) => Promise<{ ok: boolean }>
    getConfig: () => Promise<{ enabled?: boolean; browser: 'chrome' | 'edge'; debugPort: number; mcpPort?: number; url?: string; headless?: boolean } | null>
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
    dispatch: (agent: { name: string; description: string; projectPath: string; configId?: string; profileId?: string; legacyVersion?: { enabled: boolean; version: string } }) => Promise<CloudAgent>
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
    get: () => Promise<ServiceStatusPayload | null>
    onUpdate: (callback: (data: ServiceStatusPayload) => void) => () => void
  }
  serviceHealth: {
    get: () => Promise<import('../../shared/service-health').DiagnosticsSnapshot>
    restart: (serviceId: string) => Promise<{ ok: boolean; reason?: string }>
    onUpdate: (callback: (snap: import('../../shared/service-health').DiagnosticsSnapshot) => void) => () => void
  }
  cli: {
    check: () => Promise<boolean>
  }
  tokenomics: {
    summary: (filter?: import('../../shared/types').TkSummaryFilter) => Promise<import('../../shared/types').TkSummary | null>
    sessions: (query?: import('../../shared/types').TkSessionsQuery) => Promise<import('../../shared/types').TkSessionsPage>
    sessionDetail: (sessionId: string) => Promise<import('../../shared/types').TkSessionDetail | null>
    indexStatus: () => Promise<import('../../shared/types').TkIndexStatus>
    onIndexProgress: (cb: (p: import('../../shared/types').TkIndexProgress) => void) => () => void
    onIndexComplete: (cb: (c: import('../../shared/types').TkIndexCompleteEvent) => void) => () => void
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
    notifyFocusChanged: (sessionId: string | null) => void
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
    onNotificationsUpdate: (
      cb: (p: {
        profileId: string
        items: import('../../shared/github-types').NotificationSummary[]
      }) => void,
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
  hooks: {
    toggle: (enabled: boolean) => Promise<HooksGatewayStatus>
    getBuffer: (sessionId: string) => Promise<HookEvent[]>
    getStatus: () => Promise<HooksGatewayStatus>
    onEvent: (cb: (e: HookEvent) => void) => () => void
    onSessionEnded: (cb: (sid: string) => void) => () => void
    onDropped: (cb: (p: { sessionId: string }) => void) => () => void
    onStatus: (cb: (s: HooksGatewayStatus) => void) => () => void
  }
  codexReview: {
    getUsage: (sessionId: string) => Promise<import('../../shared/types').CodexReviewUsageRecord | null>
    onUsageUpdated: (callback: (payload: { sessionId: string; record: import('../../shared/types').CodexReviewUsageRecord }) => void) => () => void
  }
  channels: {
    send: (req: { targetSessionId: string; targetLabel?: string; payload: ChannelPayload; meta: ChannelEnvelopeMeta }) => Promise<{ ok: boolean; reason?: string; transport?: 'pty' | 'mcp'; ledgerId?: string }>
    retract: (p: { targetSessionId: string; targetLabel?: string }) => Promise<{ ok: boolean; reason?: string; transport?: 'pty' | 'mcp'; ledgerId?: string }>
    forceTier: (p: { sessionId: string; tier: 'auto' | 'tier-1' | 'tier-2' }) => Promise<{ ok: boolean }>
    ruleCRUD: (p: { op: 'list' } | { op: 'save'; rule: ChannelRule } | { op: 'delete'; id: string }) => Promise<ChannelRule[] | { ok: boolean; rules: ChannelRule[] }>
    standingApprovalCRUD: (p: { op: 'add'; tool: StandingApprovalTool; ttl: StandingApprovalTtl } | { op: 'remove'; id: string } | { op: 'list' }) => Promise<StandingApproval[]>
    capabilityDiagnostics: () => Promise<{ descriptor: unknown; handshakes: unknown[]; sessions: unknown[]; protocolRange: string }>
    introDismissed: () => Promise<FeatureState>
    killSwitch: (p: { disabled: boolean }) => Promise<FeatureState>
    onLedgerEvent: (cb: (r: LedgerRecord) => void) => () => void
    rendererReady: () => Promise<unknown>
    onAttention: (cb: (p: { sessionId: string; needsAttention: boolean }) => void) => () => void
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
}

declare global {
  interface Window {
    electronAPI: ElectronAPI
    electronPlatform: NodeJS.Platform
  }
}

export {}
