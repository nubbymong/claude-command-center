/**
 * [host] Electron 44 needs macOS 13. The updater never offers a Mac a release
 * its macOS is too old to open, and offers it the newest release it can run
 * instead; the packaged app declares the same floor (LSMinimumSystemVersion,
 * from package.json build.mac.minimumSystemVersion).
 *
 * Builds before that floor match only Mac downloads named
 * `ClaudeCommandCenter-*` or `AI-Code-Conductor-*`, and have no floor check of
 * their own. So a Mac download that needs macOS 13 is named so that they never
 * match it (package.json build.mac.artifactName): a Mac on one of them is
 * offered nothing from such a release. That is shown against the shipped
 * update check itself (tests/fixtures/updater/shipped-update-check.ts).
 * Releases come from a faked GitHub API; nothing real is fetched.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import { shippedUpdateCheck } from '../../fixtures/updater/shipped-update-check'
import { macosFloorForTag as gateMacosFloorForTag } from '../../../scripts/release-gate.mjs'
import { expandArtifactName } from '../../../src/main/artifact-name'

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

const ROOT = path.join(__dirname, '../../..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const floorsFile = JSON.parse(fs.readFileSync(path.join(ROOT, 'resources/macos-release-floors.json'), 'utf8')) as {
  floors: Array<{ fromTag: string; electronMajor: number; macosMajor: number }>
}

/** The Mac download name electron-builder makes for `version` from package.json build.mac.artifactName (the app's own rule). */
function builtMacName(version: string): string {
  const name = expandArtifactName(String(pkg.build.mac.artifactName), { version, ext: 'dmg', arch: 'arm64' })
  if (!name) throw new Error('package.json build.mac.artifactName does not expand to a plain file name')
  return name
}
/** The Mac download name 2.1.0 to 2.1.1-beta.1 shipped under. */
const legacyMacName = (version: string) => `AI-Code-Conductor-${version}-mac.dmg`

