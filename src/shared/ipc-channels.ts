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

  // Storyboard
  STORYBOARD_START: 'storyboard:start',
  STORYBOARD_CAPTURE_FRAME: 'storyboard:captureFrame',
  STORYBOARD_STOP: 'storyboard:stop',
  STORYBOARD_IS_ACTIVE: 'storyboard:isActive',

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
} as const

/** Helper to build per-session PTY data channels */
export function ptyDataChannel(sessionId: string): string {
  return `${IPC.PTY_DATA}:${sessionId}`
}

/** Helper to build per-session PTY exit channels */
export function ptyExitChannel(sessionId: string): string {
  return `${IPC.PTY_EXIT}:${sessionId}`
}
