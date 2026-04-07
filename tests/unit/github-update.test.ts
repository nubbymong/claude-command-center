import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Mock https.get ──────────────────────────────────────────────────────
type MockResponse = { statusCode: number; body?: unknown; headers?: Record<string, string> }
const httpsState = vi.hoisted(() => ({
  nextResponse: { statusCode: 200, body: [] } as MockResponse,
}))

vi.mock('https', () => {
  const { EventEmitter: EE } = require('events')
  const get = (_url: string, opts: any, cb?: any) => {
    const callback = typeof opts === 'function' ? opts : cb
    const res = new EE()
    res.statusCode = httpsState.nextResponse.statusCode
    res.headers = httpsState.nextResponse.headers || {}
    res.resume = () => {}
    res.pipe = (stream: any) => stream
    setImmediate(() => {
      callback(res)
      if (httpsState.nextResponse.body !== undefined && httpsState.nextResponse.body !== null) {
        res.emit('data', Buffer.from(JSON.stringify(httpsState.nextResponse.body)))
      }
      res.emit('end')
    })
    const req = new EE() as any
    req.destroy = () => {}
    return req
  }
  return { default: { get }, get }
})

// ── Mock execFile (used as fallback for gh CLI) ────────────────────────
const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }))
vi.mock('child_process', () => ({
  execFile: (cmd: string, args: string[], opts: any, cb: any) => mockExecFile(cmd, args, opts, cb),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
}))

// promisify(execFile) returns a promise; we shim by having execFile call back synchronously.
// vitest hoists vi.mock so we need util.promisify to honor the standard call signature.
vi.mock('util', async () => {
  const actual = await vi.importActual<any>('util')
  return {
    ...actual,
    promisify: (fn: any) => (...args: any[]) =>
      new Promise((resolve, reject) => {
        fn(...args, (err: Error | null, stdout: string, stderr: string) => {
          if (err) return reject(err)
          resolve({ stdout, stderr })
        })
      }),
  }
})

// ── Mock fs ─────────────────────────────────────────────────────────────
const mockExistsSync = vi.fn(() => true)
vi.mock('fs', () => ({
  existsSync: (...a: any[]) => mockExistsSync(...a),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  createWriteStream: vi.fn(),
  unlinkSync: vi.fn(),
  renameSync: vi.fn(),
}))

// ── Mock registry ──────────────────────────────────────────────────────
const { mockReadRegistry } = vi.hoisted(() => ({ mockReadRegistry: vi.fn(() => null as string | null) }))
vi.mock('../../src/main/registry', () => ({
  readRegistry: () => mockReadRegistry(),
  writeRegistry: vi.fn(() => true),
}))

// ── Mock electron + config-manager ─────────────────────────────────────
let currentChannel: string = 'stable'
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
vi.mock('../../src/main/config-manager', () => ({
  readConfig: vi.fn(() => ({ updateChannel: currentChannel })),
}))
vi.mock('../../src/main/debug-logger', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}))

import { checkGitHubRelease } from '../../src/main/github-update'

