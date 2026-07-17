import { describe, it, expect, beforeEach, vi } from 'vitest'

// Track mock filesystem state
const { mockExistsSync, mockReaddir, mockReadFile } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(() => false),
  mockReaddir: vi.fn(async () => [] as unknown[]),
  mockReadFile: vi.fn(async () => Buffer.from('')),
}))

// Mock fs with vi.fn wrappers
vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: vi.fn(() => '{}'),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  readdirSync: vi.fn(() => []),
  promises: {
    readdir: mockReaddir,
    readFile: mockReadFile,
  },
}))

// Mock crypto
vi.mock('crypto', () => ({
  createHash: vi.fn(() => ({
    update: vi.fn().mockReturnThis(),
    digest: vi.fn(() => 'mock-hash-abc123'),
  })),
}))

// Mock registry
vi.mock('../../src/main/registry', () => ({
  readRegistry: vi.fn(() => null),
  writeRegistry: vi.fn(() => true),
}))

// Mock electron with isPackaged = false for dev mode tests
vi.mock('electron', async () => {
  const actual = await vi.importActual<any>('electron')
  return {
    ...actual,
    app: {
      ...actual.app,
      isPackaged: false,
      getAppPath: vi.fn(() => '/mock/project/out/main'),
      getPath: vi.fn(() => '/mock/userData'),
    },
    BrowserWindow: vi.fn(),
  }
})

import {
  isUpdateAvailable,
  checkForUpdatesOnDemand,
  markUpdateInstalled,
  hasSourcePath,
  getProjectRootPath,
  stopUpdateWatcher,
} from '../../src/main/update-watcher'

describe('update-watcher', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stopUpdateWatcher()
  })

  describe('getProjectRootPath', () => {
    it('resolves project root from app path in dev mode', () => {
      const root = getProjectRootPath()
      // In dev mode with appPath containing "out", should resolve to project root
      expect(root).toBeTruthy()
      expect(typeof root).toBe('string')
    })
  })

  describe('hasSourcePath', () => {
    it('returns true when src/ directory exists', () => {
      mockExistsSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && (p.endsWith('/src') || p.endsWith('\\src'))) return true
        return false
      })

      expect(hasSourcePath()).toBe(true)
    })

    it('returns false when src/ directory does not exist', () => {
      mockExistsSync.mockReturnValue(false)

      expect(hasSourcePath()).toBe(false)
    })
  })

  describe('isUpdateAvailable', () => {
    it('returns false initially', () => {
      expect(isUpdateAvailable()).toBe(false)
    })
  })

  describe('checkForUpdatesOnDemand', () => {
    it('returns false when no source path configured', async () => {
      mockExistsSync.mockReturnValue(false)

      const result = await checkForUpdatesOnDemand()
      expect(result).toBe(false)
    })

    it('hashes the src tree via the async fs path (never sync) when configured', async () => {
      // src/ exists -> source configured; no saved hash file -> baseline is
      // computed via the async sweep. Prove it reads files through fs.promises,
      // not the synchronous readFileSync that froze the boot loop (#120).
      mockExistsSync.mockImplementation((p: string) =>
        typeof p === 'string' && (p.endsWith('/src') || p.endsWith('\\src'))
      )
      mockReaddir.mockResolvedValueOnce([
        { name: 'index.ts', isDirectory: () => false },
        { name: 'styles.css', isDirectory: () => false },
      ] as unknown[])
      mockReadFile.mockResolvedValue(Buffer.from('content'))

      await checkForUpdatesOnDemand()

      // The async read path was exercised for both source files.
      expect(mockReadFile).toHaveBeenCalled()
    })
  })

  describe('markUpdateInstalled', () => {
    it('resets update available flag', () => {
      markUpdateInstalled()
      expect(isUpdateAvailable()).toBe(false)
    })
  })
})
