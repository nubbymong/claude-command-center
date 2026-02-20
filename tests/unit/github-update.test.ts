import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock child_process
const mockExecSync = vi.fn()
vi.mock('child_process', () => ({
  execSync: (...args: any[]) => mockExecSync(...args),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}))

// Mock fs
const mockExistsSync = vi.fn(() => true)
vi.mock('fs', () => ({
  existsSync: (...args: any[]) => mockExistsSync(...args),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}))

// Mock registry
vi.mock('../../src/main/registry', () => ({
  readRegistry: vi.fn(() => null),
  writeRegistry: vi.fn(() => true),
}))

// Mock electron app.getVersion
vi.mock('electron', async () => {
  const actual = await vi.importActual<any>('electron')
  return {
    ...actual,
    app: {
      ...actual.app,
      getVersion: vi.fn(() => '1.2.120'),
      getPath: vi.fn(() => '/mock/userData'),
    },
  }
})

import { checkGitHubRelease, downloadGitHubRelease } from '../../src/main/github-update'

describe('github-update', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('checkGitHubRelease', () => {
    it('returns release info when newer version is available', async () => {
      mockExecSync.mockReturnValue(JSON.stringify({
        tagName: 'v1.2.125',
        assets: [
          { name: 'ClaudeCommandCenter-Beta-1.2.125.exe', url: 'https://example.com/installer.exe' },
          { name: 'CHECKSUMS.txt', url: 'https://example.com/checksums.txt' },
        ],
      }))

      const result = await checkGitHubRelease()
      expect(result).not.toBeNull()
      expect(result!.version).toBe('1.2.125')
      expect(result!.tagName).toBe('v1.2.125')
      expect(result!.installerName).toBe('ClaudeCommandCenter-Beta-1.2.125.exe')
    })

    it('returns null when current version is up to date', async () => {
      mockExecSync.mockReturnValue(JSON.stringify({
        tagName: 'v1.2.120',
        assets: [],
      }))

      const result = await checkGitHubRelease()
      expect(result).toBeNull()
    })

    it('returns null when current version is newer than release', async () => {
      mockExecSync.mockReturnValue(JSON.stringify({
        tagName: 'v1.2.100',
        assets: [],
      }))

      const result = await checkGitHubRelease()
      expect(result).toBeNull()
    })

    it('handles missing installer asset gracefully', async () => {
      mockExecSync.mockReturnValue(JSON.stringify({
        tagName: 'v1.2.125',
        assets: [
          { name: 'CHECKSUMS.txt', url: 'https://example.com/checksums.txt' },
        ],
      }))

      const result = await checkGitHubRelease()
      expect(result).not.toBeNull()
      expect(result!.installerName).toBeNull()
      expect(result!.installerUrl).toBeNull()
    })

    it('returns null when gh CLI fails', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('gh: command not found')
      })

      const result = await checkGitHubRelease()
      expect(result).toBeNull()
    })

    it('returns null on invalid JSON', async () => {
      mockExecSync.mockReturnValue('not json')

      const result = await checkGitHubRelease()
      expect(result).toBeNull()
    })

    it('ignores non-ClaudeCommandCenter exe assets', async () => {
      mockExecSync.mockReturnValue(JSON.stringify({
        tagName: 'v1.2.125',
        assets: [
          { name: 'SomeOtherApp.exe', url: 'https://example.com/other.exe' },
          { name: 'ClaudeCommandCenter-Beta-1.2.125.exe', url: 'https://example.com/installer.exe' },
        ],
      }))

      const result = await checkGitHubRelease()
      expect(result!.installerName).toBe('ClaudeCommandCenter-Beta-1.2.125.exe')
    })
  })

  describe('downloadGitHubRelease', () => {
    it('downloads installer via gh CLI and returns path', async () => {
      mockExecSync.mockReturnValue('')
      mockExistsSync.mockReturnValue(true)

      const result = await downloadGitHubRelease('v1.2.125', 'ClaudeCommandCenter-Beta-1.2.125.exe')
      expect(result).toContain('ClaudeCommandCenter-Beta-1.2.125.exe')
      expect(mockExecSync).toHaveBeenCalledWith(
        expect.stringContaining('gh release download v1.2.125'),
        expect.any(Object)
      )
    })

    it('returns null when download fails', async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error('network error')
      })

      const result = await downloadGitHubRelease('v1.2.125', 'ClaudeCommandCenter-Beta-1.2.125.exe')
      expect(result).toBeNull()
    })

    it('returns null when file not found after download', async () => {
      mockExecSync.mockReturnValue('')
      mockExistsSync.mockReturnValue(false)

      const result = await downloadGitHubRelease('v1.2.125', 'ClaudeCommandCenter-Beta-1.2.125.exe')
      expect(result).toBeNull()
    })
  })
})
