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
  bodyChunks?: Buffer[]       // Multi-chunk body — exercises mid-stream aborts
  headers?: Record<string, string>
}
const httpsState = vi.hoisted(() => ({
  nextResponse: { statusCode: 200, body: [] } as MockResponse,
  responses: [] as MockResponse[],   // When non-empty, used per-call in order
  callUrls: [] as string[],          // Track URLs that were requested
  destroyed: 0,                      // res.destroy() calls — abandoned hops
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
    res.__aborted = false
    // A real IncomingMessage is a stream and has destroy(). #174 destroys a
    // redirect response instead of resume()-ing it, so the mock needs this or
    // every redirect test hangs on a TypeError inside the callback.
    res.destroy = () => { res.__aborted = true; httpsState.destroyed += 1 }
    res.pipe = (stream: any) => {
      // Emit 'data' per chunk as the real stream does, THEN write it on. The
      // old mock wrote bodyBuffer straight into the stream without emitting,
      // which meant a `res.on('data')` byte counter in production code could
      // never be exercised (#174's wire-level size cap is exactly that).
      // Stopping on __aborted models `req.destroy()`: once the consumer aborts,
      // no further chunks arrive and 'finish' never fires.
      setImmediate(() => {
        const chunks: Buffer[] = resp.bodyChunks ?? (resp.bodyBuffer ? [resp.bodyBuffer] : [])
        for (const chunk of chunks) {
          if (res.__aborted) return
          res.emit('data', chunk)
          if (res.__aborted) return
          stream.write?.(chunk)
        }
        if (res.__aborted) return
        stream.emit?.('finish')
      })
      return stream
    }
    setImmediate(() => {
      callback(res)
      if (resp.body !== undefined && resp.body !== null && !resp.bodyBuffer && !resp.bodyChunks) {
        res.emit('data', Buffer.from(JSON.stringify(resp.body)))
      }
      res.emit('end')
    })
    const req = new EE() as any
    req.destroy = () => { res.__aborted = true }
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
/** A stat that satisfies both the AppImage file guard and assertPrivateDir. */
const statLike = (over: Record<string, unknown> = {}) => ({
  isFile: () => true,
  isDirectory: () => true,
  mode: 0o700,
  uid: typeof process.getuid === 'function' ? process.getuid() : 0,
  ...over,
})
const mockLstatSync = vi.fn(() => statLike())
const mockSymlinkSync = vi.fn()
// #174 stages downloads in a private mkdtemp directory instead of ~/Downloads,
// so the transport half now touches mkdtemp/readdir/rm. Deterministic suffix:
// several tests assert on the returned path.
const mockMkdtempSync = vi.fn((prefix: string) => `${prefix}TEST`)
const mockReaddirSync = vi.fn((): string[] => [])
const mockRmSync = vi.fn()
const mockStatSync = vi.fn(() => ({ size: 256 }))
const mockReadFileSync = vi.fn()
// Bytes actually written into the .part file across all streams this test made.
// #174's cap has to hold ON THE WIRE, so "how much landed" is the observable
// that distinguishes an abort from a post-hoc size check.
const writtenBytes = { total: 0 }
const mockWriteStreamBytes = (): number => writtenBytes.total
vi.mock('fs', () => {
  const { EventEmitter: EE } = require('events')
  return {
    chmodSync: (...a: any[]) => mockChmodSync(...a),
    copyFileSync: (...a: any[]) => mockCopyFileSync(...a),
    realpathSync: (...a: any[]) => mockRealpathSync(...a),
    lstatSync: (...a: any[]) => mockLstatSync(...a),
    symlinkSync: (...a: any[]) => mockSymlinkSync(...a),
    existsSync: (...a: any[]) => mockExistsSync(...a),
    readFileSync: (...a: any[]) => mockReadFileSync(...a),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    createWriteStream: (path: string) => {
      mockCreateWriteStream(path)
      const stream = new EE() as any
      stream.closed = false
      stream.write = vi.fn((chunk: Buffer | string) => {
        writtenBytes.total += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length
        return true
      })
      stream.close = (cb?: () => void) => {
        stream.closed = true
        if (cb) cb()
      }
      return stream
    },
    unlinkSync: (...a: any[]) => mockUnlinkSync(...a),
    renameSync: (...a: any[]) => mockRenameSync(...a),
    mkdtempSync: (...a: any[]) => mockMkdtempSync(...(a as [string])),
    readdirSync: (...a: any[]) => mockReaddirSync(...a),
    rmSync: (...a: any[]) => mockRmSync(...a),
    statSync: (...a: any[]) => mockStatSync(...a),
    truncateSync: vi.fn(),
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
// #174 stages installers under the app's own data dir (not Electron's userData:
// that is %APPDATA%, which roams).
vi.mock('../../src/main/data-paths', () => ({
  getDataDirectory: () => '/mock/dataDir',
}))

vi.mock('../../src/main/config-manager', () => ({
  readConfig: vi.fn(() => ({ updateChannel: currentChannel })),
}))
vi.mock('../../src/main/debug-logger', () => ({
  logInfo: vi.fn(),
  logError: vi.fn(),
}))

import { checkGitHubRelease, downloadGitHubRelease, downloadInstallerFile, InstallerIntegrityError, installerExtForPlatform, prepareLinuxAppImageUpdate, isPathOnNoexecMount } from '../../src/main/github-update'

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
    httpsState.destroyed = 0
    currentChannel = 'stable'
    mockReadRegistry.mockReturnValue(null)
    mockExistsSync.mockReturnValue(true)
    mockMkdtempSync.mockImplementation((prefix: string) => `${prefix}TEST`)
    mockReaddirSync.mockReturnValue([])
    mockStatSync.mockReturnValue({ size: 256 })
    mockReadFileSync.mockReturnValue('')
    writtenBytes.total = 0
  })

  // ── #174: where a download is staged, and how big it is allowed to get ──
  describe('installer staging directory (#174)', () => {
    const ASSET = 'ClaudeCommandCenter-Beta-1.2.125.exe'

    it('does NOT stage the installer in ~/Downloads', async () => {
      // The whole point of #174. The file is about to be spawned with
      // allowElevation, and ~/Downloads is a predictable path in a directory
      // every browser writes into, so any local process can drop a payload
      // there and win the verify->spawn race for admin.
      httpsState.nextResponse = { statusCode: 200, bodyBuffer: Buffer.from('installer bytes') }
      const result = await downloadInstallerFile('v1.2.125', ASSET, 'https://x/y.exe')
      expect(result).not.toBeNull()
      expect(result!.replace(/\\/g, '/').toLowerCase()).not.toContain('/downloads/')
    })

    it('stages it in an owner-only mkdtemp directory under the app data dir', async () => {
      httpsState.nextResponse = { statusCode: 200, bodyBuffer: Buffer.from('installer bytes') }
      const result = await downloadInstallerFile('v1.2.125', ASSET, 'https://x/y.exe')
      expect(mockMkdtempSync).toHaveBeenCalled()
      // mkdtemp, not a fixed name: the asset name is public, so a predictable
      // directory would hand the race straight back.
      expect(mockMkdtempSync.mock.calls[0][0].replace(/\\/g, '/')).toContain('/updates/ccc-upd-')
      expect(mockChmodSync).toHaveBeenCalledWith(expect.stringContaining('ccc-upd-'), 0o700)
      expect(result!.replace(/\\/g, '/')).toContain('/ccc-upd-')
      expect(result).toContain(ASSET)
    })

    it('passes the staging directory, not ~/Downloads, to the gh CLI fallback', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => cb(null, '', ''))
      const result = await downloadInstallerFile('v1.2.125', ASSET, null)
      expect(result).not.toBeNull()
      const args = mockExecFile.mock.calls[0][1] as string[]
      const dir = args[args.indexOf('--dir') + 1]
      expect(dir.replace(/\\/g, '/')).toContain('/ccc-upd-')
      expect(dir.replace(/\\/g, '/').toLowerCase()).not.toContain('/downloads/')
    })

    it('refuses an asset name that would escape the staging directory', async () => {
      // assetName comes from the release feed and is interpolated into a path.
      // A separator in it would write outside the private directory and undo
      // the containment.
      for (const bad of ['../evil.exe', 'sub/dir/evil.exe', '..\\evil.exe', '', '.', '..']) {
        const result = await downloadInstallerFile('v1.2.125', bad, 'https://x/y.exe')
        expect(result, `accepted ${JSON.stringify(bad)}`).toBeNull()
      }
    })

    it('prunes staging directories left by earlier updates, keeping the current one', async () => {
      // The success path cannot clean up after itself — CCC spawns the installer
      // and exits — so pruning on the way in is what bounds the accumulation.
      mockReaddirSync.mockReturnValue(['ccc-upd-OLD1', 'ccc-upd-OLD2', 'ccc-upd-TEST', 'something-else'])
      httpsState.nextResponse = { statusCode: 200, bodyBuffer: Buffer.from('installer bytes') }
      await downloadInstallerFile('v1.2.125', ASSET, 'https://x/y.exe')
      const removed = mockRmSync.mock.calls.map((c) => String(c[0]).replace(/\\/g, '/'))
      expect(removed.some((p) => p.endsWith('ccc-upd-OLD1'))).toBe(true)
      expect(removed.some((p) => p.endsWith('ccc-upd-OLD2'))).toBe(true)
      // Never the directory this download is using, and never an unrelated one.
      expect(removed.some((p) => p.endsWith('ccc-upd-TEST'))).toBe(false)
      expect(removed.some((p) => p.endsWith('something-else'))).toBe(false)
    })

    it('removes its own staging directory when nothing could be downloaded', async () => {
      httpsState.nextResponse = { statusCode: 500 }
      mockExistsSync.mockReturnValue(false)
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => cb(new Error('gh missing'), '', ''))
      const result = await downloadInstallerFile('v1.2.125', ASSET, 'https://x/y.exe')
      expect(result).toBeNull()
      const removed = mockRmSync.mock.calls.map((c) => String(c[0]).replace(/\\/g, '/'))
      expect(removed.some((p) => p.endsWith('ccc-upd-TEST'))).toBe(true)
    })
  })

  describe('manifest download size cap (#174)', () => {
    const ASSET = 'ClaudeCommandCenter-Beta-1.2.125.exe'
    const MiB = 1024 * 1024

    // The manifest fetch is the capped one: readManifest enforced
    // MAX_MANIFEST_BYTES by stat-ing the FINISHED file, so a hostile endpoint
    // could fill the disk before the check ever ran. Driven through
    // downloadGitHubRelease rather than a helper, because the cap has to hold at
    // the call site that actually fetches.
    const failGh = () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => cb(new Error('gh missing'), '', ''))
    }

    it('aborts a manifest that exceeds the cap mid-stream, before it lands', async () => {
      failGh()
      const chunk = Buffer.alloc(512 * 1024, 0x61)
      httpsState.nextResponse = { statusCode: 200, bodyChunks: [chunk, chunk, chunk, chunk] } // 2 MiB
      await expect(
        downloadGitHubRelease('v1.2.125', ASSET, 'https://h/r/download/v1.2.125/' + ASSET)
      ).rejects.toThrow(InstallerIntegrityError)
      // Enforced ON THE WIRE: the stream is destroyed partway, so not every
      // chunk reaches the file. Landing 2 MiB and then rejecting it would pass a
      // stat-based check just as well and is exactly what this replaced.
      const written = mockWriteStreamBytes()
      expect(written).toBeGreaterThan(0)
      expect(written).toBeLessThan(4 * 512 * 1024)
      expect(written).toBeLessThanOrEqual(MiB + chunk.length)
    })

    it('rejects an oversized Content-Length without reading any body', async () => {
      failGh()
      httpsState.nextResponse = {
        statusCode: 200,
        headers: { 'content-length': String(50 * MiB) },
        bodyChunks: [Buffer.alloc(1024, 0x61)],
      }
      await expect(
        downloadGitHubRelease('v1.2.125', ASSET, 'https://h/r/download/v1.2.125/' + ASSET)
      ).rejects.toThrow(InstallerIntegrityError)
      expect(mockWriteStreamBytes()).toBe(0)
    })

    it('stages CHECKSUMS.txt in a private directory, not the shared temp dir', async () => {
      // The manifest decides WHICH DIGEST counts as verified, so it was the last
      // file that should have been left at a Date.now()-guessable name in a
      // shared /tmp: the sticky bit stops another user unlinking our entry, not
      // pre-planting a symlink that createWriteStream (no O_NOFOLLOW) follows —
      // after which renameSync moves the LINK to the destination and the
      // attacker still owns the bytes readManifest reads.
      failGh()
      httpsState.nextResponse = { statusCode: 200, bodyBuffer: Buffer.from('nope') }
      await expect(
        downloadGitHubRelease('v1.2.125', ASSET, 'https://h/r/download/v1.2.125/' + ASSET)
      ).rejects.toThrow(InstallerIntegrityError)
      const manifestWrites = mockCreateWriteStream.mock.calls
        .map((c) => String(c[0]).replace(/\\/g, '/'))
        .filter((p) => p.includes('CHECKSUMS.txt'))
      expect(manifestWrites.length).toBeGreaterThan(0)
      for (const p of manifestWrites) expect(p).toContain('/ccc-upd-')
    })

    it('does NOT apply the manifest cap to the installer download', async () => {
      // The cap's SCOPE, pinned. Real installers are 170-215 MB; applying
      // MAX_MANIFEST_BYTES (1 MiB) to them is a one-token change that breaks
      // 100% of updates — and every other download test here uses a 15-byte
      // body, so nothing else in the suite could tell the difference.
      const chunk = Buffer.alloc(512 * 1024, 0x62)
      httpsState.nextResponse = { statusCode: 200, bodyChunks: [chunk, chunk, chunk, chunk, chunk, chunk] } // 3 MiB
      const result = await downloadInstallerFile('v1.2.125', ASSET, 'https://x/y.exe')
      expect(result).not.toBeNull()
      expect(mockWriteStreamBytes()).toBe(6 * 512 * 1024)
    })

    it('still accepts a normal manifest', async () => {
      // Guards the cap against being so eager it blocks every real release.
      const digest = 'a'.repeat(64)
      const manifest = `${digest}  ${ASSET}\n`
      mockReadFileSync.mockReturnValue(manifest)
      mockStatSync.mockReturnValue({ size: manifest.length })
      httpsState.responses = [
        { statusCode: 200, bodyBuffer: Buffer.from(manifest) },   // CHECKSUMS.txt
        { statusCode: 200, bodyBuffer: Buffer.from('installer') }, // the installer
      ]
      // sha256 of the body will not match `digest`, so this must fail on the
      // DIGEST, not on the size — proving the manifest was fetched and parsed.
      await expect(
        downloadGitHubRelease('v1.2.125', ASSET, 'https://h/r/download/v1.2.125/' + ASSET)
      ).rejects.toThrow(/failed its SHA-256 check/)
    })
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

  describe('downloadGitHubRelease (verified path) -- #111', () => {
    // The transport half above is deliberately unverified. THIS is the function
    // the app calls, and its contract is that it never returns a path it has
    // not checked. Every one of these asserts the fail-closed direction: if a
    // digest cannot be established, nothing is downloaded and nothing is
    // returned -- an exception is raised instead, so the caller cannot mistake
    // it for "no update available".
    it('throws rather than downloading when CHECKSUMS.txt cannot be fetched', async () => {
      // Manifest fetch fails (404), gh CLI fallback also fails.
      httpsState.nextResponse = { statusCode: 404, body: null as any }
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
        cb(new Error('gh not available'), '', '')
      })
      await expect(
        downloadGitHubRelease('v1.2.125', 'ClaudeCommandCenter-Beta-1.2.125.exe', 'https://x/y.exe')
      ).rejects.toThrow(InstallerIntegrityError)
    })

    it('names the asset and the release in the failure, not the network', async () => {
      httpsState.nextResponse = { statusCode: 404, body: null as any }
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
        cb(new Error('gh not available'), '', '')
      })
      // Regression guard for the real complaint in review: an integrity failure
      // used to surface as "check your internet connection".
      await expect(
        downloadGitHubRelease('v1.2.125', 'ClaudeCommandCenter-Beta-1.2.125.exe', 'https://x/y.exe')
      ).rejects.toThrow(/ClaudeCommandCenter-Beta-1\.2\.125\.exe.*v1\.2\.125/)
    })

    it('does not attempt the installer download at all when unverifiable', async () => {
      httpsState.nextResponse = { statusCode: 404, body: null as any }
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
        cb(new Error('gh not available'), '', '')
      })
      httpsState.callUrls = []
      await expect(
        downloadGitHubRelease('v1.2.125', 'ClaudeCommandCenter-Beta-1.2.125.exe', 'https://x/y.exe')
      ).rejects.toThrow(InstallerIntegrityError)
      // Only the CHECKSUMS.txt URL should ever have been requested -- the point
      // of resolving the digest first is to not pull 150 MB we cannot check.
      expect(httpsState.callUrls.every((u: string) => u.endsWith('/CHECKSUMS.txt'))).toBe(true)
    })
  })

  describe('downloadInstallerFile (transport half)', () => {
    // #111 split verification out of downloadGitHubRelease. These five cases
    // always tested the TRANSPORT -- redirects, gh fallback, stale-path
    // handling -- so they target the transport function directly. Verification
    // has its own coverage in github-update-integrity.test.ts.
    it('downloads via direct HTTPS when directUrl is provided', async () => {
      httpsState.nextResponse = {
        statusCode: 200,
        bodyBuffer: Buffer.from('fake installer bytes'),
      }
      const result = await downloadInstallerFile('v1.2.125', 'ClaudeCommandCenter-Beta-1.2.125.exe', 'https://x/y.exe')
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
      const result = await downloadInstallerFile('v1.2.125', 'ClaudeCommandCenter-Beta-1.2.125.exe', 'https://x/redirect.exe')
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
      const result = await downloadInstallerFile('v1.2.125', 'ClaudeCommandCenter-Beta-1.2.125.exe', 'https://x/redirect.exe')
      expect(result).toBeNull()
    })

    it('DESTROYS an abandoned redirect response instead of draining it', async () => {
      // resume() drains a 3xx body and discards it — uncounted against maxBytes,
      // and unreachable by fail() because activeReq is nulled before recursing.
      // A 3xx with an endless body would then have the main process read and
      // throw away data forever, on up to `hopsLeft` leaked sockets, past the
      // point the promise settled. (#174 adversarial review.)
      httpsState.responses = [
        { statusCode: 302, headers: { location: 'https://cdn.example.com/real.exe' }, bodyChunks: [Buffer.alloc(4096, 0x63)] },
        { statusCode: 200, bodyBuffer: Buffer.from('final bytes') },
      ]
      const result = await downloadInstallerFile('v1.2.125', 'ClaudeCommandCenter-Beta-1.2.125.exe', 'https://x/redirect.exe')
      expect(result).not.toBeNull()
      expect(httpsState.destroyed).toBeGreaterThanOrEqual(1)
    })

    it('resolves relative redirect against the source URL', async () => {
      httpsState.responses = [
        { statusCode: 302, headers: { location: '/assets/real-file.exe' } },
        { statusCode: 200, bodyBuffer: Buffer.from('final bytes') },
      ]
      const result = await downloadInstallerFile('v1.2.125', 'ClaudeCommandCenter-Beta-1.2.125.exe', 'https://origin.example.com/redirect.exe')
      expect(result).not.toBeNull()
      expect(httpsState.callUrls[1]).toBe('https://origin.example.com/assets/real-file.exe')
    })

    it('falls back to gh CLI when direct download fails (no directUrl)', async () => {
      mockExecFile.mockImplementation((_cmd: string, _args: string[], _opts: any, cb: any) => {
        cb(null, '', '')  // gh exits cleanly
      })
      mockExistsSync.mockReturnValue(true)
      const result = await downloadInstallerFile('v1.2.125', 'ClaudeCommandCenter-Beta-1.2.125.exe', null)
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
      const result = await downloadInstallerFile('v1.2.125', 'ClaudeCommandCenter-Beta-1.2.125.exe', 'https://x/y.exe')
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
      const result = await downloadInstallerFile('v1.2.125', 'ClaudeCommandCenter-Beta-1.2.125.exe', 'https://x/y.exe')
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
    // A post-#174 download path: inside a private ccc-upd- staging directory,
    // which is prune-eligible. The `ccc-upd-` component is load-bearing — it is
    // what tells prepareLinuxAppImageUpdate the file must be parked elsewhere
    // before the next update's prune deletes it.
    const downloaded = '/mock/dataDir/updates/ccc-upd-AbC123/ClaudeCommandCenter-2.1.0-beta.2-linux-x86_64.AppImage'
    const running = '/home/u/Apps/ClaudeCommandCenter-2.1.0-beta.1-linux-x86_64.AppImage'

    beforeEach(() => {
      // vi.clearAllMocks() clears CALLS but keeps implementations — a throwing
      // mockImplementation from one test would otherwise leak into the next.
      mockChmodSync.mockReset()
      mockCopyFileSync.mockReset()
      mockUnlinkSync.mockReset()
      mockSymlinkSync.mockReset()
      mockRealpathSync.mockReset().mockImplementation((p: string) => p)
      mockLstatSync.mockReset().mockReturnValue(statLike())
    })

    it('always chmods the download executable (downloads arrive without +x)', () => {
      prepareLinuxAppImageUpdate(downloaded, undefined)
      expect(mockChmodSync).toHaveBeenCalledWith(downloaded, 0o755)
    })

    it('without $APPIMAGE (extracted/dev run), parks the AppImage OUTSIDE the staging root', () => {
      // #174 made this matter: the download now lands in a prune-eligible
      // ccc-upd- directory, so returning it unchanged would have the NEXT
      // update delete the running application. Parked under the data dir
      // instead, at a stable name so a .desktop entry or dock pin survives.
      const result = prepareLinuxAppImageUpdate(downloaded, undefined)
      expect(result?.replace(/\\/g, '/')).toBe(`/mock/dataDir/bin/${downloaded.split('/').pop()}`)
      expect(result?.replace(/\\/g, '/')).not.toContain('/ccc-upd-')
      expect(mockCopyFileSync).toHaveBeenCalledWith(downloaded, result)
      // The running AppImage is never touched on this path — there isn't one.
      expect(mockUnlinkSync).not.toHaveBeenCalled()
    })

    it('falls back to the download location when parking itself fails', () => {
      // Never block an update on tidy-up: launching from the staging dir works
      // today, it is only the next prune that would remove it.
      mockCopyFileSync.mockImplementation(() => { throw new Error('EACCES') })
      expect(prepareLinuxAppImageUpdate(downloaded, undefined)).toBe(downloaded)
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

    it('finding #4 — refuses a $APPIMAGE that is not an AppImage file (never writes to it)', () => {
      const stranger = '/home/u/important.txt'
      mockRealpathSync.mockReturnValue(stranger)
      const result = prepareLinuxAppImageUpdate(downloaded, stranger)
      // Parked, not left in the staging root (#174) — but the stranger file is
      // still never unlinked and never written to, which is the guarantee.
      expect(result?.replace(/\\/g, '/')).toContain('/mock/dataDir/bin/')
      expect(mockUnlinkSync).not.toHaveBeenCalled()
      expect(mockCopyFileSync.mock.calls.some(([, dest]) => dest === stranger)).toBe(false)
    })

    it('finding #4 — refuses a $APPIMAGE that is a directory', () => {
      mockLstatSync.mockReturnValue(statLike({ isFile: () => false }))
      const result = prepareLinuxAppImageUpdate(downloaded, '/home/u/Apps')
      expect(result?.replace(/\\/g, '/')).toContain('/mock/dataDir/bin/')
      expect(mockUnlinkSync).not.toHaveBeenCalled()
      expect(mockCopyFileSync.mock.calls.some(([, dest]) => String(dest).includes('/home/u/Apps'))).toBe(false)
    })

    it('when $APPIMAGE no longer resolves (realpath throws), parks the download', () => {
      mockRealpathSync.mockImplementation(() => { throw new Error('ENOENT') })
      const result = prepareLinuxAppImageUpdate(downloaded, running)
      expect(result?.replace(/\\/g, '/')).toContain('/mock/dataDir/bin/')
      expect(mockCopyFileSync.mock.calls.some(([, dest]) => dest === running)).toBe(false)
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
