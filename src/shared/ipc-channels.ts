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
  // SSH Persistent (resume liveness): renderer asks main whether a set of
  // detached `ccc-<sessionId>` tmux sessions are still ALIVE on a config's host,
  // via a `tmux ls` over a separate ssh exec. Returns DetachedRemoteLiveness.
  SSH_CHECK_DETACHED_LIVE: 'ssh:checkDetachedLive',
  // SSH Persistent (resume liveness, TIER 1): is a HOST answering at all? One
  // ICMP echo with a TCP:22 fallback — no ssh, no auth, no credentials. Cheap
  // enough to run on a slow timer, and DEMOTE-ONLY: a reachable host never
  // promotes anything to live (only SSH_CHECK_DETACHED_LIVE can do that).
  SSH_PING_HOST: 'ssh:pingHost',

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
  SETUP_PROBE_CLI: 'setup:probeCli',
  SETUP_SPAWN_CLI_SETUP: 'setup:spawnCliSetup',
  SETUP_KILL_CLI_SETUP: 'setup:killCliSetup',

  // #374: write a glyph-corruption diagnostic (atlas event log + a window
  // screenshot) so a user who sees the fault can capture and share it.
  DIAGNOSTICS_CAPTURE_GLYPH: 'diagnostics:captureGlyph',

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
  WEBVIEW_FORGET: 'webview:forget',               // destroy view AND wipe its persist:webview-<id> profile (session closed for good)
  WEBVIEW_SET_BOUNDS: 'webview:setBounds',        // re-position on resize/scroll
  WEBVIEW_SET_VISIBLE: 'webview:setVisible',      // attach/detach without destroying
  WEBVIEW_RELOAD: 'webview:reload',               // force-reload bypassing cache
  WEBVIEW_CAPTURE: 'webview:capture',             // capturePage() PNG dataURL for freeze
  WEBVIEW_NAV_BACK: 'webview:navBack',
  WEBVIEW_NAV_FORWARD: 'webview:navForward',
  WEBVIEW_GO_HOME: 'webview:goHome',              // re-load original URL
  WEBVIEW_CLOSE_ALL: 'webview:closeAll',          // emergency: destroy every view (escape hatch)
  WEBVIEW_ESCAPE_PRESSED: 'webview:escapePressed', // main → renderer: user pressed Esc inside a WebContentsView
  WEBVIEW_NAVIGATE: 'webview:navigate',           // load a (validated http/https) URL in an EXISTING view -- the address bar
  WEBVIEW_OPEN_EXTERNAL: 'webview:openExternal',  // hand a (validated http/https) URL to the OS browser
  WEBVIEW_NAVIGATED: 'webview:navigated',         // main → renderer: { sessionId, url, title, canGoBack, canGoForward, loading }
  WEBVIEW_AGENT_PUSH: 'webview:agentPush',        // main → renderer: { sessionId, url } — the agent pushed a page to the USER's in-app browser (raises the Browser-tool pill; never navigates the active view)

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
  ACCOUNT_WEB_SET_SIGN_IN_MODE: 'accountWeb:setSignInMode',
  // The pane's ACCOUNT surface (#439/#475): a claude.ai-only view on the
  // account's partition, hosted in the browser pane rectangle. Nav state
  // rides WEBVIEW_NAVIGATED; auth/email state rides PANE_STATE.
  ACCOUNT_WEB_PANE_OPEN: 'accountWeb:paneOpen',
  ACCOUNT_WEB_PANE_CLOSE: 'accountWeb:paneClose',
  ACCOUNT_WEB_PANE_BOUNDS: 'accountWeb:paneBounds',
  ACCOUNT_WEB_PANE_VISIBLE: 'accountWeb:paneVisible',
  ACCOUNT_WEB_PANE_RELOAD: 'accountWeb:paneReload',
  ACCOUNT_WEB_PANE_GET_STATE: 'accountWeb:paneGetState',
  ACCOUNT_WEB_PANE_STATE: 'accountWeb:paneState', // main → renderer: AccountPaneState
  ACCOUNT_WEB_PANE_CLOSED: 'accountWeb:paneClosed', // main → renderer: main force-closed the surface (sign-out/delete/crash)

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

  // GUI-subsystem executables (#379). A command button types into a live pty,
  // whose shell HAS a console, so a Subsystem=2 tool attaches to it and paints
  // its log over the pane. PROBE reads the target's PE header to say so; RUN
  // re-parents the tool onto the console-less main process, where its output
  // can actually be captured. See shared/gui-exe.ts.
  EXE_PROBE: 'exe:probe',                                           // renderer -> main: { command, cwd? } -> ExeProbeResult
  EXE_RUN_START: 'exe:run:start',                                   // renderer -> main: { command, cwd? } -> CapturedRunStart
  EXE_RUN_RELEASE: 'exe:run:release',                               // renderer -> main: { runId } -> boolean; stop capturing, LEAVE it running
  EXE_RUN_CANCEL: 'exe:run:cancel',                                 // renderer -> main: { runId } -> boolean; KILLS the program
  EXE_RUN_DATA: 'exe:run:data',                                     // push: main -> renderer (the requesting WebContents only), CapturedRunChunk
  EXE_RUN_EXIT: 'exe:run:exit',                                     // push: main -> renderer, CapturedRunExit

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
  /** Read-only credential GENERATION for a profile (file stamp + signed-in), no token contents:
   *  the re-auth poll completes on a credential change, not on the pre-existing email (rc.14 review F7). */
  ACCOUNT_PROFILES_CREDENTIAL_STAMP: 'accountProfiles:credentialStamp',
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
  CANVAS_RECLAIM: 'canvas:reclaim',                    // renderer -> main: OPEN HERE — point this session at a canvas IT ALREADY OWNS. Transfers nothing; a foreign canvas is refused (M4: the transfer path is canvas:resume)
  CANVAS_LIST_ALL: 'canvas:listAll',                   // renderer -> main: { openTileSessionIds?, sessionId? } -> CanvasLibraryEntry[] (the totals sweep, scoped to that session's project; read-only, and subject to the SAME privacy rule as libraryList)
  CANVAS_DELETE: 'canvas:delete',                      // renderer -> main: the USER deletes a canvas and its files (refused when a LIVE other session owns it; a completed canvas is its owner's alone)
  CANVAS_ARCHIVE_ARTIFACT: 'canvas:archiveArtifact',   // renderer -> main: { sessionId, canvasId, versionId, archived } -> tuck an artifact into (or out of) the Archived history group (reversible; owner-scoped)
  CANVAS_DELETE_ARTIFACT: 'canvas:deleteArtifact',     // renderer -> main: { sessionId, canvasId, versionId } -> permanently delete an artifact, its versions and their review notes (owner-scoped)

  // Agent Canvas M4 — the ownership lease: the project Library, resume/dismiss
  // of ownerless in-flight work, and the read-only view of somebody else's
  // memorialised canvas. The PRIVACY RULE — an in-flight canvas whose owner is
  // LIVE and is not the caller is invisible — is enforced in MAIN, on both
  // listing channels, never left to the renderer.
  CANVAS_LIBRARY_LIST: 'canvas:libraryList',           // renderer -> main: { sessionId, openTileSessionIds, query?, tab?, filter?, sort? } -> { rows: CanvasLibraryRow[]; truncated }
  CANVAS_LIST_RESUMABLES: 'canvas:listResumables',     // renderer -> main: { sessionId, openTileSessionIds } -> ResumableRow[] (ownerless in-flight, same project; independent of what the caller already owns)
  CANVAS_RESUME: 'canvas:resume',                      // renderer -> main: { sessionId, canvasId, expectedOwnerSessionId, openTileSessionIds } -> compare-and-set adoption; first wins, everyone else gets 'changed'
  CANVAS_DISMISS: 'canvas:dismiss',                    // renderer -> main: { sessionId, canvasId, openTileSessionIds } -> DISCARD an ownerless (or own) in-flight canvas and its evidence
  CANVAS_GET_READONLY: 'canvas:getReadonly',           // renderer -> main: { sessionId, canvasId } -> CanvasState | null; COMPLETED canvases only for a non-owner, same project

  // Agent Canvas P3 — reviews & annotations (the review loop, spec §6)
  CANVAS_REVIEW_GET_STATE: 'canvas:reviewGetState',    // renderer -> main: { sessionId } -> CanvasReviewState | null
  CANVAS_ANNOTATION_UPSERT: 'canvas:annotationUpsert', // renderer -> main: create/update a draft note
  CANVAS_ANNOTATION_DELETE: 'canvas:annotationDelete', // renderer -> main: remove a draft note
  CANVAS_REVIEW_SUBMIT: 'canvas:reviewSubmit',         // renderer -> main: freeze the draft (+ sketch PNG exports); carries the decision (approve/reject) — required
  CANVAS_VERSION_VERDICT: 'canvas:versionVerdict',     // renderer -> main: zero-note verdict on a version { sessionId, versionId?, state, note? }; approve/reject also settles that artefact's earlier rounds, approve auto-completes
  CANVAS_AGENT_MARKER: 'canvas:agentMarker',           // renderer -> main (#580): { sessionId, canvasId, line } -> the one chat line that TELLS the agent a verdict/review was filed; owner-only against the named canvas, control-stripped, queued while the agent's turn is open and flushed at the boundary, never written blind into a streaming TUI
  CANVAS_VERSION_REOPEN: 'canvas:versionReopen',       // renderer -> main: C1 reopen a version for review (later ready versions -> withdrawn); wakes no round
  CANVAS_ANNOTATION_REOPEN: 'canvas:annotationReopen', // renderer -> main: the USER puts a closed note back in play
  CANVAS_REVIEW_REOPEN: 'canvas:reviewReopen',         // renderer -> main: { sessionId, canvasId, reviewId } -> the USER puts a whole settled ROUND back in play (the only other revival there is)
  CANVAS_REVIEW_MARK_SEEN: 'canvas:reviewMarkSeen',    // renderer -> main: the USER has these addressed notes on screen (releases the agent close-out barrier; no MCP path here, ever)
  CANVAS_COMPOSER_DRAFT_SET: 'canvas:composerDraftSet',     // renderer -> main: { sessionId, canvasId, draft } -> persist the half-written note (W14: text, decision, target, images, sketch scene)
  CANVAS_COMPOSER_DRAFT_CLEAR: 'canvas:composerDraftClear', // renderer -> main: { sessionId, canvasId } -> drop it (submitted, or the user cleared the composer)
  CANVAS_COMPLETE: 'canvas:complete',                  // renderer -> main: { sessionId, canvasId } -> the USER signs the subject off (#476; refused while anything is owed, or not owned by that session)
  CANVAS_COMPLETE_FORCE: 'canvas:completeForce',       // renderer -> main: { sessionId, canvasId } -> the USER force-closes what is owed and signs off (W3; USER-only — canvas_complete keeps every refusal)
  CANVAS_DESCRIBE_FORCE_CLOSURES: 'canvas:describeForceClosures', // renderer -> main: { sessionId, canvasId } -> what a force would close, so the armed confirm can name it
  CANVAS_COMPLETE_REOPEN: 'canvas:completeReopen',     // renderer -> main: { sessionId, canvasId } -> clear a canvas's completed stamp (one-click Reopen; owner-only)
  CANVAS_REVIEW_CHANGED: 'canvas:reviewChanged',       // push: main -> renderer (a review/annotation mutation happened)

  // Agent Canvas M3 — Testing mode evidence (a note is a locked evidence record)
  CANVAS_EVIDENCE_CAPTURE: 'canvas:evidenceCapture',   // renderer -> main: { sessionId, canvasId, versionId, rect, dpr, stamp, trail } -> screenshot the framed page (owner + uat only; rect clamped in main) -> { ok, evidenceId, previewDataUrl, width, height } | { ok:false, reason }
  CANVAS_EVIDENCE_DISCARD: 'canvas:evidenceDiscard',   // renderer -> main: { sessionId, canvasId, evidenceId } -> the user cancelled the note; delete the pending shot
  CANVAS_EVIDENCE_READ: 'canvas:evidenceRead',         // renderer -> main: { sessionId, canvasId, path } -> { dataUrl } | null; the path must be one RECORDED on that canvas (owner, or same project)
  CANVAS_SET_PACK_NAME: 'canvas:setPackName',          // renderer -> main: { sessionId, canvasId, versionId, name } -> rename the test pack inline (null clears; owner-only)
  CANVAS_FRAME_NAVIGATED: 'canvas:frameNavigated',     // push: main -> renderer { sessionId, canvasId, route } -> a full-document navigation inside the canvas frame, for the action trail

  // Session Watchdog (#235): auto-retry on rate-limit/overload/safeguard.
  // Default off. Push on every state change (main -> renderer); invoke to
  // hydrate a freshly-mounted renderer with whatever is currently running.
  WATCHDOG_STATE: 'watchdog:state',
  WATCHDOG_GET_STATES: 'watchdog:getStates',
} as const

/** Helper to build per-session PTY data channels */
export function ptyDataChannel(sessionId: string): string {
  return `${IPC.PTY_DATA}:${sessionId}`
}

/** Helper to build per-session PTY exit channels */
export function ptyExitChannel(sessionId: string): string {
  return `${IPC.PTY_EXIT}:${sessionId}`
}
