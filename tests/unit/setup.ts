/**
 * Vitest setup — mocks for Electron and window.electronAPI
 */
import { vi } from 'vitest'
// Redirects the process temp dir to a disposable per-worker root and provides
// real writable mock paths (instead of the drive-relative '/mock/...'). Imported
// for its side effects too — must load before any test creates a temp fixture.
import { MOCK_RESOURCES, MOCK_USERDATA } from '../helpers/test-tmp'

// Mock electron module for main process tests
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => MOCK_USERDATA),
    getAppPath: vi.fn(() => process.cwd()),
    requestSingleInstanceLock: vi.fn(() => true),
    whenReady: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    quit: vi.fn(),
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
  },
  BrowserWindow: vi.fn().mockImplementation(() => ({
    webContents: {
      send: vi.fn(),
    },
    isDestroyed: vi.fn(() => false),
    on: vi.fn(),
    loadURL: vi.fn(),
    loadFile: vi.fn(),
    show: vi.fn(),
  })),
  dialog: { showOpenDialog: vi.fn() },
  clipboard: { readImage: vi.fn(), readText: vi.fn() },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
}))

// Mock the debug-logger to prevent file I/O
vi.mock('../../src/main/debug-logger', () => ({
  logInfo: vi.fn(),
  logWarn: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
  logTrace: vi.fn(),
  setVerboseMode: vi.fn(),
  isVerboseMode: vi.fn(() => false),
  setVerboseBaseline: vi.fn(),
  setTraceMode: vi.fn(),
  isTraceMode: vi.fn(() => false),
  installGlobalErrorHandlers: vi.fn(),
  closeDebugLogger: vi.fn(),
}))

// Mock setup-handlers to prevent registry access
vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: vi.fn(() => MOCK_RESOURCES),
  registerSetupHandlers: vi.fn(),
}))

