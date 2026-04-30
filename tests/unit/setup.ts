/**
 * Vitest setup — mocks for Electron and window.electronAPI
 */
import { vi } from 'vitest'

// Mock electron module for main process tests
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/userData'),
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
  clipboard: { readImage: vi.fn() },
  safeStorage: { isEncryptionAvailable: vi.fn(() => false) },
  Menu: { buildFromTemplate: vi.fn(), setApplicationMenu: vi.fn() },
}))

// Mock the debug-logger to prevent file I/O
vi.mock('../../src/main/debug-logger', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
  logDebug: vi.fn(),
  installGlobalErrorHandlers: vi.fn(),
  closeDebugLogger: vi.fn(),
}))

// Mock setup-handlers to prevent registry access
vi.mock('../../src/main/ipc/setup-handlers', () => ({
  getResourcesDirectory: vi.fn(() => '/mock/resources'),
  registerSetupHandlers: vi.fn(),
}))

// Mock window.electronAPI for renderer store tests
const mockElectronAPI = {
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
    remove: vi.fn(() => Promise.resolve(true)),
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
    clearCompleted: vi.fn(() => Promise.resolve(0)),
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
    seed: vi.fn(() => Promise.resolve(null)),
    onStatusChanged: vi.fn(() => () => {}),
  },
  team: {
    list: vi.fn(() => Promise.resolve([])),
    save: vi.fn((team: any) => Promise.resolve({ ...team, id: team.id || 'team-mock123', updatedAt: Date.now() })),
    delete: vi.fn(() => Promise.resolve(true)),
    run: vi.fn((teamId: string) => Promise.resolve({
      id: 'tr-mock123',
      teamId,
      teamName: 'Mock Team',
      status: 'running',
      steps: [],
      projectPath: '/mock',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })),
    cancelRun: vi.fn(() => Promise.resolve(true)),
    listRuns: vi.fn(() => Promise.resolve([])),
    onRunStatusChanged: vi.fn(() => () => {}),
  },
  dialog: { openFolder: vi.fn(() => Promise.resolve(null)) },
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
    closeAll: vi.fn(() => Promise.resolve(true)),
    onEscapePressed: vi.fn(() => () => {}),
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
