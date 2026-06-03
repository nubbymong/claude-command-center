import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

// The global setup mocks setup-handlers and debug-logger. This suite tests the
// REAL data-paths + setup-handlers re-export, so unmock those two. We KEEP
// debug-logger mocked so getDataDirectory()'s logInfo() stays a no-op and the
// test never touches the real log dir on disk (CI hygiene).
vi.unmock('../../../src/main/ipc/setup-handlers')
vi.unmock('../../../src/main/data-paths')

// Test 1: Re-export identity
import {
  getDataDirectory as getDataDirFromDataPaths,
  getResourcesDirectory as getResourcesDirFromDataPaths,
} from '../../../src/main/data-paths'
import {
  getDataDirectory as getDataDirFromSetupHandlers,
  getResourcesDirectory as getResourcesDirFromSetupHandlers,
} from '../../../src/main/ipc/setup-handlers'

describe('data-paths module', () => {
  describe('re-export identity', () => {
    it('getDataDirectory from data-paths and setup-handlers are the same function reference', () => {
      expect(getDataDirFromDataPaths).toBe(getDataDirFromSetupHandlers)
    })

    it('getResourcesDirectory from data-paths and setup-handlers are the same function reference', () => {
      expect(getResourcesDirFromDataPaths).toBe(getResourcesDirFromSetupHandlers)
    })
  })

  describe('behavior', () => {
    it('getDataDirectory() returns a non-empty string', () => {
      const dir = getDataDirFromDataPaths()
      expect(typeof dir).toBe('string')
      expect(dir.length).toBeGreaterThan(0)
    })

    it('getDataDirectory() returns the same value on a second call (cache)', () => {
      const first = getDataDirFromDataPaths()
      const second = getDataDirFromDataPaths()
      expect(first).toBe(second)
    })
  })

  describe('electron-free source guard', () => {
    const src = readFileSync(
      resolve(__dirname, '../../../src/main/data-paths.ts'),
      'utf-8'
    )

    it('does not import from electron (incl. subpaths / require)', () => {
      expect(src).not.toMatch(/from ['"]electron(\/[^'"]*)?['"]/)
      expect(src).not.toMatch(/require\(['"]electron(\/[^'"]*)?['"]\)/)
    })

    it('does not import from setup-handlers', () => {
      expect(src).not.toMatch(/setup-handlers/)
    })
  })
})
