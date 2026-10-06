/**
 * [host] Electron 44 needs macOS 13. The updater never offers a Mac a release
 * its macOS is too old to open, and offers it the newest release it can run
 * instead; the packaged app declares the same floor (LSMinimumSystemVersion,
 * from package.json build.mac.minimumSystemVersion). Releases come from a
 * faked GitHub API; nothing real is fetched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'

const h = vi.hoisted(() => ({ releases: [] as unknown[], channel: 'beta', running: '2.1.0' }))

vi.mock('https', () => {
  const { EventEmitter: EE } = require('events')
  const get = (_url: string, _opts: unknown, cb: (res: unknown) => void) => {
    const res = new EE()
    res.statusCode = 200
    res.headers = {}
    setImmediate(() => {
      cb(res)
      res.emit('data', Buffer.from(JSON.stringify(h.releases)))
      res.emit('end')
    })
    return new EE()
  }
  return { default: { get }, get }
})
vi.mock('electron', () => ({ app: { getVersion: () => h.running, getPath: () => '/mock/userData' } }))
vi.mock('../../../src/main/config-manager', () => ({ readConfig: () => ({ updateChannel: h.channel }) }))
vi.mock('../../../src/main/registry', () => ({ readRegistry: () => null, writeRegistry: () => true }))
vi.mock('../../../src/main/data-paths', () => ({ getDataDirectory: () => '/mock/dataDir' }))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: () => {}, logError: () => {} }))

/** A release with an installer for every platform, under both asset prefixes' rules. */
function release(tag: string) {
  const v = tag.replace(/^v/, '')
  return {
    tag_name: tag, draft: false, prerelease: /-/.test(v),
    assets: [
      { name: `AI-Code-Conductor-${v}.exe`, browser_download_url: `https://x/${v}.exe` },
      { name: `AI-Code-Conductor-${v}-mac.dmg`, browser_download_url: `https://x/${v}.dmg` },
      { name: `AI-Code-Conductor-${v}-linux-x86_64.AppImage`, browser_download_url: `https://x/${v}.AppImage` },
    ],
  }
}

const realPlatform = process.platform
const proc = process as unknown as { getSystemVersion?: () => string }
const realGetSystemVersion = proc.getSystemVersion

/** The updater module as it loads on `platform` (its installer extension is fixed at load). */
async function updaterOn(platform: NodeJS.Platform, systemVersion: string | undefined | (() => string)) {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  if (systemVersion === undefined) delete proc.getSystemVersion
  else proc.getSystemVersion = typeof systemVersion === 'function' ? systemVersion : () => systemVersion
  vi.resetModules()
  return import('../../../src/main/github-update')
}

beforeEach(() => {
  h.channel = 'beta'
  h.running = '2.1.0'
  h.releases = [release('v2.1.1-beta.1'), release('v2.1.1-beta.2'), release('v2.1.0')]
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  if (realGetSystemVersion) proc.getSystemVersion = realGetSystemVersion
  else delete proc.getSystemVersion
})