// Mock window.electronAPI for renderer store tests
const mockElectronAPI = {
  registry: {
    get: vi.fn(() => Promise.resolve({ models: [], families: {}, effortLevels: [], dropdown: [] })),
    onUpdate: vi.fn(() => () => {}),
  },
  sentinel: {
    getState: vi.fn(() => Promise.resolve(null)),
    apply: vi.fn(() => Promise.resolve({ ok: true })),
    revert: vi.fn(() => Promise.resolve()),
    setStatus: vi.fn(() => Promise.resolve()),
    rerun: vi.fn(() => Promise.resolve()),
    onUpdate: vi.fn(() => () => {}),
  },
  config: {
    loadAll: vi.fn(() => Promise.resolve({ data: {}, needsMigration: false })),
    save: vi.fn(() => Promise.resolve(true)),
    migrateFromLocalStorage: vi.fn(() => Promise.resolve(true)),
  },
  cloudAgent: {
    dispatch: vi.fn((params: any) => Promise.resolve({
      id: 'ca-mock123',
      name: params.name,
      description: params.description,
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      projectPath: params.projectPath,
      configId: params.configId,
      output: '',
    })),
    cancel: vi.fn(() => Promise.resolve(true)),
    // #371: remove/clearCompleted report the real disk outcome now.
    remove: vi.fn(() => Promise.resolve({ ok: true, removed: true })),
    retry: vi.fn((id: string) => Promise.resolve({
      id: 'ca-retry123',
      name: 'Retried',
      description: 'desc',
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      projectPath: '/mock',
      output: '',
    })),
    list: vi.fn(() => Promise.resolve([])),
    getOutput: vi.fn(() => Promise.resolve('')),
    clearCompleted: vi.fn(() => Promise.resolve({ ok: true, removed: 0 })),
    onStatusChanged: vi.fn(() => () => {}),
    onOutputChunk: vi.fn(() => () => {}),
  },
  insights: {
    run: vi.fn(() => Promise.resolve('run-123')),
    getCatalogue: vi.fn(() => Promise.resolve({ runs: [] })),
    getReport: vi.fn(() => Promise.resolve(null)),
    getKpis: vi.fn(() => Promise.resolve(null)),
    getLatest: vi.fn(() => Promise.resolve(null)),
    isRunning: vi.fn(() => Promise.resolve(false)),
    onStatusChanged: vi.fn(() => () => {}),
  },
  codex: {
    status: vi.fn(() => Promise.resolve({
      installed: false,
      version: null,
      authMode: 'none' as const,
      hasOpenAiApiKeyEnv: false,
    })),
    login: vi.fn(() => Promise.resolve({ ok: true })),
    logout: vi.fn(() => Promise.resolve({ ok: true })),
    testConnection: vi.fn(() => Promise.resolve({ ok: true, message: 'connected' })),
  },
  dialog: { openFolder: vi.fn(() => Promise.resolve(null)) },
  vision: {
    start: vi.fn(() => Promise.resolve({ ok: true })),
    stop: vi.fn(() => Promise.resolve({ ok: true })),
    status: vi.fn(() => Promise.resolve({ running: false, connected: false, browser: '', mcpPort: 0 })),
    launch: vi.fn(() => Promise.resolve({ ok: true })),
    // #371: saveConfig takes the generation token getConfig handed out, and
    // getConfig reports whether the read FAILED rather than answering a bare null.
    saveConfig: vi.fn(() => Promise.resolve({ ok: true })),
    getConfig: vi.fn(() => Promise.resolve({ config: null, generation: 1, readFailed: false })),
    onStatusChanged: vi.fn(() => () => {}),
  },
  memory: {
    scan: vi.fn(() => Promise.resolve({
      projects: [],
      memories: [],
      warnings: [],
      totalSize: 0,
      scannedAt: Date.now(),
    })),
    read: vi.fn((path: string) => Promise.resolve('# Mock content')),
    delete: vi.fn(() => Promise.resolve()),
    writeFrontmatter: vi.fn(() => Promise.resolve()),
    recentSessions: vi.fn(() => Promise.resolve([])),
  },
  logs2: {
    listSlots: vi.fn(() => Promise.resolve([])),
    readMessages: vi.fn(() => Promise.resolve([])),
    turnSummary: vi.fn(() => Promise.resolve([])),
    search: vi.fn(() => Promise.resolve([])),
    deleteSlot: vi.fn(() => Promise.resolve({ deletedRuns: 0, deletedMessages: 0 })),
    clearAll: vi.fn(() => Promise.resolve({ deletedRuns: 0, deletedMessages: 0 })),
    ingestStatus: vi.fn(() => Promise.resolve(null)),
    sessionConfig: vi.fn(() => Promise.resolve(null)),
    onNewMessages: vi.fn(() => () => {}),
  },
  canvas: {
    getState: vi.fn(() => Promise.resolve(null)),
    render: vi.fn(() => Promise.resolve({ canvasId: 'c0ffee', versionId: 'v1' })),
    setActiveVersion: vi.fn(() => Promise.resolve(null)),
    onChanged: vi.fn(() => () => {}),
    onReviewChanged: vi.fn(() => () => {}),
    // The library listing: the cross-canvas totals store reads it on mount.
    listAll: vi.fn(() => Promise.resolve([])),
  },
  accountWeb: {
    status: vi.fn(() => Promise.resolve({ ok: false, error: 'not stubbed' })),
    webStatus: vi.fn(() => Promise.resolve({ ok: true, web: { status: 'none' } })),
    signIn: vi.fn(() => Promise.resolve({ ok: true, state: { phase: 'idle' } })),
    signInState: vi.fn(() => Promise.resolve({ ok: true, state: { phase: 'idle' } })),
    cancel: vi.fn(() => Promise.resolve({ ok: true })),
    signOut: vi.fn(() => Promise.resolve({ ok: true })),
    openArtifacts: vi.fn(() => Promise.resolve({ ok: true })),
    setAuthMethod: vi.fn(() => Promise.resolve({ ok: true })),
    setAuthBrowser: vi.fn(() => Promise.resolve({ ok: true })),
    setSignInMode: vi.fn(() => Promise.resolve({ ok: true })),
    paneOpen: vi.fn(() => Promise.resolve({ ok: true })),
    paneClose: vi.fn(() => Promise.resolve({ ok: true })),
    paneBounds: vi.fn(() => Promise.resolve({ ok: true })),
    paneVisible: vi.fn(() => Promise.resolve({ ok: true })),
    paneReload: vi.fn(() => Promise.resolve({ ok: true })),
    paneGetState: vi.fn(() => Promise.resolve({ ok: true, state: null })),
    onPaneState: vi.fn(() => () => {}),
    onPaneClosed: vi.fn(() => () => {}),
  },
  webview: {
    check: vi.fn(() => Promise.resolve({ reachable: false })),
    open: vi.fn(() => Promise.resolve(true)),
    close: vi.fn(() => Promise.resolve(true)),
    setBounds: vi.fn(() => Promise.resolve()),
    setVisible: vi.fn(() => Promise.resolve()),
    reload: vi.fn(() => Promise.resolve()),
    capture: vi.fn(() => Promise.resolve(null)),
    navBack: vi.fn(() => Promise.resolve()),
    navForward: vi.fn(() => Promise.resolve()),
    goHome: vi.fn(() => Promise.resolve()),
    navigate: vi.fn(() => Promise.resolve(true)),
    openExternal: vi.fn(() => Promise.resolve(true)),
    closeAll: vi.fn(() => Promise.resolve(true)),
    onEscapePressed: vi.fn(() => () => {}),
    onNavigated: vi.fn(() => () => {}),
  },
}

// Install on globalThis so store imports can find it. Augment an existing
// `window` (e.g. one provided by `@vitest-environment jsdom` in a per-file
// override) instead of replacing it — replacing it would clobber jsdom's
// document/DOM and break any test that depends on a real DOM (like the
// markdown sanitizer tests).
const existingWindow = (globalThis as unknown as { window?: Record<string, unknown> }).window
if (existingWindow) {
  existingWindow.electronAPI = mockElectronAPI
} else {
  ;(globalThis as any).window = {
    electronAPI: mockElectronAPI,
  }
}