/** A release with an installer for every platform; its Mac download named as built now, as before, or by hand. */
function release(tag: string, mac: 'built' | 'legacy' | { name: string }) {
  const v = tag.replace(/^v/, '')
  const macName = mac === 'built' ? builtMacName(v) : mac === 'legacy' ? legacyMacName(v) : mac.name
  return {
    tag_name: tag, draft: false, prerelease: /-/.test(v),
    assets: [
      { name: 'CHECKSUMS.txt', browser_download_url: `https://x/${v}/CHECKSUMS.txt` },
      { name: `AI-Code-Conductor-${v}.exe`, browser_download_url: `https://x/${v}.exe` },
      { name: macName, browser_download_url: `https://x/${v}.dmg` },
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
  h.releases = [release('v2.1.1-beta.1', 'legacy'), release('v2.1.1-beta.2', 'built'), release('v2.1.0', 'legacy')]
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

  it('the table covers every tag at or after its first Electron 44 release, the bare -beta tag release.yml cuts from a final version included', async () => {
    const u = await updaterOn(realPlatform, undefined)
    expect(floorsFile.floors.length).toBeGreaterThan(0)
    expect(u.MACOS_RELEASE_FLOORS).toEqual(floorsFile.floors.map((f) => ({ fromTag: f.fromTag, major: f.macosMajor })))
    const e44 = floorsFile.floors.find((f) => f.electronMajor === 44)
    expect(e44?.fromTag).toBe('v2.1.1-beta.2')
    const atOrAfter = [
      ...Array.from({ length: 11 }, (_, i) => `v2.1.1-beta.${i + 2}`),
      'v2.1.1-rc', 'v2.1.1-rc.0', 'v2.1.1-rc.1', 'v2.1.1-rc.9', 'v2.1.1',
      // release.yml tags a final version cut on the beta channel `v<version>-beta`:
      // package.json 2.1.1 on beta is v2.1.1-beta, which sorts below 2.1.1-beta.1.
      'v2.1.1-beta',
      'v2.1.2-beta', 'v2.1.2-beta.1', 'v2.1.2', 'v2.2.0-beta', 'v2.2.0', 'v3.0.0-rc.1',
    ]
    for (const tag of atOrAfter) expect(u.macosFloorForTag(tag), tag).toBeGreaterThanOrEqual(13)
    for (const tag of ['v2.1.1-beta.1', 'v2.1.1-beta.0', 'v2.1.0', 'v2.1.0-beta', 'v2.1.0-rc.9', 'v2.0.0']) {
      expect(u.macosFloorForTag(tag), tag).toBe(0)
    }
  })

  it('the release gate floors every tag exactly as the updater does (its copy of the rule)', async () => {
    const u = await updaterOn(realPlatform, undefined)
    const corpus = ['v2.1.0', 'v2.1.1-beta', 'v2.1.1-beta.0', 'v2.1.1-beta.1', 'v2.1.1-beta.2', 'v2.1.1-beta.10', 'v2.1.1-rc',
      'v2.1.1-rc.3', 'v2.1.1', 'v2.1.2-beta', 'v2.2.0', 'v10.0.0', 'V2.1.1', 'v2.1.1-dev', 'v2.1.1-dev.1', '2.1.1-beta.2', 'garbage', '']
    for (const tag of corpus) expect(gateMacosFloorForTag(tag, floorsFile.floors), tag).toBe(u.macosFloorForTag(tag))
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

  it('releaseRunsOnThisOs takes the floor a Mac download\'s name declares, the one decision checkGitHubRelease makes', async () => {
    const u = await updaterOn(realPlatform, undefined)
    const on14 = [{ name: 'AICodeConductor-2.2.0-beta.1-macos14.dmg' }]
    expect(u.releaseRunsOnThisOs('v2.2.0-beta.1', 'darwin', '13.6', 0, on14)).toBe(false)
    expect(u.releaseRunsOnThisOs('v2.2.0-beta.1', 'darwin', '14.1', 0, on14)).toBe(true)
    expect(u.releaseRunsOnThisOs('v2.2.0-beta.1', 'darwin', null, 13, on14)).toBe(false)
    for (const p of ['win32', 'linux'] as const) expect(u.releaseRunsOnThisOs('v2.2.0-beta.1', p, '13.6', 0, on14), p).toBe(true)
    // With no downloads named, the tag's own floor decides.
    expect(u.releaseRunsOnThisOs('v2.2.0-beta.1', 'darwin', '13.6')).toBe(true)
  })

  it('a Mac download named for an earlier macOS than its tag\'s floor still needs the tag\'s floor', async () => {
    const u = await updaterOn(realPlatform, undefined)
    const low = [{ name: 'AICodeConductor-2.1.1-beta.2-macos12.dmg' }]
    expect(u.macInstallers(low, 'v2.1.1-beta.2').map((d) => d.floor)).toEqual([13])
    expect(u.releaseRunsOnThisOs('v2.1.1-beta.2', 'darwin', '12.7.4', 0, low)).toBe(false)
    expect(u.releaseRunsOnThisOs('v2.1.1-beta.2', 'darwin', '13.0', 0, low)).toBe(true)
  })

  it('the floor of the build that is running is a lower bound: macOS opened it, so the Mac is at least that', async () => {
    const u = await updaterOn(realPlatform, undefined)
    for (const unknown of [null, undefined, '', 'Darwin']) {
      expect(u.releaseRunsOnThisOs('v2.1.1-beta.3', 'darwin', unknown, 13), String(unknown)).toBe(true)
      expect(u.releaseRunsOnThisOs('v2.1.1-beta.3', 'darwin', unknown, 0), String(unknown)).toBe(false)
    }
    expect(u.releaseRunsOnThisOs('v2.1.1-beta.3', 'darwin', '10.16', 13)).toBe(true)
    expect(u.releaseRunsOnThisOs('v2.1.1-beta.3', 'darwin', '12.7.4', 0)).toBe(false)
  })
})

describe('a Mac on a build from before the floor is offered nothing from a release that needs macOS 13 (the shipped update check)', () => {
  const ONE = [release('v2.1.0', 'legacy'), release('v2.1.1-beta.1', 'legacy'), release('v2.1.1-beta.2', 'built')]

  it('the Mac download as package.json names it is not one the shipped check matches: no offer, and no older release instead', async () => {
    for (const running of ['2.1.0', '2.1.1-beta.1']) {
      expect(await shippedUpdateCheck({ releases: ONE as never, running, channel: 'beta', platform: 'darwin' }), running).toBeNull()
    }
    const stable = [release('v2.1.0', 'legacy'), release('v2.1.1', 'built')]
    expect(await shippedUpdateCheck({ releases: stable as never, running: '2.1.0', channel: 'stable', platform: 'darwin' })).toBeNull()
  })

  it('under the name earlier releases used, the shipped check would offer it (what the new name prevents)', async () => {
    const asBefore = [release('v2.1.0', 'legacy'), release('v2.1.1-beta.1', 'legacy'), release('v2.1.1-beta.2', 'legacy')]
    const r = await shippedUpdateCheck({ releases: asBefore as never, running: '2.1.0', channel: 'beta', platform: 'darwin' })
    expect(r?.tagName).toBe('v2.1.1-beta.2')
  })

  it('Windows and Linux keep their names, so the shipped check still offers their installers', async () => {
    expect(String(pkg.build.nsis.artifactName).startsWith('AI-Code-Conductor-')).toBe(true)
    expect(String(pkg.build.linux.artifactName).startsWith('AI-Code-Conductor-')).toBe(true)
    const win = await shippedUpdateCheck({ releases: ONE as never, running: '2.1.0', channel: 'beta', platform: 'win32' })
    expect(win?.installerName).toBe('AI-Code-Conductor-2.1.1-beta.2.exe')
    const linux = await shippedUpdateCheck({ releases: ONE as never, running: '2.1.0', channel: 'beta', platform: 'linux' })
    expect(linux?.installerName).toBe('AI-Code-Conductor-2.1.1-beta.2-linux-x86_64.AppImage')
  })

  it('the Mac download name carries the floor the packaged app declares, under neither name the shipped check knows', () => {
    const name = builtMacName('2.1.1-beta.2')
    for (const prefix of ['ClaudeCommandCenter-', 'AI-Code-Conductor-']) expect(name.startsWith(prefix), prefix).toBe(false)
    const m = /-macos(\d+)\.dmg$/.exec(name)
    expect(m?.[1]).toBe(String(parseInt(String(pkg.build.mac.minimumSystemVersion), 10)))
  })
})

describe('checkGitHubRelease never offers a Mac a release it cannot open', () => {
  it('macOS 12: the newest release it can run (2.1.1-beta.1, under its own name) is offered, not 2.1.1-beta.2', async () => {
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

  it('macOS 13 and later: 2.1.1-beta.2 is offered, its Mac download as package.json names it', async () => {
    for (const v of ['13.0', '13.7.8', '15.6']) {
      const u = await updaterOn('darwin', v)
      const r = await u.checkGitHubRelease()
      expect(r?.tagName, v).toBe('v2.1.1-beta.2')
      expect(r?.installerName, v).toBe(builtMacName('2.1.1-beta.2'))
      expect(r?.installerUrl, v).toBe('https://x/2.1.1-beta.2.dmg')
    }
  })

  it('a release at or after the floor whose Mac download still has an earlier name is not offered to a Mac', async () => {
    h.releases = [release('v2.1.1-beta.2', 'legacy')]
    const u = await updaterOn('darwin', '15.6')
    expect(await u.checkGitHubRelease()).toBeNull()
  })

  it('a Mac download whose name declares a newer macOS than this Mac runs is skipped for the newest release it can run', async () => {
    h.releases = [release('v2.1.1-beta.2', 'built'), release('v2.2.0-beta.1', { name: 'AICodeConductor-2.2.0-beta.1-macos14.dmg' })]
    const on13 = await updaterOn('darwin', '13.6')
    expect((await on13.checkGitHubRelease())?.tagName).toBe('v2.1.1-beta.2')
    const on14 = await updaterOn('darwin', '14.1')
    const r = await on14.checkGitHubRelease()
    expect(r?.tagName).toBe('v2.2.0-beta.1')
    expect(r?.installerName).toBe('AICodeConductor-2.2.0-beta.1-macos14.dmg')
  })

  it('macOS 12: a release that needs macOS 13 is not offered under a download named for macOS 12; the newest release it can run is', async () => {
    h.releases = [release('v2.1.1-beta.1', 'legacy'), release('v2.1.1-beta.2', { name: 'AICodeConductor-2.1.1-beta.2-macos12.dmg' })]
    const u = await updaterOn('darwin', '12.7.4')
    const r = await u.checkGitHubRelease()
    expect(r?.tagName).toBe('v2.1.1-beta.1')
    expect(r?.installerName).toBe('AI-Code-Conductor-2.1.1-beta.1-mac.dmg')
  })

  it('a release carrying both kinds of Mac download gives each Mac the newest build it can open', async () => {
    // e.g. an earlier release re-published with a floored build beside its old one
    const both = release('v2.1.1-beta.1', 'legacy')
    both.assets.push({ name: 'AICodeConductor-2.1.1-beta.1-macos13.dmg', browser_download_url: 'https://x/2.1.1-beta.1-macos13.dmg' })
    h.releases = [both]
    const on13 = await updaterOn('darwin', '13.2')
    expect((await on13.checkGitHubRelease())?.installerName).toBe('AICodeConductor-2.1.1-beta.1-macos13.dmg')
    const on12 = await updaterOn('darwin', '12.7.4')
    expect((await on12.checkGitHubRelease())?.installerName).toBe('AI-Code-Conductor-2.1.1-beta.1-mac.dmg')
  })

  it('a macOS version that cannot be read (or throws) gets no floored release on a build with no floor', async () => {
    for (const v of [undefined, () => { throw new Error('no version') }, () => 'garbage'] as const) {
      const u = await updaterOn('darwin', v)
      expect((await u.checkGitHubRelease())?.tagName).toBe('v2.1.1-beta.1')
    }
  })

  it('on a build that needs macOS 13 an unreadable macOS version still gets updates: the running build proves 13', async () => {
    h.running = '2.1.1-beta.2'
    h.releases = [release('v2.1.1-beta.2', 'built'), release('v2.1.1-beta.3', 'built'), release('v2.1.1', 'built')]
    for (const v of [undefined, () => { throw new Error('no version') }, () => 'garbage'] as const) {
      const u = await updaterOn('darwin', v)
      const r = await u.checkGitHubRelease()
      expect(r?.tagName).toBe('v2.1.1')
      expect(r?.installerName).toBe(builtMacName('2.1.1'))
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
  it('package.json build.mac.minimumSystemVersion (LSMinimumSystemVersion) is the newest floor in MACOS_RELEASE_FLOORS', async () => {
    const u = await updaterOn(realPlatform, undefined)
    const newest = Math.max(0, ...u.MACOS_RELEASE_FLOORS.map((f) => f.major))
    expect(pkg.build?.mac?.minimumSystemVersion).toBe(`${newest}.0`)
  })

  it('the Feature Guide, the release notes and the README tell a Mac on an earlier version what to do, and no longer say it will be offered this release', () => {
    const knowledge = fs.readFileSync(path.join(ROOT, 'src/shared/app-knowledge.ts'), 'utf8')
    const changelog = fs.readFileSync(path.join(ROOT, 'src/renderer/changelog.ts'), 'utf8')
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
    expect(knowledge).not.toMatch(/can still offer this update/)
    for (const text of [knowledge, changelog, readme]) {
      expect(text).toMatch(/On macOS 12, stay on 2\.1\.1-beta\.1\./)
      expect(text).toMatch(/On macOS 13 or later, download .{1,40}\.dmg from the Releases page on GitHub once by hand/)
    }
    for (const text of [knowledge, changelog]) expect(text).toMatch(/ending in macos13\.dmg/)
    expect(readme).toMatch(/AICodeConductor-x\.y\.z-macos13\.dmg/)
    expect(builtMacName('2.1.1-beta.2').endsWith('macos13.dmg')).toBe(true)
  })

  it('an Electron of 44 or later is packaged with a floor of macOS 13 or later', () => {
    const electronMajor = parseInt(String(pkg.devDependencies?.electron ?? '').replace(/^[^\d]*/, ''), 10)
    expect(electronMajor).toBeGreaterThanOrEqual(44)
    expect(parseInt(String(pkg.build?.mac?.minimumSystemVersion ?? '0'), 10)).toBeGreaterThanOrEqual(13)
  })
})
