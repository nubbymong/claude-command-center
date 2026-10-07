/**
 * [host] The dev-only local-installer fallback of `update:installAndRestart`
 * (an unpackaged build, no GitHub release) finds a Mac build under the name
 * package.json's build.mac.artifactName gives it, as electron-builder names it
 * (AICodeConductor-<version>-macosNN.dmg since the macOS 13 floor), and still
 * under the earlier AI-Code-Conductor-<version>-mac.dmg. Everything is faked:
 * no file is read, copied or opened.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import * as path from 'path'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const s = vi.hoisted(() => ({
  present: new Set<string>(),
  copies: [] as Array<[string, string]>,
  opened: [] as Array<{ cmd: string; args: string[] }>,
  pkg: { version: '2.1.1-beta.2', build: { mac: { artifactName: 'AICodeConductor-${version}-macos13.${ext}' } } } as unknown,
}))

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
  dialog: { showErrorBox: vi.fn(), showOpenDialog: vi.fn() },
  app: { exit: vi.fn(), getVersion: () => '2.1.1', getPath: () => '/mock/userData' },
  BrowserWindow: { getAllWindows: () => [] },
}))
vi.mock('child_process', () => ({
  spawn: (cmd: string, args: string[]) => {
    s.opened.push({ cmd, args })
    const child = new EventEmitter() as EventEmitter & { unref: () => void }
    child.unref = () => {}
    setImmediate(() => child.emit('spawn'))
    return child
  },
  execFile: vi.fn(),
  spawnSync: vi.fn(),
}))
vi.mock('../../../src/main/github-update', () => ({
  checkGitHubRelease: async () => null,
  downloadGitHubRelease: async () => null,
  stillMatchesDigest: async () => true,
  prepareLinuxAppImageUpdate: async (p: string) => p,
  isPathOnNoexecMount: () => false,
  createInstallerDir: () => '/stage',
  InstallerIntegrityError: class extends Error {},
}))
vi.mock('fs', () => ({
  existsSync: (p: string) => s.present.has(p),
  readFileSync: () => JSON.stringify(s.pkg),
  copyFileSync: (from: string, to: string) => { s.copies.push([from, to]); s.present.add(to) },
  mkdirSync: vi.fn(),
  accessSync: vi.fn(),
  constants: { X_OK: 1 },
}))
vi.mock('../../../src/main/update-watcher', () => ({
  checkForUpdatesOnDemand: vi.fn(),
  markUpdateInstalled: vi.fn(),
  getProjectRootPath: () => '/proj',
  setSourcePathInRegistry: vi.fn(),
  isPackagedApp: () => false,
  hasSourcePath: () => false,
  isStoreBuild: () => false,
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/pty-manager', () => ({ killAllPty: vi.fn() }))

import { registerUpdateHandlers } from '../../../src/main/ipc/update-handlers'

const realPlatform = process.platform
const realArch = process.arch
const PKG = s.pkg
beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
  handlers.clear(); s.present.clear(); s.copies.length = 0; s.opened.length = 0; s.pkg = PKG
  registerUpdateHandlers()
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  Object.defineProperty(process, 'arch', { value: realArch, configurable: true })
})

const install = () => Promise.resolve(handlers.get('update:installAndRestart')!())

describe('the dev-only local installer on a Mac', () => {
  it('is found in dist/ under the name build.mac.artifactName gives this version, and opened', async () => {
    const built = path.join('/proj', 'dist', 'AICodeConductor-2.1.1-beta.2-macos13.dmg')
    s.present.add(built)
    await expect(install()).resolves.toBe(true)
    expect(s.copies).toEqual([[built, path.join('/stage', 'AICodeConductor-2.1.1-beta.2-macos13.dmg')]])
    expect(s.opened).toEqual([{ cmd: 'open', args: [path.join('/stage', 'AICodeConductor-2.1.1-beta.2-macos13.dmg')] }])
  })

  it('a template naming ${arch} is expanded with this Mac\'s architecture, as electron-builder names the build', async () => {
    s.pkg = { version: '2.1.1-beta.2', build: { mac: { artifactName: 'AICodeConductor-${version}-macos13-${arch}.${ext}' } } }
    Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true })
    const built = path.join('/proj', 'dist', 'AICodeConductor-2.1.1-beta.2-macos13-arm64.dmg')
    s.present.add(built)
    await expect(install()).resolves.toBe(true)
    expect(s.copies).toEqual([[built, path.join('/stage', 'AICodeConductor-2.1.1-beta.2-macos13-arm64.dmg')]])
  })

  it('a template that does not expand to a plain file name is not looked for', async () => {
    s.pkg = { version: '2.1.1-beta.2', build: { mac: { artifactName: '${productName}-${version}.${ext}' } } }
    s.present.add(path.join('/proj', 'dist', '${productName}-2.1.1-beta.2.dmg'))
    await expect(install()).rejects.toThrow(/Installer not found/)
    expect(s.copies).toEqual([])
  })

  it('a dist/ built under the earlier name is still found', async () => {
    const earlier = path.join('/proj', 'dist', 'AI-Code-Conductor-2.1.1-beta.2-mac.dmg')
    s.present.add(earlier)
    await expect(install()).resolves.toBe(true)
    expect(s.copies[0][0]).toBe(earlier)
  })
})
