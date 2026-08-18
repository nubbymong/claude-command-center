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
  InsightsRunMember,
  InsightsCatalogue,
  KpiMetric,
  InsightsData,
  KpiData,
  CrossAccountInsights,
  CrossAccountAccountSummary,
  CrossAccountComparisonRow,
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
  CanvasAnnotationDraft, CanvasChangedEvent, CanvasRenderSource, CanvasReviewChangedEvent,
  CanvasReviewState, CanvasSketchExport, CanvasSnapshotReply, CanvasSnapshotRequestEvent, CanvasState,
  ReclaimableCanvas,
} from '../../shared/canvas'
export type {
  AnchorRef, Annotation, AnnotationScope, AnnotationState,
  CanvasAnnotationDraft, CanvasChangedEvent, CanvasHandle, CanvasHitInfo, CanvasMode, CanvasRenderSource,
  CanvasReviewChangedEvent, CanvasReviewState, CanvasSketchExport,
  CanvasSnapshotReply, CanvasSnapshotRequestEvent, CanvasSnapshotResult,
  CanvasState, CanvasVersion, CanvasVersionSource, CanvasViewportInfo,
  FocusObject, ReclaimableCanvas, Review,
} from '../../shared/canvas'
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
  /** True for a dev build (npm run dev / ccc); drives DEV window labeling. */
  appIsDev: () => Promise<boolean>
  config: {
    loadAll: () => Promise<{ data: Record<string, unknown>; needsMigration: boolean }>
    save: (key: string, data: unknown) => Promise<boolean>
    migrateFromLocalStorage: (data: Record<string, unknown>) => Promise<boolean>
  }
  accountProfiles: {
    list: () => Promise<import('../../shared/account-types').AccountProfile[]>
    rename: (id: string, name: string) => Promise<{ ok: boolean }>
    setActive: (id: string, active: boolean) => Promise<{ ok: boolean; error?: string }>
    delete: (id: string) => Promise<{ ok: boolean; error?: string }>
    refreshIdentity: (id: string) => Promise<{ ok: boolean; email: string | null; configDir?: string }>
    /** Per-profile credential state: forced-login countdown + identity cross-check. */
    authInfo: () => Promise<import('../../shared/account-auth').ProfileAuthInfo[]>
    create: (name?: string) => Promise<import('../../shared/account-types').AccountProfile>
    globalEmail: () => Promise<string | null>
    captureDetected: (sessionId: string, name?: string) => Promise<import('../../shared/account-types').AccountProfile | null>
    onAccountNewDetected: (cb: (data: { sessionId: string; profileId: string; email: string }) => void) => () => void
  }
  accountUsage: {
    fetchAll: () => Promise<import('../../shared/usage-types').AccountUsage[]>
    fetchOne: (id: string) => Promise<import('../../shared/usage-types').AccountUsage | null>
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
    saveImage: () => Promise<{ path: string } | { error: 'no-image' | 'too-large' }>
    /** Focus-independent clipboard text read, retried for Windows delayed-render (#145). */
    readText: () => Promise<string>
  }
  /** Input diagnostics (#145), gated on CCC_INPUT_DEBUG=1 in the main process. */
  inputDebug: {
    enabled: () => Promise<boolean>
    log: (line: string) => void
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
        /** #242 tier 5: respawning a session that previously reached
         *  claude-running -- drives `--continue` when no tmux persistence
         *  is available. See SSHOptions.reconnect in pty-manager.ts. */
        reconnect?: boolean
      }
      shellOnly?: boolean
      elevated?: boolean
      terminalOptions?: { command?: string; args?: string; hasSecretArg?: boolean; elevated?: boolean }
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
      permissionMode?: string
      extraArgs?: string
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
    renameSession: (args: { sessionId: string; configLabel: string }) => Promise<{ ok: boolean }>
    clearAll: () => Promise<{ deletedRuns: number; deletedMessages: number }>
    ingestStatus: (args: { sessionId: string }) => Promise<{
      transcripts: { path: string; status: string; ord: number }[]
      messageCount: number
    } | null>
    sessionConfig: (args: { sessionId: string }) => Promise<{ configId: string | null } | null>
    /** Live push from the worker when a tailed transcript appends messages. */
    onNewMessages: (cb: (e: { sessionId: string; configId: string | null; count: number }) => void) => () => void
  }
  /** Per-account claude.ai web session (#216). */
  accountWeb: {
    status: (profileId: string) => Promise<
      | {
          ok: true
          web: any
          cli: any
          authCommand: string
          authMethod: 'claudeai' | 'sso' | 'console'
          authBrowser: 'chrome' | 'edge'
        }
      | { ok: false; error: string }
    >
    signIn: (profileId: string) => Promise<{ ok: true; state: any } | { ok: false; error: string }>
    signInState: () => Promise<{ ok: true; state: any } | { ok: false; error: string }>
    cancel: (profileId: string) => Promise<{ ok: true } | { ok: false; error: string }>
    signOut: (profileId: string) => Promise<{ ok: true } | { ok: false; error: string }>
    openArtifacts: (profileId: string) => Promise<{ ok: true } | { ok: false; error: string }>
    setAuthMethod: (args: { profileId: string; method: 'claudeai' | 'sso' | 'console' }) => Promise<{ ok: true } | { ok: false; error: string }>
    setAuthBrowser: (args: { profileId: string; browser: 'chrome' | 'edge' }) => Promise<{ ok: true } | { ok: false; error: string }>
  }
  /** Agent Canvas — session review-surface state; content loads over ccc-ux://. */
  canvas: {
    getState: (args: { sessionId: string }) => Promise<CanvasState | null>
    render: (args: { sessionId: string; source: CanvasRenderSource }) => Promise<{ canvasId: string; versionId: string }>
    setActiveVersion: (args: { sessionId: string; versionId: string }) => Promise<CanvasState>
    onChanged: (cb: (e: CanvasChangedEvent) => void) => () => void
    /** main asks the renderer to capture the live content frame; the renderer
     *  answers exactly once per requestId via sendSnapshotResult. */
    onSnapshotRequest: (cb: (e: CanvasSnapshotRequestEvent) => void) => () => void
    sendSnapshotResult: (reply: CanvasSnapshotReply) => void
    /** Canvases from earlier sessions this one could reclaim (read-only).
     *  `openTileSessionIds` are the tiles the user has on screen; main uses
     *  them only to EXCLUDE candidates whose own tile is still live. */
    listReclaimable: (args: { sessionId: string; openTileSessionIds?: string[] }) => Promise<ReclaimableCanvas[]>
    /** The user reclaims a named canvas — the only path that moves ownership. */
    reclaim: (args: {
      sessionId: string
      canvasId: string
      openTileSessionIds?: string[]
    }) => Promise<{ ok: boolean; state: CanvasState | null }>
    // P3 — the review loop (drafts, submit, resolution)
    reviewGetState: (args: { sessionId: string }) => Promise<CanvasReviewState | null>
    annotationUpsert: (args: { sessionId: string; draft: CanvasAnnotationDraft }) => Promise<{ state: CanvasReviewState; annotationId: string }>
    annotationDelete: (args: { sessionId: string; annotationId: string }) => Promise<CanvasReviewState>
    reviewSubmit: (args: { sessionId: string; reviewId: string; sketches: CanvasSketchExport[] }) => Promise<CanvasReviewState>
    annotationResolve: (args: {
      sessionId: string
      annotationId: string
      action: 'approve' | 'dismiss' | 'reannotate'
    }) => Promise<{ state: CanvasReviewState; reannotationId?: string }>
    onReviewChanged: (cb: (e: CanvasReviewChangedEvent) => void) => () => void
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
    /** Cross-account roll-up: runs every targeted account, then synthesizes one report. */
    runAll: (opts?: { profileIds?: string[] }) => Promise<string>
    getCatalogue: () => Promise<InsightsCatalogue>
    getReport: (runId: string) => Promise<string | null>
    getKpis: (runId: string) => Promise<KpiData | null>
    getLatest: () => Promise<InsightsRun | null>
    isRunning: () => Promise<boolean>
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
    path: () => Promise<string | null>
    version: () => Promise<string | null>
  }
  help: {
    workspace: () => Promise<string | null>
  }
  tokenomics: {
    summary: (filter?: import('../../shared/types').TkSummaryFilter) => Promise<import('../../shared/types').TkSummary | null>
    sessions: (query?: import('../../shared/types').TkSessionsQuery) => Promise<import('../../shared/types').TkSessionsPage>
    sessionDetail: (sessionId: string) => Promise<import('../../shared/types').TkSessionDetail | null>
    indexStatus: () => Promise<import('../../shared/types').TkIndexStatus>
    onIndexStatus: (cb: (s: import('../../shared/types').TkIndexStatus) => void) => () => void
    onIndexProgress: (cb: (p: import('../../shared/types').TkIndexProgress) => void) => () => void
    onIndexComplete: (cb: (c: import('../../shared/types').TkIndexCompleteEvent) => void) => () => void
  }
  memory: {
    scan: () => Promise<import('../../shared/types').MemoryScanResult>
    read: (filePath: string) => Promise<string>
    delete: (filePath: string) => Promise<void>
    writeFrontmatter: (filePath: string, frontmatter: { name?: string; description?: string; type?: string }) => Promise<void>
    recentSessions: (projectDir: string) => Promise<Array<{ sessionId: string; lastActive: number }>>
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
    // Generic profile patch. The renderer may ONLY assert label + featureToggles
    // (RendererProfilePatch). Auth-system fields (scopes/capabilities/expiry/
    // verification timestamps) are derived from token verification in main and
    // are NOT renderer-patchable; the GITHUB_PROFILE_UPDATE handler narrows the
    // incoming patch to this shape before it reaches the store (review F1).
    updateProfile: (
      id: string,
      patch: import('../../shared/github-types').RendererProfilePatch,
    ) => Promise<{ ok: boolean }>
    testProfile: (id: string) => Promise<{
      ok: boolean
      username?: string
      scopes?: string[]
      expiresAt?: number
      error?: string
    }>
    oauthStart: (
      mode: 'public' | 'private',
      opts?: { includeUserScope?: boolean },
    ) => Promise<{
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
    reauthProfile: (profileId: string) => Promise<import('../../shared/github-types').ReauthResult>
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
    getAiUsage: (force?: boolean) => Promise<import('../../shared/github-types').AiUsagePayload>
    onAiUsageUpdate: (
      cb: (payload: import('../../shared/github-types').AiUsagePayload) => void,
    ) => () => void
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
