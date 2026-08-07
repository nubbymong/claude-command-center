import { contextBridge, ipcRenderer } from 'electron'
import { IPC, ptyDataChannel, ptyExitChannel } from '../shared/ipc-channels'
import type { HookEvent, HooksGatewayStatus } from '../shared/hook-types'
import type { StatuslineData } from '../shared/types'
import type { ModelRegistry } from '../shared/model-registry'
import type { SentinelStateSnapshot } from '../shared/sentinel-types'

export interface ElectronAPI {
  /** True when this is a dev build (npm run dev / ccc), false for a packaged
   *  prod install. Drives DEV window labeling (title + badge + accent). */
  appIsDev: () => Promise<boolean>
  config: {
    loadAll: () => Promise<{ data: Record<string, unknown>; needsMigration: boolean }>
    save: (key: string, data: unknown) => Promise<boolean>
    migrateFromLocalStorage: (data: Record<string, unknown>) => Promise<boolean>
  }
  accountProfiles: {
    list: () => Promise<import('../shared/account-types').AccountProfile[]>
    create: (name?: string) => Promise<import('../shared/account-types').AccountProfile>
    rename: (id: string, name: string) => Promise<{ ok: boolean }>
    delete: (id: string) => Promise<{ ok: boolean; error?: string }>
    refreshIdentity: (id: string) => Promise<{ ok: boolean; email: string | null; configDir?: string }>
    /** Per-profile credential state: forced-login countdown + identity cross-check. */
    authInfo: () => Promise<import('../shared/account-auth').ProfileAuthInfo[]>
    globalEmail: () => Promise<string | null>
    captureDetected: (sessionId: string, name?: string) => Promise<import('../shared/account-types').AccountProfile | null>
    onAccountNewDetected: (cb: (data: { sessionId: string; profileId: string; email: string }) => void) => () => void
  }
  accountUsage: {
    fetchAll: () => Promise<import('../shared/usage-types').AccountUsage[]>
    fetchOne: (id: string) => Promise<import('../shared/usage-types').AccountUsage | null>
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
      }
      configId?: string
      configLabel?: string
      loggingEnabled?: boolean
      useResumePicker?: boolean
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
    report: (report: import('../shared/service-health').PtyIntegrityReport) => void
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
    onUpdate: (callback: (data: StatuslineData) => void) => () => void
  }
  effort: {
    onUpdate: (callback: (data: { sessionId: string; effortLevel: string }) => void) => () => void
  }
  registry: {
    get: () => Promise<ModelRegistry>
    onUpdate: (callback: (reg: ModelRegistry) => void) => () => void
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
  logsdb: {
    /** T8b (bug #5): exact-conversation resume target for a session, or null. */
    getResumeTarget: (sessionId: string) => Promise<{ uuid: string; cwd: string } | null>
  }
  logsWipe: {
    detect: () => Promise<{ present: boolean; totalBytes: number; paths: string[]; settingsKeys: string[] }>
    confirm: () => Promise<{ deletedPaths: string[]; clearedKeys: string[]; freedBytes: number }>
  }
  logs2: {
    listSlots: () => Promise<unknown[]>
    readMessages: (args: {
      scope: { configId: string } | { sessionId: string }
      anchor?: 'tail' | { runId: number; idx: number }
      dir?: 'older' | 'newer'
      limit?: number
    }) => Promise<unknown[]>
    turnSummary: (args: { scope: { configId: string } | { sessionId: string } }) => Promise<unknown[]>
    search: (args: { query: string; limit?: number }) => Promise<unknown[]>
    deleteSlot: (args: { scope: { configId: string } | { sessionId: string } }) =>
      Promise<{ deletedRuns: number; deletedMessages: number }>
    renameSession: (args: { sessionId: string; configLabel: string }) => Promise<{ ok: boolean }>
    clearAll: () => Promise<{ deletedRuns: number; deletedMessages: number }>
    ingestStatus: (args: { sessionId: string }) => Promise<{
      transcripts: { path: string; status: string; ord: number }[]
      messageCount: number
    } | null>
    sessionConfig: (args: { sessionId: string }) => Promise<{ configId: string | null } | null>
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
    cancel: () => Promise<{ ok: true } | { ok: false; error: string }>
    signOut: (profileId: string) => Promise<{ ok: true } | { ok: false; error: string }>
    openArtifacts: (profileId: string) => Promise<{ ok: true } | { ok: false; error: string }>
    setAuthMethod: (args: { profileId: string; method: 'claudeai' | 'sso' | 'console' }) => Promise<{ ok: true } | { ok: false; error: string }>
    setAuthBrowser: (args: { profileId: string; browser: 'chrome' | 'edge' }) => Promise<{ ok: true } | { ok: false; error: string }>
  }
  discovery: {
    getProjects: () => Promise<unknown>
    getSessionHistory: (projectPath: string) => Promise<unknown>
  }
  update: {
    check: () => Promise<boolean>
    getVersion: () => Promise<string>
    installAndRestart: () => Promise<boolean>
    hasSourcePath: () => Promise<boolean>
    getSourcePath: () => Promise<string>
    setSourcePath: (path: string) => Promise<boolean>
    selectSourcePath: () => Promise<{ path?: string; error?: string } | null>
    onAvailable: (callback: (available: boolean, version?: string) => void) => () => void
    onSourceConfigured: (callback: (configured: boolean) => void) => () => void
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
  codexReview: {
    getUsage: (sessionId: string) => Promise<import('../shared/types').CodexReviewUsageRecord | null>
    onUsageUpdated: (callback: (payload: { sessionId: string; record: import('../shared/types').CodexReviewUsageRecord }) => void) => () => void
  }
  channels: {
    send: (req: unknown) => Promise<unknown>
    retract: (p: unknown) => Promise<unknown>
    forceTier: (p: unknown) => Promise<unknown>
    ruleCRUD: (p: unknown) => Promise<unknown>
    standingApprovalCRUD: (p: unknown) => Promise<unknown>
    capabilityDiagnostics: () => Promise<unknown>
    introDismissed: () => Promise<unknown>
    killSwitch: (p: unknown) => Promise<unknown>
    onLedgerEvent: (cb: (r: unknown) => void) => () => void
    rendererReady: () => Promise<unknown>
    onAttention: (cb: (p: { sessionId: string; needsAttention: boolean }) => void) => () => void
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
  insights: {
    run: (opts?: { profileId?: string }) => Promise<string>
    runAll: (opts?: { profileIds?: string[] }) => Promise<string>
    getCatalogue: () => Promise<import('../shared/types').InsightsCatalogue>
    getReport: (runId: string) => Promise<string | null>
    getKpis: (runId: string) => Promise<import('../shared/types').KpiData | null>
    getLatest: () => Promise<import('../shared/types').InsightsRun | null>
    isRunning: () => Promise<boolean>
    onStatusChanged: (callback: (run: unknown) => void) => () => void
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
    dispatch: (agent: { name: string; description: string; projectPath: string; configId?: string; profileId?: string; legacyVersion?: { enabled: boolean; version: string }; skipPermissions?: boolean }) => Promise<import('../shared/types').CloudAgent>
    cancel: (id: string) => Promise<boolean>
    remove: (id: string) => Promise<boolean>
    retry: (id: string) => Promise<import('../shared/types').CloudAgent | null>
    list: () => Promise<import('../shared/types').CloudAgent[]>
    getOutput: (id: string) => Promise<string>
    clearCompleted: () => Promise<number>
    onStatusChanged: (callback: (agent: import('../shared/types').CloudAgent) => void) => () => void
    onOutputChunk: (callback: (data: { id: string; chunk: string }) => void) => () => void
  }
  team: {
    list: () => Promise<import('../shared/types').TeamTemplate[]>
    save: (team: import('../shared/types').TeamTemplate) => Promise<import('../shared/types').TeamTemplate>
    delete: (id: string) => Promise<boolean>
    run: (teamId: string, projectPath?: string) => Promise<import('../shared/types').TeamRun | null>
    cancelRun: (runId: string) => Promise<boolean>
    listRuns: () => Promise<import('../shared/types').TeamRun[]>
    onRunStatusChanged: (callback: (run: import('../shared/types').TeamRun) => void) => () => void
  }
  serviceStatus: {
    get: () => Promise<unknown>
    onUpdate: (callback: (data: unknown) => void) => () => void
  }
  serviceHealth: {
    get: () => Promise<import('../shared/service-health').DiagnosticsSnapshot>
    restart: (serviceId: string) => Promise<{ ok: boolean; reason?: string }>
    onUpdate: (callback: (snap: import('../shared/service-health').DiagnosticsSnapshot) => void) => () => void
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
    summary: (filter?: import('../shared/types').TkSummaryFilter) => Promise<import('../shared/types').TkSummary | null>
    sessions: (query?: import('../shared/types').TkSessionsQuery) => Promise<import('../shared/types').TkSessionsPage>
    sessionDetail: (sessionId: string) => Promise<import('../shared/types').TkSessionDetail | null>
    indexStatus: () => Promise<import('../shared/types').TkIndexStatus>
    onIndexStatus: (cb: (s: import('../shared/types').TkIndexStatus) => void) => () => void
    onIndexProgress: (cb: (p: import('../shared/types').TkIndexProgress) => void) => () => void
    onIndexComplete: (cb: (c: import('../shared/types').TkIndexCompleteEvent) => void) => () => void
  }
  memory: {
    scan: () => Promise<import('../shared/types').MemoryScanResult>
    read: (filePath: string) => Promise<string>
    delete: (filePath: string) => Promise<void>
    writeFrontmatter: (filePath: string, frontmatter: { name?: string; description?: string; type?: string }) => Promise<void>
    recentSessions: (projectDir: string) => Promise<Array<{ sessionId: string; lastActive: number }>>
  }
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
  updateProfile: (id: string, patch: unknown) => Promise<{ ok: boolean }>
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
  oauthPoll: (flowId: string) => Promise<{ ok: boolean; profileId?: string; error?: string }>
  oauthCancel: (flowId: string) => Promise<{ ok: boolean }>
  reauthProfile: (profileId: string) => Promise<import('../shared/github-types').ReauthResult>
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
  getAiUsage: (force?: boolean) => Promise<unknown>
  onAiUsageUpdate: (cb: (payload: unknown) => void) => () => void
}

const electronAPI: ElectronAPI = {
  appIsDev: () => ipcRenderer.invoke(IPC.APP_IS_DEV),
  config: {
    loadAll: () => ipcRenderer.invoke(IPC.CONFIG_LOAD_ALL),
    save: (key, data) => ipcRenderer.invoke(IPC.CONFIG_SAVE, key, data),
    migrateFromLocalStorage: (data) => ipcRenderer.invoke(IPC.CONFIG_MIGRATE, data),
  },
  accountProfiles: {
    list: () => ipcRenderer.invoke(IPC.ACCOUNT_PROFILES_LIST),
    create: (name?: string) => ipcRenderer.invoke(IPC.ACCOUNT_PROFILES_CREATE, { name }),
    rename: (id, name) => ipcRenderer.invoke(IPC.ACCOUNT_PROFILES_RENAME, { id, name }),
    delete: (id) => ipcRenderer.invoke(IPC.ACCOUNT_PROFILES_DELETE, { id }),
    refreshIdentity: (id) => ipcRenderer.invoke(IPC.ACCOUNT_PROFILES_REFRESH_IDENTITY, { id }),
    authInfo: () => ipcRenderer.invoke(IPC.ACCOUNT_PROFILES_AUTH_INFO),
    globalEmail: () => ipcRenderer.invoke(IPC.ACCOUNT_GLOBAL_EMAIL_GET),
    captureDetected: (sessionId: string, name?: string) => ipcRenderer.invoke(IPC.ACCOUNT_PROFILES_CAPTURE_DETECTED, { sessionId, name }),
    onAccountNewDetected: (cb: (data: { sessionId: string; profileId: string; email: string }) => void) => {
      const handler = (_e: unknown, data: { sessionId: string; profileId: string; email: string }) => cb(data)
      ipcRenderer.on(IPC.ACCOUNT_NEW_DETECTED, handler)
      return () => ipcRenderer.removeListener(IPC.ACCOUNT_NEW_DETECTED, handler)
    },
  },
  accountUsage: {
    fetchAll: () => ipcRenderer.invoke(IPC.ACCOUNT_USAGE_FETCH_ALL),
    fetchOne: (id: string) => ipcRenderer.invoke(IPC.ACCOUNT_USAGE_FETCH_ONE, { id }),
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
    saveImage: () => ipcRenderer.invoke(IPC.CLIPBOARD_SAVE_IMAGE),
    readText: () => ipcRenderer.invoke(IPC.CLIPBOARD_READ_TEXT)
  },
  inputDebug: {
    enabled: () => ipcRenderer.invoke(IPC.DEBUG_INPUT_ENABLED),
    log: (line: string) => ipcRenderer.send(IPC.DEBUG_LOG_INPUT, line)
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
  ptyIntegrity: {
    report: (report: import('../shared/service-health').PtyIntegrityReport) =>
      ipcRenderer.send(IPC.PTY_INTEGRITY_REPORT, report),
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
  effort: {
    onUpdate: (callback) => {
      const handler = (_: unknown, data: unknown) => callback(data as { sessionId: string; effortLevel: string })
      ipcRenderer.on(IPC.HOOKS_EFFORT_UPDATE, handler)
      return () => ipcRenderer.removeListener(IPC.HOOKS_EFFORT_UPDATE, handler)
    },
  },
  registry: {
    get: () => ipcRenderer.invoke(IPC.REGISTRY_GET),
    onUpdate: (callback) => {
      const handler = (_: unknown, reg: unknown) => callback(reg as ModelRegistry)
      ipcRenderer.on(IPC.REGISTRY_UPDATE, handler)
      return () => ipcRenderer.removeListener(IPC.REGISTRY_UPDATE, handler)
    },
  },
  sentinel: {
    getState: () => ipcRenderer.invoke(IPC.SENTINEL_GET_STATE),
    apply: (findingId: string) => ipcRenderer.invoke(IPC.SENTINEL_APPLY, findingId),
    revert: (findingId: string) => ipcRenderer.invoke(IPC.SENTINEL_REVERT, findingId),
    setStatus: (findingId: string, status: 'dismissed' | 'muted') => ipcRenderer.invoke(IPC.SENTINEL_SET_STATUS, findingId, status),
    rerun: () => ipcRenderer.invoke(IPC.SENTINEL_RERUN),
    onUpdate: (callback) => {
      const handler = (_: unknown, snap: unknown) => callback(snap as SentinelStateSnapshot)
      ipcRenderer.on(IPC.SENTINEL_STATE_UPDATE, handler)
      return () => ipcRenderer.removeListener(IPC.SENTINEL_STATE_UPDATE, handler)
    },
  },
  accountIdentity: {
    get: (sessionId) => ipcRenderer.invoke(IPC.ACCOUNT_IDENTITY_GET, { sessionId }),
    onUpdate: (callback) => {
      const handler = (_: unknown, data: unknown) => callback(data as { sessionId: string; email: string; colourKey: string })
      ipcRenderer.on(IPC.ACCOUNT_IDENTITY_UPDATE, handler)
      return () => ipcRenderer.removeListener(IPC.ACCOUNT_IDENTITY_UPDATE, handler)
    },
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
  logsdb: {
    getResumeTarget: (sessionId: string) => ipcRenderer.invoke(IPC.LOGS_GET_RESUME_TARGET, sessionId),
  },
  // Logs v2 — first-run warned wipe of the OLD log artifacts.
  logsWipe: {
    detect: () => ipcRenderer.invoke(IPC.LOGS2_WIPE_DETECT),
    confirm: () => ipcRenderer.invoke(IPC.LOGS2_WIPE_CONFIRM),
  },
  // Logs v2 — the transcript-chat read surface (slots, paged messages, search,
  // turn summary, deletes, ingest status) + a live new-messages push.
  logs2: {
    listSlots: () => ipcRenderer.invoke(IPC.LOGS2_LIST_SLOTS),
    readMessages: (args: {
      scope: { configId: string } | { sessionId: string }
      anchor?: 'tail' | { runId: number; idx: number }
      dir?: 'older' | 'newer'
      limit?: number
    }) => ipcRenderer.invoke(IPC.LOGS2_READ_MESSAGES, args),
    turnSummary: (args: { scope: { configId: string } | { sessionId: string } }) =>
      ipcRenderer.invoke(IPC.LOGS2_TURN_SUMMARY, args),
    search: (args: { query: string; limit?: number }) => ipcRenderer.invoke(IPC.LOGS2_SEARCH, args),
    deleteSlot: (args: { scope: { configId: string } | { sessionId: string } }) =>
      ipcRenderer.invoke(IPC.LOGS2_DELETE_SLOT, args),
    renameSession: (args: { sessionId: string; configLabel: string }) =>
      ipcRenderer.invoke(IPC.LOGS2_RENAME_SESSION, args),
    clearAll: () => ipcRenderer.invoke(IPC.LOGS2_CLEAR_ALL),
    ingestStatus: (args: { sessionId: string }) => ipcRenderer.invoke(IPC.LOGS2_INGEST_STATUS, args),
    sessionConfig: (args: { sessionId: string }) => ipcRenderer.invoke(IPC.LOGS2_SESSION_CONFIG, args),
    onNewMessages: (cb: (e: { sessionId: string; configId: string | null; count: number }) => void) => {
      const handler = (_e: unknown, e: { sessionId: string; configId: string | null; count: number }) => cb(e)
      ipcRenderer.on(IPC.LOGS2_NEW_MESSAGES, handler)
      return () => ipcRenderer.removeListener(IPC.LOGS2_NEW_MESSAGES, handler)
    },
  },
  accountWeb: {
    status: (profileId) => ipcRenderer.invoke(IPC.ACCOUNT_WEB_STATUS, profileId),
    signIn: (profileId) => ipcRenderer.invoke(IPC.ACCOUNT_WEB_SIGN_IN, profileId),
    signInState: () => ipcRenderer.invoke(IPC.ACCOUNT_WEB_SIGN_IN_STATE),
    cancel: () => ipcRenderer.invoke(IPC.ACCOUNT_WEB_CANCEL),
    signOut: (profileId) => ipcRenderer.invoke(IPC.ACCOUNT_WEB_SIGN_OUT, profileId),
    openArtifacts: (profileId) => ipcRenderer.invoke(IPC.ACCOUNT_WEB_OPEN_ARTIFACTS, profileId),
    setAuthMethod: (args) => ipcRenderer.invoke(IPC.ACCOUNT_WEB_SET_AUTH_METHOD, args),
    setAuthBrowser: (args) => ipcRenderer.invoke(IPC.ACCOUNT_WEB_SET_AUTH_BROWSER, args),
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
    run: (opts?: { profileId?: string }) => ipcRenderer.invoke(IPC.INSIGHTS_RUN, opts),
    runAll: (opts?: { profileIds?: string[] }) => ipcRenderer.invoke(IPC.INSIGHTS_RUN_ALL, opts),
    getCatalogue: () => ipcRenderer.invoke(IPC.INSIGHTS_GET_CATALOGUE),
    getReport: (runId: string) => ipcRenderer.invoke(IPC.INSIGHTS_GET_REPORT, runId),
    getKpis: (runId: string) => ipcRenderer.invoke(IPC.INSIGHTS_GET_KPIS, runId),
    getLatest: () => ipcRenderer.invoke(IPC.INSIGHTS_GET_LATEST),
    isRunning: () => ipcRenderer.invoke(IPC.INSIGHTS_IS_RUNNING),
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
    dispatch: (params: { name: string; description: string; projectPath: string; configId?: string; profileId?: string; legacyVersion?: { enabled: boolean; version: string }; skipPermissions?: boolean }) =>
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
    get: () => ipcRenderer.invoke(IPC.SERVICE_STATUS_GET),
    onUpdate: (callback: (data: any) => void) => {
      const handler = (_: unknown, data: any) => callback(data)
      ipcRenderer.on(IPC.SERVICE_STATUS, handler)
      return () => ipcRenderer.removeListener(IPC.SERVICE_STATUS, handler)
    }
  },
  serviceHealth: {
    get: (): Promise<import('../shared/service-health').DiagnosticsSnapshot> =>
      ipcRenderer.invoke(IPC.SERVICE_HEALTH_GET),
    restart: (serviceId: string): Promise<{ ok: boolean; reason?: string }> =>
      ipcRenderer.invoke(IPC.SERVICE_RESTART, serviceId),
    onUpdate: (callback: (snap: import('../shared/service-health').DiagnosticsSnapshot) => void) => {
      const handler = (_: unknown, snap: import('../shared/service-health').DiagnosticsSnapshot) => callback(snap)
      ipcRenderer.on(IPC.SERVICE_HEALTH_UPDATE, handler)
      return () => ipcRenderer.removeListener(IPC.SERVICE_HEALTH_UPDATE, handler)
    }
  },
  cli: {
    check: () => ipcRenderer.invoke(IPC.CLI_CHECK),
    path: () => ipcRenderer.invoke(IPC.CLI_PATH),
    version: () => ipcRenderer.invoke(IPC.CLI_VERSION)
  },
  help: {
    workspace: () => ipcRenderer.invoke(IPC.HELP_WORKSPACE)
  },
  tokenomics: {
    summary: (filter?: import('../shared/types').TkSummaryFilter) => ipcRenderer.invoke(IPC.TOKENOMICS2_SUMMARY, filter ?? {}),
    sessions: (query?: import('../shared/types').TkSessionsQuery) => ipcRenderer.invoke(IPC.TOKENOMICS2_SESSIONS, query ?? {}),
    sessionDetail: (sessionId: string) => ipcRenderer.invoke(IPC.TOKENOMICS2_SESSION_DETAIL, { sessionId }),
    indexStatus: () => ipcRenderer.invoke(IPC.TOKENOMICS2_INDEX_STATUS),
    onIndexStatus: (cb: (s: import('../shared/types').TkIndexStatus) => void) => { const h = (_: unknown, s: import('../shared/types').TkIndexStatus) => cb(s); ipcRenderer.on(IPC.TOKENOMICS2_INDEX_STATUS, h); return () => ipcRenderer.removeListener(IPC.TOKENOMICS2_INDEX_STATUS, h) },
    onIndexProgress: (cb: (p: import('../shared/types').TkIndexProgress) => void) => { const h = (_: unknown, p: import('../shared/types').TkIndexProgress) => cb(p); ipcRenderer.on(IPC.TOKENOMICS2_INDEX_PROGRESS, h); return () => ipcRenderer.removeListener(IPC.TOKENOMICS2_INDEX_PROGRESS, h) },
    onIndexComplete: (cb: (c: import('../shared/types').TkIndexCompleteEvent) => void) => { const h = (_: unknown, c: import('../shared/types').TkIndexCompleteEvent) => cb(c); ipcRenderer.on(IPC.TOKENOMICS2_INDEX_COMPLETE, h); return () => ipcRenderer.removeListener(IPC.TOKENOMICS2_INDEX_COMPLETE, h) },
  },
  memory: {
    scan: () => ipcRenderer.invoke('memory:scan'),
    read: (filePath: string) => ipcRenderer.invoke('memory:read', filePath),
    delete: (filePath: string) => ipcRenderer.invoke('memory:delete', filePath),
    writeFrontmatter: (filePath: string, frontmatter: { name?: string; description?: string; type?: string }) =>
      ipcRenderer.invoke('memory:writeFrontmatter', filePath, frontmatter),
    recentSessions: (projectDir: string) => ipcRenderer.invoke(IPC.MEMORY_RECENT_SESSIONS, projectDir),
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
    updateProfile: (id, patch) => ipcRenderer.invoke(IPC.GITHUB_PROFILE_UPDATE, id, patch),
    testProfile: (id) => ipcRenderer.invoke(IPC.GITHUB_PROFILE_TEST, id),
    oauthStart: (mode, opts) => ipcRenderer.invoke(IPC.GITHUB_OAUTH_START, mode, opts),
    oauthPoll: (flowId) => ipcRenderer.invoke(IPC.GITHUB_OAUTH_POLL, flowId),
    oauthCancel: (flowId) => ipcRenderer.invoke(IPC.GITHUB_OAUTH_CANCEL, flowId),
    reauthProfile: (profileId) => ipcRenderer.invoke(IPC.GITHUB_REAUTH_PROFILE, profileId),
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
    getAiUsage: (force) => ipcRenderer.invoke(IPC.GITHUB_AI_USAGE_GET, force),
    onAiUsageUpdate: (cb) => {
      const l = (_e: Electron.IpcRendererEvent, p: unknown) =>
        cb(p as Parameters<typeof cb>[0])
      ipcRenderer.on(IPC.GITHUB_AI_USAGE_UPDATE, l)
      return () => ipcRenderer.removeListener(IPC.GITHUB_AI_USAGE_UPDATE, l)
    },
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
  codexReview: {
    getUsage: (sessionId: string) =>
      ipcRenderer.invoke(IPC.CODEX_REVIEW_USAGE_GET, sessionId),
    onUsageUpdated: (callback) => {
      const wrapped = (_e: Electron.IpcRendererEvent, payload: { sessionId: string; record: import('../shared/types').CodexReviewUsageRecord }) => callback(payload)
      ipcRenderer.on(IPC.CODEX_REVIEW_USAGE_UPDATED, wrapped)
      return () => ipcRenderer.removeListener(IPC.CODEX_REVIEW_USAGE_UPDATED, wrapped)
    },
  },
  channels: {
    send: (req: unknown) => ipcRenderer.invoke(IPC.CHANNELS_SEND, req),
    retract: (p: unknown) => ipcRenderer.invoke(IPC.CHANNELS_RETRACT, p),
    forceTier: (p: unknown) => ipcRenderer.invoke(IPC.CHANNELS_FORCE_TIER, p),
    ruleCRUD: (p: unknown) => ipcRenderer.invoke(IPC.CHANNELS_RULE_CRUD, p),
    standingApprovalCRUD: (p: unknown) => ipcRenderer.invoke(IPC.CHANNELS_STANDING_APPROVAL_CRUD, p),
    capabilityDiagnostics: () => ipcRenderer.invoke(IPC.CHANNELS_CAPABILITY_DIAGNOSTICS),
    introDismissed: () => ipcRenderer.invoke(IPC.CHANNELS_INTRO_DISMISSED),
    killSwitch: (p: unknown) => ipcRenderer.invoke(IPC.CHANNELS_KILL_SWITCH, p),
    onLedgerEvent: (cb: (r: unknown) => void) => {
      const fn = (_e: unknown, r: unknown) => cb(r)
      ipcRenderer.on(IPC.CHANNELS_LEDGER_EVENT, fn)
      return () => ipcRenderer.removeListener(IPC.CHANNELS_LEDGER_EVENT, fn)
    },
    rendererReady: () => ipcRenderer.invoke(IPC.CHANNELS_RENDERER_READY),
    onAttention: (cb: (p: { sessionId: string; needsAttention: boolean }) => void) => {
      const fn = (_e: unknown, p: { sessionId: string; needsAttention: boolean }) => cb(p)
      ipcRenderer.on(IPC.CHANNELS_ATTENTION, fn)
      return () => ipcRenderer.removeListener(IPC.CHANNELS_ATTENTION, fn)
    },
  },
}

// Expose platform for renderer-side platform checks
contextBridge.exposeInMainWorld('electronPlatform', process.platform)
contextBridge.exposeInMainWorld('electronAPI', electronAPI)