describe('github-update', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    httpsState.nextResponse = { statusCode: 200, body: [] }
    currentChannel = 'stable'
    mockReadRegistry.mockReturnValue(null)
  })

  describe('channel matching', () => {
    it('stable channel only sees vX.Y.Z tags', async () => {
      currentChannel = 'stable'
      httpsState.nextResponse ={
        statusCode: 200,
        body: [
          { tag_name: 'v1.2.130-beta', draft: false, prerelease: true, assets: [
            { name: 'ClaudeCommandCenter-Beta-1.2.130.exe', browser_download_url: 'https://x/y.exe' },
          ] },
          { tag_name: 'v1.2.125', draft: false, prerelease: false, assets: [
            { name: 'ClaudeCommandCenter-Beta-1.2.125.exe', browser_download_url: 'https://x/y.exe' },
          ] },
        ],
      }
      const result = await checkGitHubRelease()
      expect(result).not.toBeNull()
      expect(result!.version).toBe('1.2.125')  // skipped the beta
      expect(result!.channel).toBe('stable')
    })

    it('beta channel sees both stable and beta tags', async () => {
      currentChannel = 'beta'
      httpsState.nextResponse ={
        statusCode: 200,
        body: [
          { tag_name: 'v1.2.130-beta', draft: false, prerelease: true, assets: [
            { name: 'ClaudeCommandCenter-Beta-1.2.130.exe', browser_download_url: 'https://x/y.exe' },
          ] },
          { tag_name: 'v1.2.125', draft: false, prerelease: false, assets: [
            { name: 'ClaudeCommandCenter-Beta-1.2.125.exe', browser_download_url: 'https://x/y.exe' },
          ] },
        ],
      }
      const result = await checkGitHubRelease()
      expect(result).not.toBeNull()
      expect(result!.version).toBe('1.2.130')  // beta is newer
      expect(result!.channel).toBe('beta')
    })

    it('dev channel sees stable, beta, and dev tags', async () => {
      currentChannel = 'dev'
      httpsState.nextResponse ={
        statusCode: 200,
        body: [
          { tag_name: 'v1.2.140-dev', draft: false, prerelease: true, assets: [
            { name: 'ClaudeCommandCenter-Beta-1.2.140.exe', browser_download_url: 'https://x/y.exe' },
          ] },
          { tag_name: 'v1.2.130-beta', draft: false, prerelease: true, assets: [
            { name: 'ClaudeCommandCenter-Beta-1.2.130.exe', browser_download_url: 'https://x/y.exe' },
          ] },
          { tag_name: 'v1.2.125', draft: false, prerelease: false, assets: [
            { name: 'ClaudeCommandCenter-Beta-1.2.125.exe', browser_download_url: 'https://x/y.exe' },
          ] },
        ],
      }
      const result = await checkGitHubRelease()
      expect(result).not.toBeNull()
      expect(result!.version).toBe('1.2.140')
      expect(result!.channel).toBe('dev')
    })

    it('beta channel ignores dev tags', async () => {
      currentChannel = 'beta'
      httpsState.nextResponse ={
        statusCode: 200,
        body: [
          { tag_name: 'v1.2.140-dev', draft: false, prerelease: true, assets: [
            { name: 'ClaudeCommandCenter-Beta-1.2.140.exe', browser_download_url: 'https://x/y.exe' },
          ] },
          { tag_name: 'v1.2.130-beta', draft: false, prerelease: true, assets: [
            { name: 'ClaudeCommandCenter-Beta-1.2.130.exe', browser_download_url: 'https://x/y.exe' },
          ] },
        ],
      }
      const result = await checkGitHubRelease()
      expect(result).not.toBeNull()
      expect(result!.version).toBe('1.2.130')  // skipped the dev
      expect(result!.channel).toBe('beta')
    })

    it('skips drafts entirely', async () => {
      currentChannel = 'stable'
      httpsState.nextResponse ={
        statusCode: 200,
        body: [
          { tag_name: 'v1.2.999', draft: true, prerelease: false, assets: [
            { name: 'ClaudeCommandCenter-Beta-1.2.999.exe', browser_download_url: 'https://x/y.exe' },
          ] },
        ],
      }
      const result = await checkGitHubRelease()
      expect(result).toBeNull()
    })
  })

  describe('public API path', () => {
    it('uses public API and does not invoke gh CLI when API returns data', async () => {
      currentChannel = 'stable'
      httpsState.nextResponse ={
        statusCode: 200,
        body: [
          { tag_name: 'v1.2.125', draft: false, prerelease: false, assets: [
            { name: 'ClaudeCommandCenter-Beta-1.2.125.exe', browser_download_url: 'https://x/y.exe' },
          ] },
        ],
      }
      const result = await checkGitHubRelease()
      expect(result).not.toBeNull()
      expect(mockExecFile).not.toHaveBeenCalled()
    })

    it('returns null when up to date via public API', async () => {
      httpsState.nextResponse ={
        statusCode: 200,
        body: [
          { tag_name: 'v1.2.120', draft: false, prerelease: false, assets: [] },
        ],
      }
      const result = await checkGitHubRelease()
      expect(result).toBeNull()
    })

    it('falls back to gh CLI when public API returns 404 (private repo)', async () => {
      httpsState.nextResponse ={ statusCode: 404, body: null as any }
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
        cb(null, JSON.stringify([
          { tagName: 'v1.2.125', isPrerelease: false, isDraft: false, assets: [
            { name: 'ClaudeCommandCenter-Beta-1.2.125.exe', url: 'https://x/y.exe', size: 100 },
          ] },
        ]), '')
      })
      const result = await checkGitHubRelease()
      expect(result).not.toBeNull()
      expect(result!.version).toBe('1.2.125')
      expect(mockExecFile).toHaveBeenCalled()
      // Verify execFile was called with array args (no shell interpolation)
      expect(mockExecFile.mock.calls[0][0]).toBe('gh')
      expect(Array.isArray(mockExecFile.mock.calls[0][1])).toBe(true)
    })

    it('returns null when public API and gh CLI both fail', async () => {
      httpsState.nextResponse ={ statusCode: 404, body: null as any }
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
        cb(new Error('gh: command not found'), '', '')
      })
      const result = await checkGitHubRelease()
      expect(result).toBeNull()
    })
  })

  describe('asset matching', () => {
    it('selects ClaudeCommandCenter installer asset for current platform', async () => {
      const isMac = process.platform === 'darwin'
      const expectedName = isMac
        ? 'ClaudeCommandCenter-Beta-1.2.125-mac.dmg'
        : 'ClaudeCommandCenter-Beta-1.2.125.exe'
      // Release contains both platform installers; the checker should pick the right one
      httpsState.nextResponse = {
        statusCode: 200,
        body: [
          { tag_name: 'v1.2.125', draft: false, prerelease: false, assets: [
            { name: 'CHECKSUMS.txt', browser_download_url: 'https://x/c.txt' },
            { name: 'SomeOtherApp.exe', browser_download_url: 'https://x/other.exe' },
            { name: 'ClaudeCommandCenter-Beta-1.2.125.exe', browser_download_url: 'https://x/win.exe' },
            { name: 'ClaudeCommandCenter-Beta-1.2.125-mac.dmg', browser_download_url: 'https://x/mac.dmg' },
          ] },
        ],
      }
      const result = await checkGitHubRelease()
      expect(result!.installerName).toBe(expectedName)
      expect(result!.installerUrl).toBe(isMac ? 'https://x/mac.dmg' : 'https://x/win.exe')
    })

    it('returns null installerUrl/name when no matching asset', async () => {
      httpsState.nextResponse ={
        statusCode: 200,
        body: [
          { tag_name: 'v1.2.125', draft: false, prerelease: false, assets: [
            { name: 'CHECKSUMS.txt', browser_download_url: 'https://x/c.txt' },
          ] },
        ],
      }
      const result = await checkGitHubRelease()
      expect(result).not.toBeNull()
      expect(result!.installerName).toBeNull()
      expect(result!.installerUrl).toBeNull()
    })
  })

  describe('prerelease ordering', () => {
    it('1.2.3-beta.2 is newer than 1.2.3-beta.1', async () => {
      currentChannel = 'beta'
      httpsState.nextResponse = {
        statusCode: 200,
        body: [
          { tag_name: 'v1.2.125-beta.2', draft: false, prerelease: true, assets: [
            { name: 'ClaudeCommandCenter-Beta-1.2.125.exe', browser_download_url: 'https://x/b2.exe' },
            { name: 'ClaudeCommandCenter-Beta-1.2.125-mac.dmg', browser_download_url: 'https://x/b2.dmg' },
          ] },
          { tag_name: 'v1.2.125-beta.1', draft: false, prerelease: true, assets: [
            { name: 'ClaudeCommandCenter-Beta-1.2.125.exe', browser_download_url: 'https://x/b1.exe' },
            { name: 'ClaudeCommandCenter-Beta-1.2.125-mac.dmg', browser_download_url: 'https://x/b1.dmg' },
          ] },
        ],
      }
      const result = await checkGitHubRelease()
      expect(result).not.toBeNull()
      expect(result!.tagName).toBe('v1.2.125-beta.2')
    })

    it('final 1.2.3 outranks 1.2.3-beta', async () => {
      currentChannel = 'beta'
      httpsState.nextResponse = {
        statusCode: 200,
        body: [
          { tag_name: 'v1.2.125', draft: false, prerelease: false, assets: [
            { name: 'ClaudeCommandCenter-Beta-1.2.125.exe', browser_download_url: 'https://x/f.exe' },
            { name: 'ClaudeCommandCenter-Beta-1.2.125-mac.dmg', browser_download_url: 'https://x/f.dmg' },
          ] },
          { tag_name: 'v1.2.125-beta.3', draft: false, prerelease: true, assets: [
            { name: 'ClaudeCommandCenter-Beta-1.2.125.exe', browser_download_url: 'https://x/b.exe' },
            { name: 'ClaudeCommandCenter-Beta-1.2.125-mac.dmg', browser_download_url: 'https://x/b.dmg' },
          ] },
        ],
      }
      const result = await checkGitHubRelease()
      expect(result).not.toBeNull()
      expect(result!.tagName).toBe('v1.2.125')
      expect(result!.channel).toBe('stable')
    })

    it('ignores unparseable tags', async () => {
      httpsState.nextResponse = {
        statusCode: 200,
        body: [
          { tag_name: 'garbage-tag', draft: false, prerelease: false, assets: [] },
          { tag_name: 'v1.2.125', draft: false, prerelease: false, assets: [
            { name: 'ClaudeCommandCenter-Beta-1.2.125.exe', browser_download_url: 'https://x/y.exe' },
            { name: 'ClaudeCommandCenter-Beta-1.2.125-mac.dmg', browser_download_url: 'https://x/y.dmg' },
          ] },
        ],
      }
      const result = await checkGitHubRelease()
      expect(result).not.toBeNull()
      expect(result!.tagName).toBe('v1.2.125')
    })
  })
})
