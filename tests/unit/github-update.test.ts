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
vi.mock('fs', () => {
  const { EventEmitter: EE } = require('events')
  return {
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

import { checkGitHubRelease, downloadGitHubRelease } from '../../src/main/github-update'

// Helper to build release fixtures with installers for BOTH platforms.
// checkGitHubRelease now returns null if no matching asset exists for the
// current platform, so every test fixture needs both .exe and .dmg assets.
function releaseWithBothAssets(tagName: string, version: string, isPrerelease = false) {
  return {
    tag_name: tagName,
    draft: false,
    prerelease: isPrerelease,
    assets: [
      { name: `ClaudeCommandCenter-Beta-${version}.exe`, browser_download_url: `https://x/${version}.exe` },
      { name: `ClaudeCommandCenter-Beta-${version}-mac.dmg`, browser_download_url: `https://x/${version}.dmg` },
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

    it('dev channel sees stable, beta, and dev tags', async () => {
      currentChannel = 'dev'
      httpsState.nextResponse = {
        statusCode: 200,
        body: [
          releaseWithBothAssets('v1.2.140-dev', '1.2.140', true),
          releaseWithBothAssets('v1.2.130-beta', '1.2.130', true),
          releaseWithBothAssets('v1.2.125', '1.2.125'),
        ],
      }
      const result = await checkGitHubRelease()
      expect(result).not.toBeNull()
      expect(result!.version).toBe('1.2.140')
      expect(result!.channel).toBe('dev')
    })

    it('beta channel ignores dev tags', async () => {
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
})
