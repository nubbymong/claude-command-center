import { describe, it, expect, beforeEach, vi } from 'vitest'

// ── Mock https.get ──────────────────────────────────────────────────────
// Supports:
//   1. JSON responses (used by fetchReleasesPublic) — set httpsState.nextResponse
//   2. Multiple sequential responses for redirect chains — set httpsState.responses
//   3. Streaming download (pipes body bytes into a write stream) — set .bodyBuffer
type MockResponse = {
  statusCode: number
  body?: unknown              // JSON body (stringified + emitted as data event)
  bodyBuffer?: Buffer         // Raw buffer for streaming downloads
  headers?: Record<string, string>
}
const httpsState = vi.hoisted(() => ({
  nextResponse: { statusCode: 200, body: [] } as MockResponse,
  responses: [] as MockResponse[],   // When non-empty, used per-call in order
  callUrls: [] as string[],          // Track URLs that were requested
}))

vi.mock('https', () => {
  const { EventEmitter: EE } = require('events')
  const get = (url: string, opts: any, cb?: any) => {
    const callback = typeof opts === 'function' ? opts : cb
    httpsState.callUrls.push(url)
    const resp = httpsState.responses.length > 0
      ? httpsState.responses.shift()!
      : httpsState.nextResponse
    const res = new EE()
    res.statusCode = resp.statusCode
    res.headers = resp.headers || {}
    res.resume = () => {}
    res.pipe = (stream: any) => {
      // Simulate streaming bytes from response into the write stream
      setImmediate(() => {
        if (resp.bodyBuffer) {
          stream.write?.(resp.bodyBuffer)
        }
        stream.emit?.('finish')
      })
      return stream
    }
    setImmediate(() => {
      callback(res)
      if (resp.body !== undefined && resp.body !== null && !resp.bodyBuffer) {
        res.emit('data', Buffer.from(JSON.stringify(resp.body)))
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
// Download tests need a working createWriteStream that emits 'finish' after
// piped data, plus a rename that actually makes existsSync return true for destPath.
const mockExistsSync = vi.fn(() => true)
const mockRenameSync = vi.fn()
const mockUnlinkSync = vi.fn()
const mockCreateWriteStream = vi.fn()
const mockChmodSync = vi.fn()
const mockCopyFileSync = vi.fn()
const mockRealpathSync = vi.fn((p: string) => p)                 // identity: no symlink
const mockLstatSync = vi.fn(() => ({ isFile: () => true }))      // regular file
const mockSymlinkSync = vi.fn()
vi.mock('fs', () => {
  const { EventEmitter: EE } = require('events')
  return {
    chmodSync: (...a: any[]) => mockChmodSync(...a),
    copyFileSync: (...a: any[]) => mockCopyFileSync(...a),
    realpathSync: (...a: any[]) => mockRealpathSync(...a),
    lstatSync: (...a: any[]) => mockLstatSync(...a),
    symlinkSync: (...a: any[]) => mockSymlinkSync(...a),
    existsSync: (...a: any[]) => mockExistsSync(...a),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    createWriteStream: (path: string) => {
      mockCreateWriteStream(path)
      const stream = new EE() as any
      stream.closed = false
      stream.write = vi.fn()
      stream.close = (cb?: () => void) => {
        stream.closed = true
        if (cb) cb()
      }
      return stream
    },
    unlinkSync: (...a: any[]) => mockUnlinkSync(...a),
    renameSync: (...a: any[]) => mockRenameSync(...a),
  }
})

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

import { checkGitHubRelease, downloadGitHubRelease, installerExtForPlatform, prepareLinuxAppImageUpdate, isPathOnNoexecMount } from '../../src/main/github-update'

// Helper to build release fixtures with installers for ALL platforms.
// checkGitHubRelease returns null if no matching asset exists for the current
// platform, and these tests run on whatever host executes the suite (Windows
// or macOS CI legs, Linux dev boxes) — so every fixture needs all three.
function releaseWithBothAssets(tagName: string, version: string, isPrerelease = false) {
  return {
    tag_name: tagName,
    draft: false,
    prerelease: isPrerelease,
    assets: [
      { name: `ClaudeCommandCenter-Beta-${version}.exe`, browser_download_url: `https://x/${version}.exe` },
      { name: `ClaudeCommandCenter-Beta-${version}-mac.dmg`, browser_download_url: `https://x/${version}.dmg` },
      { name: `ClaudeCommandCenter-Beta-${version}-linux-x86_64.AppImage`, browser_download_url: `https://x/${version}.AppImage` },
    ],
  }
}

describe('github-update', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    httpsState.nextResponse = { statusCode: 200, body: [] }
    httpsState.responses = []
    httpsState.callUrls = []
    currentChannel = 'stable'
    mockReadRegistry.mockReturnValue(null)
    mockExistsSync.mockReturnValue(true)
  })

  describe('channel matching', () => {
    it('stable channel only sees vX.Y.Z tags', async () => {
      currentChannel = 'stable'
      httpsState.nextResponse = {
        statusCode: 200,
        body: [
          releaseWithBothAssets('v1.2.130-beta', '1.2.130', true),
          releaseWithBothAssets('v1.2.125', '1.2.125'),
        ],
      }
      const result = await checkGitHubRelease()
      expect(result).not.toBeNull()
      expect(result!.version).toBe('1.2.125')  // skipped the beta
      expect(result!.channel).toBe('stable')
    })

    it('beta channel sees both stable and beta tags', async () => {
      currentChannel = 'beta'
      httpsState.nextResponse = {
        statusCode: 200,
        body: [
          releaseWithBothAssets('v1.2.130-beta', '1.2.130', true),
          releaseWithBothAssets('v1.2.125', '1.2.125'),
        ],
      }
      const result = await checkGitHubRelease()
      expect(result).not.toBeNull()
      expect(result!.version).toBe('1.2.130')  // beta is newer
      expect(result!.channel).toBe('beta')
    })

    it('beta channel ignores unknown tags', async () => {
      currentChannel = 'beta'
      httpsState.nextResponse = {
        statusCode: 200,
        body: [
          releaseWithBothAssets('v1.2.140-dev', '1.2.140', true),
          releaseWithBothAssets('v1.2.130-beta', '1.2.130', true),
        ],
      }
      const result = await checkGitHubRelease()
      expect(result).not.toBeNull()
      expect(result!.version).toBe('1.2.130')  // skipped the unrecognized dev tag
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

  describe('release candidates (-rc.N)', () => {
    it('beta channel sees rc tags, and rc outranks beta of the same base version', async () => {
      currentChannel = 'beta'
      httpsState.nextResponse = {
        statusCode: 200,
        body: [
          releaseWithBothAssets('v2.0.0-beta.9', '2.0.0', true),
          releaseWithBothAssets('v2.0.0-rc.1', '2.0.0', true),
        ],
      }
      const result = await checkGitHubRelease()
      expect(result).not.toBeNull()
      expect(result!.tagName).toBe('v2.0.0-rc.1')
      expect(result!.channel).toBe('beta')
    })

    it('final release outranks an rc of the same base version', async () => {
      currentChannel = 'beta'
      httpsState.nextResponse = {
        statusCode: 200,
        body: [
          releaseWithBothAssets('v2.0.0-rc.1', '2.0.0', true),
          releaseWithBothAssets('v2.0.0', '2.0.0'),
        ],
      }
      const result = await checkGitHubRelease()
      expect(result).not.toBeNull()
      expect(result!.tagName).toBe('v2.0.0')
      expect(result!.channel).toBe('stable')
    })

    it('rc.2 outranks rc.1', async () => {
      currentChannel = 'beta'
      httpsState.nextResponse = {
        statusCode: 200,
        body: [
          releaseWithBothAssets('v2.0.0-rc.1', '2.0.0', true),
          releaseWithBothAssets('v2.0.0-rc.2', '2.0.0', true),
        ],
      }
      const result = await checkGitHubRelease()
      expect(result).not.toBeNull()
      expect(result!.tagName).toBe('v2.0.0-rc.2')
    })

    it('stable channel does NOT see rc tags', async () => {
      currentChannel = 'stable'
      httpsState.nextResponse = {
        statusCode: 200,
        body: [
          releaseWithBothAssets('v2.0.0-rc.1', '2.0.0', true),
        ],
      }
      const result = await checkGitHubRelease()
      expect(result).toBeNull()
    })
  })

  describe('public API path', () => {
    it('uses public API and does not invoke gh CLI when API returns data', async () => {
      currentChannel = 'stable'
      httpsState.nextResponse = {
        statusCode: 200,
        body: [releaseWithBothAssets('v1.2.125', '1.2.125')],
      }
      const result = await checkGitHubRelease()
      expect(result).not.toBeNull()
      expect(mockExecFile).not.toHaveBeenCalled()
    })

    it('returns null when up to date via public API', async () => {
      httpsState.nextResponse = {
        statusCode: 200,
        body: [
          { tag_name: 'v1.2.120', draft: false, prerelease: false, assets: [] },
        ],
      }
      const result = await checkGitHubRelease()
      expect(result).toBeNull()
    })

    it('falls back to gh CLI when public API returns 404 (private repo)', async () => {
      httpsState.nextResponse = { statusCode: 404, body: null as any }
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
        cb(null, JSON.stringify([
          { tagName: 'v1.2.125', isPrerelease: false, isDraft: false, assets: [
            { name: 'ClaudeCommandCenter-Beta-1.2.125.exe', url: 'https://x/y.exe', size: 100 },
            { name: 'ClaudeCommandCenter-Beta-1.2.125-mac.dmg', url: 'https://x/y.dmg', size: 100 },
            { name: 'ClaudeCommandCenter-Beta-1.2.125-linux-x86_64.AppImage', url: 'https://x/y.AppImage', size: 100 },
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
      httpsState.nextResponse = { statusCode: 404, body: null as any }
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
        cb(new Error('gh: command not found'), '', '')
      })
      const result = await checkGitHubRelease()
      expect(result).toBeNull()
    })
  })

  describe('asset matching', () => {
    it('selects ClaudeCommandCenter installer asset for current platform', async () => {
      const expectedByPlatform: Record<string, { name: string; url: string }> = {
        darwin: { name: 'ClaudeCommandCenter-Beta-1.2.125-mac.dmg', url: 'https://x/mac.dmg' },
        linux: { name: 'ClaudeCommandCenter-Beta-1.2.125-linux-x86_64.AppImage', url: 'https://x/linux.AppImage' },
        win32: { name: 'ClaudeCommandCenter-Beta-1.2.125.exe', url: 'https://x/win.exe' },
      }
      const expected = expectedByPlatform[process.platform] ?? expectedByPlatform.win32
      // Release contains all platform installers; the checker should pick the right one
      httpsState.nextResponse = {
        statusCode: 200,
        body: [
          { tag_name: 'v1.2.125', draft: false, prerelease: false, assets: [
            { name: 'CHECKSUMS.txt', browser_download_url: 'https://x/c.txt' },
            { name: 'SomeOtherApp.exe', browser_download_url: 'https://x/other.exe' },
            { name: 'ClaudeCommandCenter-Beta-1.2.125.exe', browser_download_url: 'https://x/win.exe' },
            { name: 'ClaudeCommandCenter-Beta-1.2.125-mac.dmg', browser_download_url: 'https://x/mac.dmg' },
            { name: 'ClaudeCommandCenter-Beta-1.2.125-linux-x86_64.AppImage', browser_download_url: 'https://x/linux.AppImage' },
          ] },
        ],
      }
      const result = await checkGitHubRelease()
      expect(result!.installerName).toBe(expected.name)
      expect(result!.installerUrl).toBe(expected.url)
    })

    it('returns null entirely when no installer asset exists for this platform', async () => {
      // No matching asset — we must not offer an update the user cannot install
      httpsState.nextResponse = {
        statusCode: 200,
        body: [
          { tag_name: 'v1.2.125', draft: false, prerelease: false, assets: [
            { name: 'CHECKSUMS.txt', browser_download_url: 'https://x/c.txt' },
          ] },
        ],
      }
      const result = await checkGitHubRelease()
      expect(result).toBeNull()
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
            { name: 'ClaudeCommandCenter-Beta-1.2.125-linux-x86_64.AppImage', browser_download_url: 'https://x/b2.AppImage' },
          ] },
          { tag_name: 'v1.2.125-beta.1', draft: false, prerelease: true, assets: [
            { name: 'ClaudeCommandCenter-Beta-1.2.125.exe', browser_download_url: 'https://x/b1.exe' },
            { name: 'ClaudeCommandCenter-Beta-1.2.125-mac.dmg', browser_download_url: 'https://x/b1.dmg' },
            { name: 'ClaudeCommandCenter-Beta-1.2.125-linux-x86_64.AppImage', browser_download_url: 'https://x/b1.AppImage' },
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
            { name: 'ClaudeCommandCenter-Beta-1.2.125-linux-x86_64.AppImage', browser_download_url: 'https://x/f.AppImage' },
          ] },
          { tag_name: 'v1.2.125-beta.3', draft: false, prerelease: true, assets: [
            { name: 'ClaudeCommandCenter-Beta-1.2.125.exe', browser_download_url: 'https://x/b.exe' },
            { name: 'ClaudeCommandCenter-Beta-1.2.125-mac.dmg', browser_download_url: 'https://x/b.dmg' },
            { name: 'ClaudeCommandCenter-Beta-1.2.125-linux-x86_64.AppImage', browser_download_url: 'https://x/b.AppImage' },
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
            { name: 'ClaudeCommandCenter-Beta-1.2.125-linux-x86_64.AppImage', browser_download_url: 'https://x/y.AppImage' },
          ] },
        ],
      }
      const result = await checkGitHubRelease()
      expect(result).not.toBeNull()
      expect(result!.tagName).toBe('v1.2.125')
    })
  })

  describe('rate limit handling', () => {
    it('gives up and does NOT fall back to gh CLI when API rate-limited (403 with x-ratelimit-remaining: 0)', async () => {
      httpsState.nextResponse = {
        statusCode: 403,
        headers: {
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        },
      }
      const result = await checkGitHubRelease()
      expect(result).toBeNull()
      // Crucial: gh CLI should NOT have been called — it wouldn't help with a public API rate limit
      expect(mockExecFile).not.toHaveBeenCalled()
    })

    it('falls back to gh CLI on 403 without rate-limit header', async () => {
      httpsState.nextResponse = { statusCode: 403, body: null as any }
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
        cb(null, JSON.stringify([
          { tagName: 'v1.2.125', isPrerelease: false, isDraft: false, assets: [
            { name: 'ClaudeCommandCenter-Beta-1.2.125.exe', url: 'https://x/y.exe', size: 100 },
            { name: 'ClaudeCommandCenter-Beta-1.2.125-mac.dmg', url: 'https://x/y.dmg', size: 100 },
            { name: 'ClaudeCommandCenter-Beta-1.2.125-linux-x86_64.AppImage', url: 'https://x/y.AppImage', size: 100 },
          ] },
        ]), '')
      })
      const result = await checkGitHubRelease()
      expect(result).not.toBeNull()
      expect(mockExecFile).toHaveBeenCalled()
    })
  })

  describe('downloadGitHubRelease', () => {
    it('downloads via direct HTTPS when directUrl is provided', async () => {
      httpsState.nextResponse = {
        statusCode: 200,
        bodyBuffer: Buffer.from('fake installer bytes'),
      }
      const result = await downloadGitHubRelease('v1.2.125', 'ClaudeCommandCenter-Beta-1.2.125.exe', 'https://x/y.exe')
      expect(result).not.toBeNull()
      expect(result).toContain('ClaudeCommandCenter-Beta-1.2.125.exe')
      // gh CLI should NOT have been called since direct download succeeded
      expect(mockExecFile).not.toHaveBeenCalled()
    })

    it('follows HTTPS redirects during download', async () => {
      // First response: 302 redirect
      // Second response: 200 with the body
      httpsState.responses = [
        { statusCode: 302, headers: { location: 'https://cdn.example.com/real-file.exe' } },
        { statusCode: 200, bodyBuffer: Buffer.from('final bytes') },
      ]
      const result = await downloadGitHubRelease('v1.2.125', 'ClaudeCommandCenter-Beta-1.2.125.exe', 'https://x/redirect.exe')
      expect(result).not.toBeNull()
      // Both URLs should have been called in order
      expect(httpsState.callUrls).toHaveLength(2)
      expect(httpsState.callUrls[0]).toBe('https://x/redirect.exe')
      expect(httpsState.callUrls[1]).toBe('https://cdn.example.com/real-file.exe')
    })

    it('refuses non-HTTPS redirect (security)', async () => {
      httpsState.responses = [
        { statusCode: 302, headers: { location: 'http://malicious.example.com/file.exe' } },
      ]
      // Direct download fails due to unsafe redirect, then falls back to gh CLI
      mockExistsSync.mockReturnValue(false)
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
        cb(new Error('gh not available'), '', '')
      })
      const result = await downloadGitHubRelease('v1.2.125', 'ClaudeCommandCenter-Beta-1.2.125.exe', 'https://x/redirect.exe')
      expect(result).toBeNull()
    })

    it('resolves relative redirect against the source URL', async () => {
      httpsState.responses = [
        { statusCode: 302, headers: { location: '/assets/real-file.exe' } },
        { statusCode: 200, bodyBuffer: Buffer.from('final bytes') },
      ]
      const result = await downloadGitHubRelease('v1.2.125', 'ClaudeCommandCenter-Beta-1.2.125.exe', 'https://origin.example.com/redirect.exe')
      expect(result).not.toBeNull()
      expect(httpsState.callUrls[1]).toBe('https://origin.example.com/assets/real-file.exe')
    })

    it('falls back to gh CLI when direct download fails (no directUrl)', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
        cb(null, '', '')  // gh exits cleanly
      })
      mockExistsSync.mockReturnValue(true)
      const result = await downloadGitHubRelease('v1.2.125', 'ClaudeCommandCenter-Beta-1.2.125.exe', null)
      expect(result).not.toBeNull()
      expect(mockExecFile).toHaveBeenCalled()
      expect(mockExecFile.mock.calls[0][0]).toBe('gh')
      // Verify args are an array — no shell string interpolation
      expect(Array.isArray(mockExecFile.mock.calls[0][1])).toBe(true)
    })

    it('removes stale destPath before rename (Windows retry safety)', async () => {
      httpsState.nextResponse = {
        statusCode: 200,
        bodyBuffer: Buffer.from('fresh bytes'),
      }
      // Simulate that the destination file already exists from a previous attempt
      mockExistsSync.mockReturnValue(true)
      const result = await downloadGitHubRelease('v1.2.125', 'ClaudeCommandCenter-Beta-1.2.125.exe', 'https://x/y.exe')
      expect(result).not.toBeNull()
      // unlink should have been called to remove the stale file before rename
      expect(mockUnlinkSync).toHaveBeenCalled()
      expect(mockRenameSync).toHaveBeenCalled()
    })

    it('returns null when both direct download and gh CLI fail', async () => {
      httpsState.nextResponse = { statusCode: 500, body: null as any }
      mockExistsSync.mockReturnValue(false)
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
        cb(new Error('gh: command not found'), '', '')
      })
      const result = await downloadGitHubRelease('v1.2.125', 'ClaudeCommandCenter-Beta-1.2.125.exe', 'https://x/y.exe')
      expect(result).toBeNull()
    })
  })

  describe('installerExtForPlatform', () => {
    it('maps each platform to its installer asset extension', () => {
      expect(installerExtForPlatform('win32')).toBe('.exe')
      expect(installerExtForPlatform('darwin')).toBe('.dmg')
      // The Linux regression: before this mapping, linux fell into the '.exe'
      // default, matched no asset on any release, and silently skipped every
      // update — Linux installs were frozen at their first-installed version.
      expect(installerExtForPlatform('linux')).toBe('.AppImage')
    })

    it('unknown platforms fall back to .exe (the historical default)', () => {
      expect(installerExtForPlatform('freebsd' as NodeJS.Platform)).toBe('.exe')
    })

    it('release.yml artifact names satisfy the asset-selection predicate', () => {
      // The checker requires startsWith('ClaudeCommandCenter-') && endsWith(ext).
      // Pin the contract against the electron-builder artifactName patterns so a
      // rename in package.json can't silently strand a platform again.
      const artifacts: Array<[string, string]> = [
        ['ClaudeCommandCenter-2.1.0-beta.1.exe', '.exe'],
        ['ClaudeCommandCenter-2.1.0-beta.1-mac.dmg', '.dmg'],
        ['ClaudeCommandCenter-2.1.0-beta.1-linux-x86_64.AppImage', '.AppImage'],
      ]
      for (const [name, ext] of artifacts) {
        expect(name.startsWith('ClaudeCommandCenter-')).toBe(true)
        expect(name.endsWith(ext)).toBe(true)
      }
    })
  })

  describe('prepareLinuxAppImageUpdate', () => {
    const downloaded = '/home/u/Downloads/ClaudeCommandCenter-2.1.0-beta.2-linux-x86_64.AppImage'
    const running = '/home/u/Apps/ClaudeCommandCenter-2.1.0-beta.1-linux-x86_64.AppImage'

    beforeEach(() => {
      // vi.clearAllMocks() clears CALLS but keeps implementations — a throwing
      // mockImplementation from one test would otherwise leak into the next.
      mockChmodSync.mockReset()
      mockCopyFileSync.mockReset()
      mockUnlinkSync.mockReset()
      mockSymlinkSync.mockReset()
      mockRealpathSync.mockReset().mockImplementation((p: string) => p)
      mockLstatSync.mockReset().mockReturnValue({ isFile: () => true })
    })

    it('always chmods the download executable (downloads arrive without +x)', () => {
      prepareLinuxAppImageUpdate(downloaded, undefined)
      expect(mockChmodSync).toHaveBeenCalledWith(downloaded, 0o755)
    })

    it('without $APPIMAGE (extracted/dev run), launches from the download location', () => {
      const result = prepareLinuxAppImageUpdate(downloaded, undefined)
      expect(result).toBe(downloaded)
      expect(mockCopyFileSync).not.toHaveBeenCalled()
      expect(mockUnlinkSync).not.toHaveBeenCalled()
    })

    it('versioned running name: writes the new versioned file and removes the old', () => {
      const result = prepareLinuxAppImageUpdate(downloaded, running)
      const expectedTarget = '/home/u/Apps/ClaudeCommandCenter-2.1.0-beta.2-linux-x86_64.AppImage'
      expect(result?.replace(/\\/g, '/')).toBe(expectedTarget)
      expect(mockCopyFileSync).toHaveBeenCalledTimes(1)
      expect(mockChmodSync).toHaveBeenCalledTimes(2) // download + target
      // Old version file removed (safe on Linux: mounted inode outlives the unlink)
      expect(mockUnlinkSync).toHaveBeenCalledWith(running)
    })

    it('finding #1 — custom UNVERSIONED name is preserved: overwrites the SAME path', () => {
      // The user renamed their AppImage to a stable name a .desktop/dock/alias
      // points at. Writing a new versioned name would orphan that launcher, so
      // we overwrite in place and keep their filename.
      const custom = '/home/u/Apps/ClaudeCommandCenter.AppImage'
      const result = prepareLinuxAppImageUpdate(downloaded, custom)
      expect(result?.replace(/\\/g, '/')).toBe(custom)
      expect(mockCopyFileSync).toHaveBeenCalledWith(downloaded, custom)
      // unlink-before-write on the same path (avoids truncating the mounted image)
      expect(mockUnlinkSync).toHaveBeenCalledWith(custom)
      // ...and NOT a second unlink, since target === running
      expect(mockUnlinkSync).toHaveBeenCalledTimes(1)
    })

    it('finding #1 — symlink launcher: resolves realpath and re-points the link', () => {
      const link = '/home/u/bin/ccc'          // what the user launches
      mockRealpathSync.mockReturnValue(running) // resolves to the real versioned file
      const result = prepareLinuxAppImageUpdate(downloaded, link)
      const expectedTarget = '/home/u/Apps/ClaudeCommandCenter-2.1.0-beta.2-linux-x86_64.AppImage'
      expect(result?.replace(/\\/g, '/')).toBe(expectedTarget)
      expect(mockUnlinkSync).toHaveBeenCalledWith(running)  // real old file removed
      // symlink re-pointed at the new file so the stable launcher keeps working
      // (normalize separators — path.join yields backslashes on a win32 test host)
      const [symTarget, symLink] = mockSymlinkSync.mock.calls[0]
      expect(String(symTarget).replace(/\\/g, '/')).toBe(expectedTarget)
      expect(symLink).toBe(link)
    })

    it('finding #4 — refuses a $APPIMAGE that is not an AppImage file (no delete, no copy)', () => {
      const stranger = '/home/u/important.txt'
      mockRealpathSync.mockReturnValue(stranger)
      const result = prepareLinuxAppImageUpdate(downloaded, stranger)
      expect(result).toBe(downloaded)
      expect(mockUnlinkSync).not.toHaveBeenCalled()
      expect(mockCopyFileSync).not.toHaveBeenCalled()
    })

    it('finding #4 — refuses a $APPIMAGE that is a directory', () => {
      mockLstatSync.mockReturnValue({ isFile: () => false })
      const result = prepareLinuxAppImageUpdate(downloaded, '/home/u/Apps')
      expect(result).toBe(downloaded)
      expect(mockUnlinkSync).not.toHaveBeenCalled()
    })

    it('when $APPIMAGE no longer resolves (realpath throws), launches from the download', () => {
      mockRealpathSync.mockImplementation(() => { throw new Error('ENOENT') })
      const result = prepareLinuxAppImageUpdate(downloaded, running)
      expect(result).toBe(downloaded)
      expect(mockCopyFileSync).not.toHaveBeenCalled()
    })

    it('degrades to the download location when the copy fails (unwritable dir)', () => {
      mockCopyFileSync.mockImplementation(() => { throw new Error('EACCES: permission denied') })
      const result = prepareLinuxAppImageUpdate(downloaded, running)
      expect(result).toBe(downloaded)
    })

    it('failure to remove the old version is non-fatal (still returns the new path)', () => {
      mockUnlinkSync.mockImplementation(() => { throw new Error('EBUSY') })
      const result = prepareLinuxAppImageUpdate(downloaded, running)
      expect(result?.replace(/\\/g, '/')).toBe('/home/u/Apps/ClaudeCommandCenter-2.1.0-beta.2-linux-x86_64.AppImage')
    })

    it('re-download of the exact same file is a no-op replace', () => {
      const samePath = '/home/u/Apps/ClaudeCommandCenter-2.1.0-beta.2-linux-x86_64.AppImage'
      const result = prepareLinuxAppImageUpdate(samePath, samePath)
      expect(result).toBe(samePath)
      expect(mockCopyFileSync).not.toHaveBeenCalled()
      expect(mockUnlinkSync).not.toHaveBeenCalled()
    })
  })

  describe('isPathOnNoexecMount (Copilot review — access(X_OK) misses noexec)', () => {
    // Realistic /proc/mounts: home is noexec (hardened box), root is normal.
    const mounts = [
      'proc /proc proc rw,nosuid,nodev,noexec,relatime 0 0',
      '/dev/sda1 / ext4 rw,relatime 0 0',
      '/dev/sda2 /home ext4 rw,nosuid,nodev,noexec,relatime 0 0',
      'tmpfs /tmp tmpfs rw,nosuid,nodev,relatime 0 0',
    ].join('\n')

    it('flags a file under a noexec mount', () => {
      expect(isPathOnNoexecMount('/home/u/Downloads/x.AppImage', mounts)).toBe(true)
    })

    it('does NOT flag a file under an exec mount', () => {
      expect(isPathOnNoexecMount('/opt/apps/x.AppImage', mounts)).toBe(false) // falls to / (exec)
      expect(isPathOnNoexecMount('/tmp/x.AppImage', mounts)).toBe(false)
    })

    it('longest-prefix wins: an exec submount under a noexec parent is exec', () => {
      const nested = mounts + '\n/dev/sdb1 /home/u/exec ext4 rw,relatime 0 0'
      expect(isPathOnNoexecMount('/home/u/exec/x.AppImage', nested)).toBe(false)
      expect(isPathOnNoexecMount('/home/u/other/x.AppImage', nested)).toBe(true)
    })

    it('does not prefix-match a sibling whose name shares a prefix', () => {
      // /home must not match /home2 — the trailing-slash boundary guards this
      const m = '/dev/sda1 / ext4 rw 0 0\n/dev/sda2 /home ext4 rw,noexec 0 0'
      expect(isPathOnNoexecMount('/home2/x.AppImage', m)).toBe(false)
    })

    it('degrades to false when /proc/mounts is unreadable (never blocks updates)', () => {
      // No procMounts arg → reads /proc/mounts, which the fs mock returns undefined
      // for; the try/catch returns false rather than throwing.
      expect(isPathOnNoexecMount('/home/u/x.AppImage')).toBe(false)
    })
  })
})
