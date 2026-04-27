/**
 * IPC Channel Constants — single source of truth for all Electron IPC channel names.
 * Import from here in both main process handlers and preload scripts.
 */

export const IPC = {
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
  CLIPBOARD_READ_IMAGE: 'clipboard:readImage',
  CLIPBOARD_SAVE_IMAGE: 'clipboard:saveImage',

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

  // SSH connection-flow controller (manual mode user-gated stages).
  // Main->renderer notification is suffixed with :<sessionId> at runtime.
  SSH_FLOW_STATE: 'ssh:flowState',           // suffix :<sessionId>
  SSH_FLOW_GET_STATE: 'ssh:flow:getState',
  SSH_FLOW_RUN_POSTCOMMAND: 'ssh:flow:runPostCommand',
  SSH_FLOW_LAUNCH_CLAUDE: 'ssh:flow:launchClaude',
  SSH_FLOW_SKIP: 'ssh:flow:skip',

  // Statusline
  STATUSLINE_UPDATE: 'statusline:update',

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

  // Logs
  LOGS_LIST: 'logs:list',
  LOGS_READ: 'logs:read',
  LOGS_SEARCH: 'logs:search',
  LOGS_CLEANUP: 'logs:cleanup',

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
  INSIGHTS_GET_CATALOGUE: 'insights:getCatalogue',
  INSIGHTS_GET_REPORT: 'insights:getReport',
  INSIGHTS_GET_KPIS: 'insights:getKpis',
  INSIGHTS_GET_LATEST: 'insights:getLatest',
  INSIGHTS_IS_RUNNING: 'insights:isRunning',
  INSIGHTS_SEED: 'insights:seed',
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

  // CLI
  CLI_CHECK: 'cli:check',

  // Tokenomics
  TOKENOMICS_GET_DATA: 'tokenomics:getData',
  TOKENOMICS_SEED: 'tokenomics:seed',
  TOKENOMICS_SYNC: 'tokenomics:sync',
  TOKENOMICS_PROGRESS: 'tokenomics:progress',

  // Account switching
  ACCOUNT_LIST: 'account:list',
  ACCOUNT_SWITCH: 'account:switch',
  ACCOUNT_GET_ACTIVE: 'account:getActive',
  ACCOUNT_SAVE_CURRENT_AS: 'account:saveCurrentAs',
  ACCOUNT_RENAME: 'account:rename',

  // Memory
  MEMORY_SCAN: 'memory:scan',
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
  GITHUB_PROFILE_TEST: 'github:profile:test',
  GITHUB_OAUTH_START: 'github:oauth:start',
  GITHUB_OAUTH_POLL: 'github:oauth:poll',
  GITHUB_OAUTH_CANCEL: 'github:oauth:cancel',
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

  // Hooks gateway
  HOOKS_TOGGLE: 'hooks:toggle',
  HOOKS_GET_BUFFER: 'hooks:getBuffer',
  HOOKS_GET_STATUS: 'hooks:getStatus',
  HOOKS_EVENT: 'hooks:event',
  HOOKS_SESSION_ENDED: 'hooks:sessionEnded',
  HOOKS_DROPPED: 'hooks:dropped',
  HOOKS_STATUS: 'hooks:status',
} as const

/** Helper to build per-session PTY data channels */
export function ptyDataChannel(sessionId: string): string {
  return `${IPC.PTY_DATA}:${sessionId}`
}

/** Helper to build per-session PTY exit channels */
export function ptyExitChannel(sessionId: string): string {
  return `${IPC.PTY_EXIT}:${sessionId}`
}