describe('the macOS floor of each release', () => {
  it('releases from the first Electron 44 one need macOS 13; earlier ones need nothing', async () => {
    const u = await updaterOn(realPlatform, undefined)
    expect(u.macosFloorForTag('v2.1.0')).toBe(0)
    expect(u.macosFloorForTag('v2.1.1-beta.1')).toBe(0)
    expect(u.macosFloorForTag('v2.1.1-beta.2')).toBe(13)
    expect(u.macosFloorForTag('v2.1.1-rc.1')).toBe(13)
    expect(u.macosFloorForTag('v2.1.1')).toBe(13)
    expect(u.macosFloorForTag('v2.2.0-beta.1')).toBe(13)
  })

  it('a Mac runs a release at or above its floor; any other OS runs every release; an unreadable macOS version runs no floored release', async () => {
    const u = await updaterOn(realPlatform, undefined)
    expect(u.releaseRunsOnThisOs('v2.1.1-beta.2', 'darwin', '12.7.4')).toBe(false)
    expect(u.releaseRunsOnThisOs('v2.1.1-beta.2', 'darwin', '13.0')).toBe(true)
    expect(u.releaseRunsOnThisOs('v2.1.1-beta.2', 'darwin', '26.1')).toBe(true)
    expect(u.releaseRunsOnThisOs('v2.1.1-beta.2', 'darwin', '10.15.7')).toBe(false)
    for (const unknown of [null, undefined, '', 'Darwin', '.13']) {
      expect(u.releaseRunsOnThisOs('v2.1.1-beta.2', 'darwin', unknown), String(unknown)).toBe(false)
      expect(u.releaseRunsOnThisOs('v2.1.1-beta.1', 'darwin', unknown), String(unknown)).toBe(true)
    }
    for (const p of ['win32', 'linux'] as const) {
      expect(u.releaseRunsOnThisOs('v2.1.1-beta.2', p, '12.7.4'), p).toBe(true)
      expect(u.releaseRunsOnThisOs('v2.1.1-beta.2', p, null), p).toBe(true)
    }
  })
})

describe('checkGitHubRelease never offers a Mac a release it cannot open', () => {
  it('macOS 12: the newest release it can run (2.1.1-beta.1) is offered, not 2.1.1-beta.2', async () => {
    const u = await updaterOn('darwin', '12.7.4')
    const r = await u.checkGitHubRelease()
    expect(r?.tagName).toBe('v2.1.1-beta.1')
    expect(r?.installerName).toBe('AI-Code-Conductor-2.1.1-beta.1-mac.dmg')
  })

  it('macOS 12 already on the newest release it can run: no update at all', async () => {
    h.running = '2.1.1-beta.1'
    const u = await updaterOn('darwin', '12.7.4')
    expect(await u.checkGitHubRelease()).toBeNull()
  })

  it('macOS 13 and later: 2.1.1-beta.2 is offered', async () => {
    for (const v of ['13.0', '13.7.8', '15.6']) {
      const u = await updaterOn('darwin', v)
      expect((await u.checkGitHubRelease())?.tagName, v).toBe('v2.1.1-beta.2')
    }
  })

  it('a macOS version that cannot be read (or throws) gets no floored release', async () => {
    for (const v of [undefined, () => { throw new Error('no version') }, () => 'garbage'] as const) {
      const u = await updaterOn('darwin', v)
      expect((await u.checkGitHubRelease())?.tagName).toBe('v2.1.1-beta.1')
    }
  })

  it('Windows and Linux are unaffected: 2.1.1-beta.2 is offered whatever the version string says', async () => {
    for (const p of ['win32', 'linux'] as const) {
      const u = await updaterOn(p, '12.7.4')
      expect((await u.checkGitHubRelease())?.tagName, p).toBe('v2.1.1-beta.2')
    }
  })
})

describe('the packaged app declares the floor the updater applies', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../../../package.json'), 'utf8'))

  it('package.json build.mac.minimumSystemVersion (LSMinimumSystemVersion) is the newest floor in MACOS_RELEASE_FLOORS', async () => {
    const u = await updaterOn(realPlatform, undefined)
    const newest = Math.max(0, ...u.MACOS_RELEASE_FLOORS.map((f) => f.major))
    expect(pkg.build?.mac?.minimumSystemVersion).toBe(`${newest}.0`)
  })

  it('an Electron of 44 or later is packaged with a floor of macOS 13 or later', () => {
    const electronMajor = parseInt(String(pkg.devDependencies?.electron ?? '').replace(/^[^\d]*/, ''), 10)
    expect(electronMajor).toBeGreaterThanOrEqual(44)
    expect(parseInt(String(pkg.build?.mac?.minimumSystemVersion ?? '0'), 10)).toBeGreaterThanOrEqual(13)
  })
})
