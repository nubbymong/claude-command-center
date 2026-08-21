/**
 * IPC Channel Constants — single source of truth for all Electron IPC channel names.
 * Import from here in both main process handlers and preload scripts.
 */

export const IPC = {
  // App info
  APP_IS_DEV: 'app:isDev',

  // Config management
  CONFIG_LOAD_ALL: 'config:loadAll',
  CONFIG_SAVE: 'config:save',
  CONFIG_MIGRATE: 'config:migrateFromLocalStorage',

  // Window management
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_FORCE_CLOSE: 'window:forceClose',
  WINDOW_ALLOW_CLOSE: 'window:allowClose',
  WINDOW_CANCEL_CLOSE: 'window:cancelClose',
  WINDOW_IS_MAXIMIZED: 'window:isMaximized',
  WINDOW_MAXIMIZED_CHANGED: 'window:maximized-changed',
  WINDOW_CLOSE_REQUESTED: 'window:closeRequested',

  // Dialog
  DIALOG_OPEN_FOLDER: 'dialog:openFolder',

  // Clipboard
  CLIPBOARD_SAVE_IMAGE: 'clipboard:saveImage',
  // Main-process clipboard text read (#145). Focus-independent, unlike the
  // renderer's navigator.clipboard.readText(), and retried for Windows
  // delayed-render. Used by the terminal paste keybinding.
  CLIPBOARD_READ_TEXT: 'clipboard:readText',
  // Input diagnostics (#145): identify what an external tool actually sends.
  // Enabled only when CCC_INPUT_DEBUG=1 is set for the main process.
  DEBUG_INPUT_ENABLED: 'debug:inputEnabled',
  DEBUG_LOG_INPUT: 'debug:logInput',

  // Credentials
  CREDENTIALS_SAVE: 'credentials:save',
  CREDENTIALS_LOAD: 'credentials:load',
  CREDENTIALS_DELETE: 'credentials:delete',

  // PTY
  PTY_SPAWN: 'pty:spawn',
  PTY_WRITE: 'pty:write',
  PTY_RESIZE: 'pty:resize',
  PTY_KILL: 'pty:kill',
  PTY_DATA: 'pty:data',   // Suffixed with :sessionId at runtime
  PTY_EXIT: 'pty:exit',   // Suffixed with :sessionId at runtime
  PTY_INTEGRITY_REPORT: 'pty:integrityReport',   // renderer -> main per-session byte/resize report

  // SSH connection-flow controller (manual mode user-gated stages).
  // Main->renderer notification is suffixed with :<sessionId> at runtime.
  SSH_FLOW_STATE: 'ssh:flowState',           // suffix :<sessionId>
  SSH_FLOW_GET_STATE: 'ssh:flow:getState',
  SSH_FLOW_RUN_POSTCOMMAND: 'ssh:flow:runPostCommand',
  SSH_FLOW_LAUNCH_CLAUDE: 'ssh:flow:launchClaude',
  SSH_FLOW_SKIP: 'ssh:flow:skip',
  // SSH tmux enhancement (items 8/9/10): push per-session persistence +
  // remote-account descriptors to the renderer. Suffix :<sessionId>.
  SSH_SESSION_INFO: 'ssh:sessionInfo',
  // item 4: renderer asks main to END the remote (tmux kill-session + sidecar
  // cleanup over a separate ssh exec) before/instead of a plain close.
  SSH_END_REMOTE: 'ssh:endRemote',

  // Statusline
  STATUSLINE_UPDATE: 'statusline:update',

  // Live reasoning effort pushed from the hooks gateway (main -> renderer).
  HOOKS_EFFORT_UPDATE: 'hooks:effortUpdate',

  // Model/effort registry (spec 2026-06-11): hydrate + hot-reload push (main -> renderer).
  REGISTRY_GET: 'registry:get',
  REGISTRY_UPDATE: 'registry:update',

  // Sentinel (spec 2026-06-11 §5/§6)
  SENTINEL_GET_STATE: 'sentinel:getState',
  SENTINEL_STATE_UPDATE: 'sentinel:stateUpdate',
  SENTINEL_APPLY: 'sentinel:apply',
  SENTINEL_REVERT: 'sentinel:revert',
  SENTINEL_SET_STATUS: 'sentinel:setStatus',
  SENTINEL_RERUN: 'sentinel:rerun',

  // Debug
  DEBUG_ON_DEBUG: 'claude:debug',
  DEBUG_ENABLE: 'debug:enable',
  DEBUG_DISABLE: 'debug:disable',
  DEBUG_IS_ENABLED: 'debug:isEnabled',
  DEBUG_OPEN_FOLDER: 'debug:openFolder',

  // Usage
  USAGE_SESSION: 'usage:session',
  USAGE_TOTAL: 'usage:total',
  USAGE_HISTORY: 'usage:history',

  // T8b (bug #5): the exact-conversation resume target for a session — {uuid,cwd}
  // read off the latest bound transcript, or null. Used at session-save time to
  // persist resumeUuid/resumeCwd onto SavedSession for app-relaunch. Handled by
  // resume-handlers.ts (routes through the transcript binder; no DB).
  LOGS_GET_RESUME_TARGET: 'logging:getResumeTarget',

  // Logs v2 — detection-driven warned wipe of the OLD log artifacts (first run).
  // DETECT reports the inventory (bytes + paths); CONFIRM performs the deletion
  // after the renderer's blocking modal proceeds.
  LOGS2_WIPE_DETECT: 'logs2:wipe:detect',
  LOGS2_WIPE_CONFIRM: 'logs2:wipe:confirm',

  // Logs v2 — the transcript-chat read surface. All request/response channels
  // route through getLogSupervisor().query(kind, args) (the forked transcripts
  // worker). Args are Zod-validated in logs2-handlers.ts before the supervisor is
  // ever called. LOGS2_NEW_MESSAGES is a PUSH (main -> renderer) forwarding the
  // worker's new-messages fan-out so the open chat view can live-tail.
  LOGS2_LIST_SLOTS: 'logs2:listSlots',
  LOGS2_READ_MESSAGES: 'logs2:readMessages',
  LOGS2_TURN_SUMMARY: 'logs2:turnSummary',
  LOGS2_SEARCH: 'logs2:search',
  LOGS2_DELETE_SLOT: 'logs2:deleteSlot',
  LOGS2_RENAME_SESSION: 'logs2:renameSession',
  LOGS2_CLEAR_ALL: 'logs2:clearAll',
  LOGS2_INGEST_STATUS: 'logs2:ingestStatus',
  LOGS2_NEW_MESSAGES: 'logs2:newMessages',   // push: main -> renderer
  LOGS2_SESSION_CONFIG: 'logs2:sessionConfig',

  // Discovery
  DISCOVERY_PROJECTS: 'discovery:projects',
  DISCOVERY_SESSIONS: 'discovery:sessions',

  // Updates
  UPDATE_CHECK: 'update:check',
  UPDATE_GET_VERSION: 'update:getVersion',
  UPDATE_INSTALL_RESTART: 'update:installAndRestart',
  UPDATE_HAS_SOURCE_PATH: 'update:hasSourcePath',
  UPDATE_GET_SOURCE_PATH: 'update:getSourcePath',
  UPDATE_SET_SOURCE_PATH: 'update:setSourcePath',
  UPDATE_SELECT_SOURCE_PATH: 'update:selectSourcePath',
  UPDATE_AVAILABLE: 'update:available',
  UPDATE_SOURCE_CONFIGURED: 'update:sourceConfigured',
  UPDATE_SERVER_CONNECTED: 'update:serverConnected',

  // Setup
  SETUP_IS_COMPLETE: 'setup:isComplete',
  SETUP_GET_DEFAULT_DATA_DIR: 'setup:getDefaultDataDir',
  SETUP_SELECT_DATA_DIR: 'setup:selectDataDir',
  SETUP_SET_DATA_DIR: 'setup:setDataDir',
  SETUP_GET_DATA_DIR: 'setup:getDataDir',
  SETUP_GET_RESOURCES_DIR: 'setup:getResourcesDir',
  SETUP_SELECT_RESOURCES_DIR: 'setup:selectResourcesDir',
  SETUP_SET_RESOURCES_DIR: 'setup:setResourcesDir',
  SETUP_IS_CLI_READY: 'setup:isCliReady',
  SETUP_SPAWN_CLI_SETUP: 'setup:spawnCliSetup',
  SETUP_KILL_CLI_SETUP: 'setup:killCliSetup',

  // Screenshots
  SCREENSHOT_CAPTURE_RECTANGLE: 'screenshot:captureRectangle',
  SCREENSHOT_CAPTURE_WINDOW: 'screenshot:captureWindow',
  SCREENSHOT_LIST_WINDOWS: 'screenshot:listWindows',
  SCREENSHOT_LIST_RECENT: 'screenshot:listRecent',
  SCREENSHOT_CLEANUP: 'screenshot:cleanup',
  SCREENSHOT_REGION_SELECTED: 'screenshot:regionSelected',
  SCREENSHOT_CANCELLED: 'screenshot:cancelled',

  // Session persistence
  SESSION_SAVE: 'session:save',
  SESSION_LOAD: 'session:load',
  SESSION_CLEAR: 'session:clear',
  SESSION_HAS_SAVED: 'session:hasSaved',
  SESSION_GRACEFUL_EXIT: 'session:gracefulExit',

  // Insights
  INSIGHTS_RUN: 'insights:run',
  INSIGHTS_RUN_ALL: 'insights:runAll',
  INSIGHTS_GET_CATALOGUE: 'insights:getCatalogue',
  INSIGHTS_GET_REPORT: 'insights:getReport',
  INSIGHTS_GET_KPIS: 'insights:getKpis',
  INSIGHTS_GET_LATEST: 'insights:getLatest',
  INSIGHTS_IS_RUNNING: 'insights:isRunning',
  INSIGHTS_STATUS_CHANGED: 'insights:statusChanged',

  // Notes
  NOTES_LIST: 'notes:list',
  NOTES_LOAD: 'notes:load',
  NOTES_SAVE: 'notes:save',
  NOTES_DELETE: 'notes:delete',
  NOTES_REORDER: 'notes:reorder',

  // Legacy versions
  LEGACY_FETCH_VERSIONS: 'legacyVersion:fetchVersions',
  LEGACY_IS_INSTALLED: 'legacyVersion:isInstalled',
  LEGACY_INSTALL: 'legacyVersion:install',
  LEGACY_REMOVE: 'legacyVersion:remove',
  LEGACY_LIST_INSTALLED: 'legacyVersion:listInstalled',
  LEGACY_INSTALL_PROGRESS: 'legacyVersion:installProgress',

  // Vision (global MCP server)
  VISION_START: 'vision:start',
  VISION_STOP: 'vision:stop',
  VISION_STATUS: 'vision:status',
  VISION_LAUNCH: 'vision:launch',
  VISION_SAVE_CONFIG: 'vision:saveConfig',
  VISION_GET_CONFIG: 'vision:getConfig',
  VISION_STATUS_CHANGED: 'vision:statusChanged',

  // Cloud agents
  CLOUD_AGENT_DISPATCH: 'cloudAgent:dispatch',
  CLOUD_AGENT_CANCEL: 'cloudAgent:cancel',
  CLOUD_AGENT_REMOVE: 'cloudAgent:remove',
  CLOUD_AGENT_RETRY: 'cloudAgent:retry',
  CLOUD_AGENT_LIST: 'cloudAgent:list',
  CLOUD_AGENT_GET_OUTPUT: 'cloudAgent:getOutput',
  CLOUD_AGENT_CLEAR_COMPLETED: 'cloudAgent:clearCompleted',
  CLOUD_AGENT_STATUS_CHANGED: 'cloudAgent:statusChanged',
  CLOUD_AGENT_OUTPUT_CHUNK: 'cloudAgent:outputChunk',

  // Agent Teams
  TEAM_LIST: 'team:list',
  TEAM_SAVE: 'team:save',
  TEAM_DELETE: 'team:delete',
  TEAM_RUN: 'team:run',
  TEAM_CANCEL_RUN: 'team:cancelRun',
  TEAM_LIST_RUNS: 'team:listRuns',
  TEAM_RUN_STATUS_CHANGED: 'team:runStatusChanged',

  // Service status
  SERVICE_STATUS: 'serviceStatus:update',
  SERVICE_STATUS_GET: 'serviceStatus:get',
  SERVICE_HEALTH_GET: 'serviceHealth:get',
  SERVICE_HEALTH_UPDATE: 'serviceHealth:update',
  SERVICE_RESTART: 'serviceHealth:restart',

  // CLI
  CLI_CHECK: 'cli:check',
  CLI_PATH: 'cli:path',
  CLI_VERSION: 'cli:version',

  // Ask Command Center help workspace
  HELP_WORKSPACE: 'help:workspace',

  // Tokenomics v2 — SQLite-backed summary/sessions/detail + index push
  TOKENOMICS2_SUMMARY: 'tokenomics2:summary',
  TOKENOMICS2_SESSIONS: 'tokenomics2:sessions',
  TOKENOMICS2_SESSION_DETAIL: 'tokenomics2:sessionDetail',
  TOKENOMICS2_INDEX_STATUS: 'tokenomics2:indexStatus',
  TOKENOMICS2_INDEX_PROGRESS: 'tokenomics2:indexProgress',
  TOKENOMICS2_INDEX_COMPLETE: 'tokenomics2:indexComplete',

  // Codex (OpenAI)
  CODEX_STATUS: 'codex:status',
  CODEX_LOGIN: 'codex:login',
  CODEX_LOGOUT: 'codex:logout',
  CODEX_TEST_CONNECTION: 'codex:testConnection',

  // Memory
  MEMORY_SCAN: 'memory:scan',
  MEMORY_RECENT_SESSIONS: 'memory:recentSessions',
  MEMORY_READ: 'memory:read',
  MEMORY_DELETE: 'memory:delete',
  MEMORY_WRITE_FRONTMATTER: 'memory:writeFrontmatter',

  // GitHub sidebar
  GITHUB_CONFIG_GET: 'github:config:get',
  GITHUB_CONFIG_UPDATE: 'github:config:update',
  GITHUB_PROFILE_ADD_PAT: 'github:profile:addPat',
  GITHUB_PROFILE_ADOPT_GHCLI: 'github:profile:adoptGhCli',
  GITHUB_PROFILE_REMOVE: 'github:profile:remove',
  GITHUB_PROFILE_RENAME: 'github:profile:rename',
  GITHUB_PROFILE_UPDATE: 'github:profile:update',
  GITHUB_PROFILE_TEST: 'github:profile:test',
  GITHUB_OAUTH_START: 'github:oauth:start',
  GITHUB_OAUTH_POLL: 'github:oauth:poll',
  GITHUB_OAUTH_CANCEL: 'github:oauth:cancel',
  GITHUB_REAUTH_PROFILE: 'github:reauth:profile',
  GITHUB_GHCLI_DETECT: 'github:ghcli:detect',
  GITHUB_REPO_DETECT: 'github:repo:detect',
  GITHUB_SESSION_CONFIG_UPDATE: 'github:session:updateConfig',
  GITHUB_SESSION_CONTEXT_GET: 'github:session:context:get',
  GITHUB_LOCALGIT_GET: 'github:localgit:get',
  GITHUB_SYNC_NOW: 'github:sync:now',
  GITHUB_SYNC_FOCUSED_NOW: 'github:sync:focused:now',
  GITHUB_FOCUS_CHANGED: 'github:focus:changed',
  GITHUB_SYNC_PAUSE: 'github:sync:pause',
  GITHUB_SYNC_RESUME: 'github:sync:resume',
  GITHUB_DATA_GET: 'github:data:get',
  GITHUB_DATA_UPDATE: 'github:data:update',
  GITHUB_SYNC_STATE_UPDATE: 'github:sync:stateUpdate',
  GITHUB_ACTIONS_RERUN: 'github:actions:rerun',
  GITHUB_PR_MERGE: 'github:pr:merge',
  GITHUB_PR_READY: 'github:pr:ready',
  GITHUB_REVIEW_REPLY: 'github:review:reply',
  GITHUB_NOTIF_MARK_READ: 'github:notif:markRead',
  GITHUB_NOTIFICATIONS_UPDATE: 'github:notifications:update',
  // AI-credits (Copilot) usage meter
  GITHUB_AI_USAGE_GET: 'github:aiUsage:get',
  GITHUB_AI_USAGE_UPDATE: 'github:aiUsage:update',

  // Webview pane (per-session WebContentsView)
  WEBVIEW_CHECK: 'webview:check',                 // HEAD probe (CORS-bypass)
  WEBVIEW_OPEN: 'webview:open',                   // create+attach view at bounds
  WEBVIEW_CLOSE: 'webview:close',                 // detach+destroy view
  WEBVIEW_SET_BOUNDS: 'webview:setBounds',        // re-position on resize/scroll
  WEBVIEW_SET_VISIBLE: 'webview:setVisible',      // attach/detach without destroying
  WEBVIEW_RELOAD: 'webview:reload',               // force-reload bypassing cache
  WEBVIEW_CAPTURE: 'webview:capture',             // capturePage() PNG dataURL for freeze
  WEBVIEW_NAV_BACK: 'webview:navBack',
  WEBVIEW_NAV_FORWARD: 'webview:navForward',
  WEBVIEW_GO_HOME: 'webview:goHome',              // re-load original URL
  WEBVIEW_CLOSE_ALL: 'webview:closeAll',          // emergency: destroy every view (escape hatch)
  WEBVIEW_ESCAPE_PRESSED: 'webview:escapePressed', // main → renderer: user pressed Esc inside a WebContentsView

  // Per-account claude.ai web session (#216): sign in via the system browser,
  // hold the cookies in a per-account partition, open artifacts as that account.
  ACCOUNT_WEB_STATUS: 'accountWeb:status',
  /** Web-session status ONLY. A local JSON read, so it answers in microseconds —
   *  unlike ACCOUNT_WEB_STATUS, which awaits the `claude auth status` subprocess
   *  before it can report anything at all. */
  ACCOUNT_WEB_WEB_STATUS: 'accountWeb:webStatus',
  ACCOUNT_WEB_SIGN_IN: 'accountWeb:signIn',
  ACCOUNT_WEB_SIGN_IN_STATE: 'accountWeb:signInState',
  ACCOUNT_WEB_CANCEL: 'accountWeb:cancel',
  ACCOUNT_WEB_SIGN_OUT: 'accountWeb:signOut',
  ACCOUNT_WEB_OPEN_ARTIFACTS: 'accountWeb:openArtifacts',
  ACCOUNT_WEB_SET_AUTH_METHOD: 'accountWeb:setAuthMethod',
  ACCOUNT_WEB_SET_AUTH_BROWSER: 'accountWeb:setAuthBrowser',

  // Hooks gateway
  HOOKS_TOGGLE: 'hooks:toggle',
  HOOKS_GET_BUFFER: 'hooks:getBuffer',
  HOOKS_GET_STATUS: 'hooks:getStatus',
  HOOKS_EVENT: 'hooks:event',
  HOOKS_SESSION_ENDED: 'hooks:sessionEnded',
  HOOKS_DROPPED: 'hooks:dropped',
  HOOKS_STATUS: 'hooks:status',

  // Codex review MCP (P6)
  CODEX_REVIEW_USAGE_GET: 'codex-review:usage:get',
  CODEX_REVIEW_USAGE_UPDATED: 'codex-review:usage:updated',

  // Conductor Channels (v1.5.10)
  CHANNELS_SEND: 'channels:send',                                   // renderer -> main: dispatch a payload
  CHANNELS_RETRACT: 'channels:retract',                             // renderer -> main: send retraction follow-up
  CHANNELS_FORCE_TIER: 'channels:forceTier',                        // renderer -> main: per-session tier override
  CHANNELS_LEDGER_EVENT: 'channels:ledgerEvent',                    // main -> renderer: live ledger row
  CHANNELS_RULE_CRUD: 'channels:ruleCRUD',                          // renderer -> main: payload { op: 'list'|'save'|'delete', ... }
  CHANNELS_STANDING_APPROVAL_CRUD: 'channels:standingApprovalCRUD', // renderer -> main: payload { op: 'list'|'add'|'remove', ... }
  CHANNELS_RENDERER_READY: 'channels:rendererReady',   // renderer -> main: listeners mounted, safe to gate permissions
  CHANNELS_ATTENTION: 'channels:attention',            // main -> renderer: { sessionId, needsAttention }
  CHANNELS_CAPABILITY_DIAGNOSTICS: 'channels:capabilityDiagnostics',// renderer -> main: capability + handshake history
  CHANNELS_INTRO_DISMISSED: 'channels:introDismissed',              // renderer -> main: persist first-run dismissal
  CHANNELS_KILL_SWITCH: 'channels:killSwitch',                      // renderer -> main: toggle disableConductorChannels

  // Account profiles (per-process CLAUDE_CONFIG_DIR multi-account)
  ACCOUNT_PROFILES_LIST: 'accountProfiles:list',
  ACCOUNT_PROFILES_CREATE: 'accountProfiles:create',
  ACCOUNT_PROFILES_RENAME: 'accountProfiles:rename',
  ACCOUNT_PROFILES_SET_ACTIVE: 'accountProfiles:setActive',
  ACCOUNT_PROFILES_DELETE: 'accountProfiles:delete',
  ACCOUNT_PROFILES_REFRESH_IDENTITY: 'accountProfiles:refreshIdentity',
  ACCOUNT_PROFILES_AUTH_INFO: 'accountProfiles:authInfo',
  ACCOUNT_PROFILES_CAPTURE_DETECTED: 'accountProfiles:captureDetected',
  ACCOUNT_GLOBAL_EMAIL_GET: 'accountProfiles:globalEmail',

  // All-accounts usage overview (fetch each profile's usage without a session)
  ACCOUNT_USAGE_FETCH_ALL: 'accountUsage:fetchAll',
  ACCOUNT_USAGE_FETCH_ONE: 'accountUsage:fetchOne',

  // Reliable per-session account identity (main -> renderer push at spawn; renderer pull on mount)
  ACCOUNT_IDENTITY_UPDATE: 'identity:accountUpdate',
  ACCOUNT_IDENTITY_GET: 'identity:accountGet',
  ACCOUNT_NEW_DETECTED: 'account:new-detected',

  // Agent Canvas (2.2) — per-session review surface served over ccc-ux://
  CANVAS_GET_STATE: 'canvas:getState',                 // renderer -> main: { sessionId } -> CanvasState | null
  CANVAS_RENDER: 'canvas:render',                      // renderer -> main: register a new content version
  CANVAS_SET_ACTIVE_VERSION: 'canvas:setActiveVersion',// renderer -> main: switch the surfaced version
  CANVAS_CHANGED: 'canvas:changed',                    // push: main -> renderer (a render/switch happened)
  CANVAS_SNAPSHOT_REQUEST: 'canvas:snapshotRequest',   // push: main -> renderer: capture the live frame (id-correlated)
  CANVAS_SNAPSHOT_RESULT: 'canvas:snapshotResult',     // renderer -> main: the reply to one snapshotRequest
  CANVAS_LIST_RECLAIMABLE: 'canvas:listReclaimable',   // renderer -> main: { sessionId, openTileSessionIds? } -> ReclaimableCanvas[] (read-only)
  CANVAS_RECLAIM: 'canvas:reclaim',                    // renderer -> main: the USER moves a named canvas to this session
  CANVAS_LIST_ALL: 'canvas:listAll',                   // renderer -> main: { openTileSessionIds?, sessionId? } -> CanvasLibraryEntry[] (the library, scoped to that session's project; read-only)
  CANVAS_DELETE: 'canvas:delete',                      // renderer -> main: the USER deletes a canvas and its files

  // Agent Canvas P3 — reviews & annotations (the review loop, spec §6)
  CANVAS_REVIEW_GET_STATE: 'canvas:reviewGetState',    // renderer -> main: { sessionId } -> CanvasReviewState | null
  CANVAS_ANNOTATION_UPSERT: 'canvas:annotationUpsert', // renderer -> main: create/update a draft note
  CANVAS_ANNOTATION_DELETE: 'canvas:annotationDelete', // renderer -> main: remove a draft note
  CANVAS_REVIEW_SUBMIT: 'canvas:reviewSubmit',         // renderer -> main: freeze the draft (+ sketch PNG exports)
  CANVAS_ANNOTATION_RESOLVE: 'canvas:annotationResolve', // renderer -> main: approve / dismiss / reannotate an open note
  CANVAS_REVIEW_CHANGED: 'canvas:reviewChanged',       // push: main -> renderer (a review/annotation mutation happened)
} as const

/** Helper to build per-session PTY data channels */
export function ptyDataChannel(sessionId: string): string {
  return `${IPC.PTY_DATA}:${sessionId}`
}

/** Helper to build per-session PTY exit channels */
export function ptyExitChannel(sessionId: string): string {
  return `${IPC.PTY_EXIT}:${sessionId}`
}
