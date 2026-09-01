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
  ComposerDraftInput, EvidenceCaptureResult, EvidenceStateStamp, ForceClosures, Rect,
  CanvasDismissRefusal, CanvasDismissResult, CanvasLibraryFilter, CanvasLibraryResult, CanvasLibraryTab,
  CanvasResumeResult, ResumableRow,
  TrailEntry,
} from '../../shared/canvas'
export type {
  AnchorRef, Annotation, AnnotationScope, AnnotationState, ForceClosures,
  CanvasAnnotationDraft, CanvasChangedEvent, CanvasHandle, CanvasHitInfo, CanvasMode, CanvasRenderSource,
  CanvasReviewChangedEvent, CanvasReviewState, CanvasSketchExport, ComposerDraft, ComposerDraftInput,
  CanvasSnapshotReply, CanvasSnapshotRequestEvent, CanvasSnapshotResult,
  CanvasState, CanvasVersion, CanvasVersionSource, CanvasViewportInfo,
  FocusObject, Review, CanvasLibraryEntry,
  // Testing-mode evidence (M3): the renderer builds the stamp and the trail and
  // renders the recall view from them.
  AnnotationEvidence, EvidenceCaptureRefusal, EvidenceCaptureResult, EvidenceStateStamp,
  FieldFill, StampTarget, TrailEntry,
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

// Mirror of src/main/watchdog/session-watchdog.ts's WatchdogPublicState (#235).
// Declared locally for the same reason as ServiceComponentStatus above — the
// renderer/web tsconfig must not pull a main-process module into its type graph.
export interface WatchdogPublicState {
  sessionId: string
  status: 'monitoring' | 'waiting' | 'overload' | 'safeguard'
  attempts: number
  overloadAttempts: number
  safeguardAttempts: number
  waitUntil: number | null
  gaveUp: boolean
  lastAction: string | null
  updatedAt: number
}

export interface ElectronAPI {
  /** True for a dev build (npm run dev / ccc); drives DEV window labeling. */
  appIsDev: () => Promise<boolean>
  config: {
    loadAll: () => Promise<{ data: Record<string, unknown>; needsMigration: boolean; readFailed?: boolean; failedKeys?: string[] }>
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
    fetchOne: (id: string, opts?: { noRefresh?: boolean }) => Promise<import('../../shared/usage-types').AccountUsage | null>
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
        /** item e: structured container runtime (main rebuilds it from the
         *  saved config via spawn-credential-binding; the request's copy is
         *  informational only). */
        runtime?: import('../../shared/types').SshRuntime
        /** #242 tier 5: respawning a session that previously reached
         *  claude-running -- drives `--continue` when no tmux persistence
         *  is available. See SSHOptions.reconnect in pty-manager.ts. */
        reconnect?: boolean
        /** SSH tmux enhancement (item 1): "Detachable" toggle (default ON). */
        detachable?: boolean
        /** SSH tmux enhancement (item 3): remote OS ('windows' uses the Windows setup path). */
        remoteOs?: 'auto' | 'unix' | 'windows'
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
      /** Ask Conductor's opening question. Travels in the spawn ENVIRONMENT as
       *  CCC_ASK_PROMPT; the launch line carries only the env reference, never
       *  the text. Claude + local + non-shell only. */
      askPrompt?: string
      /** Session kind: an Ask Conductor one-shot. Keeps a watchdog off it (#266). */
      isAsk?: boolean
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
    onSessionInfo: (sessionId: string, callback: (msg: { tmuxPersistent?: boolean; remoteAccount?: string }) => void) => () => void
    /** END a remote session. A bare id for a LIVE one (main holds its spawn
     *  target); `{ sessionId, configId }` for a DETACHED one, which main
     *  reconnects to from the SAVED config (Phase 3.5). */
    endRemote: (target: string | { sessionId: string; configId?: string }) => Promise<void>
    /** SSH Persistent (resume liveness): ask main whether a config's detached
     *  `ccc-<sessionId>` tmux sessions are still alive on the host. */
    checkDetachedLive: (payload: { configId: string; sessionIds: string[] }) => Promise<import('../../shared/types').DetachedRemoteLiveness>
    /** SSH Persistent (resume liveness, tier 1): is a host answering at all?
     *  ICMP + TCP:22 fallback, no ssh/auth. Demote-only — see host-ping.ts. */
    pingHost: (payload: { host: string }) => Promise<import('../../shared/types').HostPingResult>
  }
  statusline: {
    onUpdate: (callback: (data: StatuslineData) => void) => () => void
  }
  effort: {
    onUpdate: (callback: (data: { sessionId: string; effortLevel: string }) => void) => () => void
  }
  /** Session Watchdog (#235): auto-retry on rate-limit/overload/safeguard. */
  watchdog: {
    getStates: () => Promise<WatchdogPublicState[]>
    onUpdate: (callback: (state: WatchdogPublicState) => void) => () => void
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
    renameSession: (args: { sessionId: string; configLabel: string; customName?: string }) => Promise<{ ok: boolean }>
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
          webSignInMode: 'auto' | 'internal-pane'
          detectedBrowsers: Array<'chrome' | 'edge'>
        }
      | { ok: false; error: string }
    >
    /** Web-session status only — a local read, no CLI subprocess. */
    webStatus: (profileId: string) => Promise<{ ok: true; web: any } | { ok: false; error: string }>
    signIn: (profileId: string) => Promise<{ ok: true; state: any } | { ok: false; error: string }>
    signInState: () => Promise<{ ok: true; state: any } | { ok: false; error: string }>
    cancel: (profileId: string) => Promise<{ ok: true } | { ok: false; error: string }>
    signOut: (profileId: string) => Promise<{ ok: true } | { ok: false; error: string }>
    openArtifacts: (profileId: string) => Promise<{ ok: true } | { ok: false; error: string }>
    setAuthMethod: (args: { profileId: string; method: 'claudeai' | 'sso' | 'console' }) => Promise<{ ok: true } | { ok: false; error: string }>
    setAuthBrowser: (args: { profileId: string; browser: 'chrome' | 'edge' }) => Promise<{ ok: true } | { ok: false; error: string }>
    setSignInMode: (args: { profileId: string; mode: 'auto' | 'internal-pane' }) => Promise<{ ok: true } | { ok: false; error: string }>
    /** The pane's account surface (#439/#475): claude.ai on the account's partition. */
    paneOpen: (args: { sessionId: string; profileId: string; bounds: { x: number; y: number; width: number; height: number } }) => Promise<{ ok: boolean; error?: string }>
    paneClose: (sessionId: string) => Promise<{ ok: boolean }>
    paneBounds: (args: { sessionId: string; bounds: { x: number; y: number; width: number; height: number } }) => Promise<{ ok: boolean }>
    paneVisible: (args: { sessionId: string; visible: boolean }) => Promise<{ ok: boolean }>
    paneReload: (sessionId: string) => Promise<{ ok: boolean }>
    paneGetState: (sessionId: string) => Promise<{ ok: true; state: { sessionId: string; profileId: string; authed: boolean | null; email: string | null } | null } | { ok: false; error: string }>
    onPaneState: (cb: (state: { sessionId: string; profileId: string; authed: boolean | null; email: string | null }) => void) => () => void
    onPaneClosed: (cb: (e: { sessionId: string }) => void) => () => void
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
    /** THE PROJECT LIBRARY (M4), one row per ARTEFACT RUN. Search, tab, chip
     *  and the cap are applied in MAIN, so `truncated` is honest and another
     *  live session's in-flight work never crosses the boundary at all. */
    libraryList: (args: {
      sessionId: string
      openTileSessionIds?: string[]
      query?: string
      tab?: CanvasLibraryTab
      filter?: CanvasLibraryFilter
      sort?: 'recent'
    }) => Promise<CanvasLibraryResult>
    /** OWNERLESS IN-FLIGHT canvases on this project. Pure read; nothing moves
     *  until the user picks one. Each row carries the owner it was listed
     *  with — pass it straight back to `resume`. */
    listResumables: (args: { sessionId: string; openTileSessionIds?: string[] }) => Promise<ResumableRow[]>
    /** RESUME one, first-wins. `expectedOwnerSessionId` is the row's own
     *  `expectedOwnerSessionId`: main compares and sets in one synchronous
     *  step, so a second session racing you is told 'changed'. */
    resume: (args: {
      sessionId: string
      canvasId: string
      expectedOwnerSessionId: string
      openTileSessionIds?: string[]
    }) => Promise<CanvasResumeResult>
    /** DISCARD an in-flight canvas and its evidence. Owner, or a same-project
     *  caller when it is ownerless; never while another session is live-owner. */
    dismiss: (args: {
      sessionId: string
      canvasId: string
      openTileSessionIds?: string[]
    }) => Promise<CanvasDismissResult>
    /** READ a COMPLETED canvas owned by another session in this project, for
     *  the read-only view. Never transfers ownership and grants no write. */
    getReadonly: (args: { sessionId: string; canvasId: string }) => Promise<CanvasState | null>
    listAll: (args?: { openTileSessionIds?: string[]; sessionId?: string }) => Promise<CanvasLibraryEntry[]>
    /** The user deletes a canvas and its files. OWNER-GUARDED since M4:
     *  `sessionId` says who is asking, and a canvas a live other session owns —
     *  or somebody else's signed-off one — is refused with a reason. */
    deleteCanvas: (args: {
      sessionId: string
      canvasId: string
      openTileSessionIds?: string[]
    }) => Promise<{ ok: boolean; reason?: CanvasDismissRefusal }>
    /** Archive/unarchive one artifact (item C): reversible, returns the state.
     *  Owner-guarded since M4, same rule as delete. */
    archiveArtifact: (args: {
      sessionId: string
      canvasId: string
      versionId: string
      archived: boolean
      openTileSessionIds?: string[]
    }) => Promise<{ ok: boolean; state: CanvasState | null; reason?: CanvasDismissRefusal }>
    /** Permanently delete one artifact, its versions and their review notes.
     *  Owner-guarded since M4, same rule as delete. */
    deleteArtifact: (args: {
      sessionId: string
      canvasId: string
      versionId: string
      openTileSessionIds?: string[]
    }) => Promise<
      | { ok: true; deletedVersions: number; notesDeleted: number }
      | { ok: false; reason: 'not-found' | 'only-artifact' | 'unsafe' | CanvasDismissRefusal }
    >
    /** OPEN HERE: point this session at a canvas IT ALREADY OWNS. Transfers
     *  nothing; a foreign canvas is refused (taking one is `resume`). */
    reclaim: (args: {
      sessionId: string
      canvasId: string
      openTileSessionIds?: string[]
    }) => Promise<{ ok: boolean; state: CanvasState | null }>
    // P3 — the review loop (drafts, submit, resolution)
    reviewGetState: (args: { sessionId: string }) => Promise<CanvasReviewState | null>
    annotationUpsert: (args: { sessionId: string; draft: CanvasAnnotationDraft }) => Promise<{ state: CanvasReviewState; annotationId: string }>
    annotationDelete: (args: { sessionId: string; annotationId: string }) => Promise<CanvasReviewState>
    /** The decision is REQUIRED — the user's word is version-level. */
    reviewSubmit: (args: { sessionId: string; reviewId: string; sketches: CanvasSketchExport[]; decision: 'approve' | 'reject' }) => Promise<CanvasReviewState>
    versionVerdict: (args: { sessionId: string; versionId?: string; state: 'approved' | 'rejected' | 'dismissed'; note?: string }) => Promise<CanvasState | { error: string }>
    versionReopen: (args: { sessionId: string; versionId: string }) => Promise<CanvasState | { error: string }>
    /** The user puts a closed note back in play. With `reviewReopen`, one of the
     *  only two writes that may revive a settled round. */
    annotationReopen: (args: { sessionId: string; annotationId: string }) => Promise<CanvasReviewState>
    /** The user puts a whole settled ROUND back in play. */
    reviewReopen: (args: { sessionId: string; canvasId: string; reviewId: string }) => Promise<CanvasReviewState>
    /** The user has these addressed notes on screen — the release side of the
     *  agent close-out barrier. Renderer-only; no MCP tool reaches it. */
    reviewMarkSeen: (args: { sessionId: string; canvasId: string; annotationIds: string[] }) => Promise<{ state: CanvasReviewState; seen: string[] }>
    /** Persist the half-written note (W14): text, decision, target, pasted
     *  images, sketch scene. Owner-scoped; no MCP tool reaches it. */
    composerDraftSet: (args: { sessionId: string; canvasId: string; draft: ComposerDraftInput }) => Promise<CanvasReviewState>
    /** Drop it — the round was submitted, or the composer was emptied. */
    composerDraftClear: (args: { sessionId: string; canvasId: string }) => Promise<CanvasReviewState>
    /** Sign the subject off (#476). Refused (`ok:false` + reason) while
     *  anything is owed either way; the pane then shows its front page. */
    complete: (args: { sessionId: string; canvasId: string }) => Promise<{ ok: boolean; reason?: string; state?: CanvasState }>
    /** Force-close what is owed, then sign off (W3). USER-only. */
    completeForce: (args: { sessionId: string; canvasId: string }) => Promise<{ ok: boolean; reason?: string; state?: CanvasState }>
    /** What that force would close, so the armed confirm can name it. `null`
     *  for an unreadable store, or a session that does not own the canvas. */
    describeForceClosures: (args: { sessionId: string; canvasId: string }) => Promise<ForceClosures | null>
    /** The one-click undo: clear a canvas's completed stamp. */
    completeReopen: (args: { sessionId: string; canvasId: string }) => Promise<{ ok: boolean; reason?: string; state?: CanvasState }>
    onReviewChanged: (cb: (e: CanvasReviewChangedEvent) => void) => () => void
    /** TESTING MODE (M3): screenshot the framed page and hold it, with the state
     *  stamp and the trail slice taken at the same instant, until a note locks
     *  it. The rect is clamped in main; refusals are one word from a closed set
     *  ('rate' | 'pack-full' | 'capture-failed' | 'not-owner' | 'not-uat'). */
    evidenceCapture: (args: {
      sessionId: string
      canvasId: string
      versionId: string
      rect: Rect
      stamp: EvidenceStateStamp
      trail: TrailEntry[]
    }) => Promise<EvidenceCaptureResult>
    /** The user cancelled: the pending capture is thrown away. */
    evidenceDiscard: (args: { sessionId: string; canvasId: string; evidenceId: string }) => Promise<{ ok: boolean }>
    /** Read one image the canvas RECORDS (evidence shot, pasted image, sketch
     *  export, composer image). A path that is not on the record answers null. */
    evidenceRead: (args: { sessionId: string; canvasId: string; path: string }) => Promise<{ dataUrl: string } | null>
    /** Name the test pack; `null` clears it back to the generated default. A
     *  refused rename answers with the state main kept. */
    setPackName: (args: {
      sessionId: string
      canvasId: string
      versionId: string
      name: string | null
    }) => Promise<CanvasState | null>
    /** A full-document navigation inside the canvas frame, for the action trail. */
    onFrameNavigated: (cb: (e: { sessionId: string; canvasId: string; route: string }) => void) => () => void
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
    probeCli: () => Promise<{ installed: boolean; path?: string; probe: string }>
    spawnCliSetup: (cols: number, rows: number) => Promise<string>
    killCliSetup: () => Promise<boolean>
  }
  diagnostics: {
    captureGlyph: (payload: unknown) => Promise<{ ok: boolean; jsonPath?: string; imagePath?: string; error?: string }>
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
    /** Session closed for good: destroy the view AND wipe its browser profile. */
    forget: (sessionId: string) => Promise<boolean>
    setBounds: (sessionId: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<void>
    setVisible: (sessionId: string, visible: boolean) => Promise<void>
    reload: (sessionId: string) => Promise<void>
    capture: (sessionId: string) => Promise<string | null>
    navBack: (sessionId: string) => Promise<void>
    navForward: (sessionId: string) => Promise<void>
    goHome: (sessionId: string) => Promise<void>
    /** Load an http/https URL in the session's EXISTING view; false when there is no view yet. */
    navigate: (sessionId: string, url: string) => Promise<boolean>
    /** Hand an http/https URL to the OS browser (main re-validates). */
    openExternal: (url: string) => Promise<boolean>
    closeAll: () => Promise<boolean>
    onEscapePressed: (handler: (sessionId: string) => void) => () => void
    /** Navigation state from the session's view: real URL, title, history flags, loading. */
    onNavigated: (handler: (state: { sessionId: string; url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean }) => void) => () => void
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
    /**
     * #371. `generation` is the token handed out by `getConfig` alongside the
     * config the form was built from. Pass it back so main can refuse a save
     * built from defaults it showed while the settings file was unreadable
     * (`ok:false, stale:true`). `ok:false` means IT IS NOT ON DISK.
     */
    saveConfig: (config: { enabled?: boolean; browser: 'chrome' | 'edge'; debugPort: number; mcpPort?: number; url?: string; headless?: boolean }, generation?: number) => Promise<{ ok: boolean; stale?: boolean; error?: string }>
    /** `readFailed` distinguishes "no config yet" from "could not read it" — the
     *  caller must not present defaults as saved settings in the latter case. */
    getConfig: () => Promise<{ config: { enabled?: boolean; browser: 'chrome' | 'edge'; debugPort: number; mcpPort?: number; url?: string; headless?: boolean } | null; generation: number; readFailed: boolean }>
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
    /** #371: `ok:false` means the agent is STILL on disk — do not drop the row. */
    remove: (id: string) => Promise<{ ok: true; removed: boolean } | { ok: false; error: string }>
    retry: (id: string) => Promise<CloudAgent | null>
    list: () => Promise<CloudAgent[]>
    getOutput: (id: string) => Promise<string>
    /** #371: `ok:false` means nothing was cleared — do not filter the list. */
    clearCompleted: () => Promise<{ ok: true; removed: number } | { ok: false; error: string }>
    onStatusChanged: (callback: (agent: CloudAgent) => void) => () => void
    onOutputChunk: (callback: (data: { id: string; chunk: string }) => void) => () => void
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
  /** GUI-subsystem executables (#379). See shared/gui-exe.ts. */
  exe: {
    probe: (req: { command: string; cwd?: string }) => Promise<import('../../shared/gui-exe').ExeProbeResult>
    runCaptured: (req: { command: string; cwd?: string }) => Promise<import('../../shared/gui-exe').CapturedRunStart>
    /** Stop capturing; the program keeps running. */
    releaseRun: (runId: string) => Promise<boolean>
    /** Force-stop the program. */
    cancelRun: (runId: string) => Promise<boolean>
    onRunData: (callback: (chunk: import('../../shared/gui-exe').CapturedRunChunk) => void) => () => void
    onRunExit: (callback: (exit: import('../../shared/gui-exe').CapturedRunExit) => void) => () => void
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
