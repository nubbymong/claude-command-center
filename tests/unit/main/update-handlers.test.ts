/**
 * `update:installAndRestart` -- the handler that kills every PTY and hands a
 * verified installer to the OS with elevation.
 *
 * This file exists because the adversarial pass on #174 found it did not: the
 * change added a spawn handshake on two platforms, two error dialogs, a
 * reentrancy latch and a post-copy digest re-check, and NOTHING could have
 * caught their removal. That matters more here than almost anywhere else in the
 * app, because the renderer swallows this handler's rejection at every call site
 * -- so a regression is invisible by construction, not merely untested.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'

// ── Captured handler + electron surface ────────────────────────────────
const handlers = new Map<string, (...args: unknown[]) => unknown>()
const shownErrorBoxes: Array<[string, string]> = []
const exitCalls: number[] = []

vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: unknown[]) => unknown) => { handlers.set(ch, fn) } },
  dialog: {
    showErrorBox: (title: string, body: string) => { shownErrorBoxes.push([title, body]) },
    showOpenDialog: vi.fn(),
  },
  app: { exit: (code: number) => { exitCalls.push(code) }, getVersion: () => '2.1.0', getPath: () => '/mock/userData' },
  BrowserWindow: { getAllWindows: () => [] },
}))

// ── spawn ──────────────────────────────────────────────────────────────
type SpawnScript = { emit: 'spawn' | 'error' | 'nothing'; error?: Error; throwSync?: Error }
const spawnState = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: string[] }>,
  script: { emit: 'spawn' } as SpawnScript,
  unrefs: 0,
}))

vi.mock('child_process', () => ({
  spawn: (cmd: string, args: string[]) => {
    spawnState.calls.push({ cmd, args })
    if (spawnState.script.throwSync) throw spawnState.script.throwSync
    const child = new EventEmitter() as EventEmitter & { unref: () => void }
    child.unref = () => { spawnState.unrefs += 1 }
    if (spawnState.script.emit === 'spawn') setImmediate(() => child.emit('spawn'))
    if (spawnState.script.emit === 'error') setImmediate(() => child.emit('error', spawnState.script.error))
    return child
  },
  execFile: vi.fn(),
  spawnSync: vi.fn(),
}))

// ── github-update ──────────────────────────────────────────────────────
const gh = vi.hoisted(() => ({
  release: { version: '2.1.1', tagName: 'v2.1.1', installerName: 'CCC-2.1.1.exe', installerUrl: 'https://h/CCC-2.1.1.exe', channel: 'beta' } as unknown,
  verified: { path: '/mock/dataDir/updates/ccc-upd-XYZ/CCC-2.1.1.exe', sha256: 'a'.repeat(64) } as { path: string; sha256: string } | null,
  downloadError: null as Error | null,
  stillMatches: [] as boolean[],
  stillMatchesCalls: [] as string[],
  appImageResult: null as string | null,
  noexec: false,
}))

// Hoisted with the mock factory, which vitest lifts above the imports.
const { FakeIntegrityError } = vi.hoisted(() => ({
  FakeIntegrityError: class extends Error {
    constructor(m: string) { super(m); this.name = 'InstallerIntegrityError' }
  },
}))

vi.mock('../../../src/main/github-update', () => ({
  checkGitHubRelease: async () => gh.release,
  downloadGitHubRelease: async () => {
    if (gh.downloadError) throw gh.downloadError
    return gh.verified
  },
  stillMatchesDigest: async (p: string) => {
    gh.stillMatchesCalls.push(p)
    return gh.stillMatches.length ? gh.stillMatches.shift()! : true
  },
  prepareLinuxAppImageUpdate: (p: string) => gh.appImageResult ?? p,
  isPathOnNoexecMount: () => gh.noexec,
  createInstallerDir: () => '/mock/dataDir/updates/ccc-upd-DEV',
  InstallerIntegrityError: FakeIntegrityError,
}))

// ── everything else the module pulls in ────────────────────────────────
vi.mock('fs', () => ({
  existsSync: () => true,
  readFileSync: () => '{"version":"2.1.1"}',
  copyFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  accessSync: vi.fn(),
  constants: { X_OK: 1 },
}))
// update-watcher owns the "an update was installed" bookkeeping and reaches for
// app.getAppPath()/hashes. Not what this suite is about.
vi.mock('../../../src/main/update-watcher', () => ({
  checkForUpdatesOnDemand: vi.fn(),
  markUpdateInstalled: vi.fn(),
  getProjectRootPath: () => '/mock/project',
  setSourcePathInRegistry: vi.fn(),
}))
vi.mock('../../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))
vi.mock('../../../src/main/pty-manager', () => ({ killAllPty: vi.fn() }))
vi.mock('../../../src/main/registry', () => ({ readRegistry: () => null, writeRegistry: () => true }))
vi.mock('../../../src/main/data-paths', () => ({ getDataDirectory: () => '/mock/dataDir' }))

import { registerUpdateHandlers } from '../../../src/main/ipc/update-handlers'

const INSTALLER = '/mock/dataDir/updates/ccc-upd-XYZ/CCC-2.1.1.exe'

function invoke(): Promise<unknown> {
  const fn = handlers.get('update:installAndRestart')
  if (!fn) throw new Error('handler not registered')
  return Promise.resolve(fn())
}

beforeEach(() => {
  handlers.clear()
  shownErrorBoxes.length = 0
  exitCalls.length = 0
  spawnState.calls.length = 0
  spawnState.script = { emit: 'spawn' }
  spawnState.unrefs = 0
  gh.verified = { path: INSTALLER, sha256: 'a'.repeat(64) }
  gh.downloadError = null
  gh.stillMatches = []
  gh.stillMatchesCalls = []
  gh.appImageResult = null
  gh.noexec = false
  registerUpdateHandlers()
})

describe('update:installAndRestart — launch handshake', () => {
  it('waits for the child to start before exiting the app', async () => {
    await expect(invoke()).resolves.toBe(true)
    expect(spawnState.calls).toHaveLength(1)
    expect(spawnState.calls[0].cmd).toBe(INSTALLER)
    expect(exitCalls).toEqual([0])
  })

  it('does NOT exit, and tells the user, when the launch fails asynchronously', async () => {
    // spawn reports EACCES/ENOENT only via an async 'error' event. Without the
    // handshake, app.exit(0) runs first and the user is left with every PTY
    // dead, no running app, and nothing on screen. Worse: with no 'error'
    // listener the event is an UNCAUGHT EXCEPTION in the main process.
    spawnState.script = { emit: 'error', error: new Error('spawn EACCES') }
    await expect(invoke()).rejects.toThrow(/EACCES/)
    expect(exitCalls).toEqual([])
    expect(shownErrorBoxes).toHaveLength(1)
    expect(shownErrorBoxes[0][0]).toMatch(/could not be launched/i)
  })

  it('names the staged installer path so the user can run it by hand', async () => {
    // #174 moved staging out of ~/Downloads into a deliberately unpredictable
    // directory. Without this the user has nothing to fall back on.
    spawnState.script = { emit: 'error', error: new Error('spawn EACCES') }
    await expect(invoke()).rejects.toThrow()
    expect(shownErrorBoxes[0][1]).toContain(INSTALLER)
  })

  it('surfaces a synchronous spawn throw the same way', async () => {
    spawnState.script = { emit: 'nothing', throwSync: new Error('spawn UNKNOWN') }
    await expect(invoke()).rejects.toThrow(/UNKNOWN/)
    expect(exitCalls).toEqual([])
    expect(shownErrorBoxes).toHaveLength(1)
  })

  it('uses `open` for a macOS .dmg, and waits for it too', async () => {
    gh.verified = { path: '/mock/dataDir/updates/ccc-upd-XYZ/CCC-2.1.1-mac.dmg', sha256: 'a'.repeat(64) }
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      spawnState.script = { emit: 'error', error: new Error('open failed') }
      await expect(invoke()).rejects.toThrow(/open failed/)
      expect(spawnState.calls[0].cmd).toBe('open')
      // The whole point: the darwin branch was the one left without a handshake
      // or an 'error' listener, so this failure used to crash the main process.
      expect(exitCalls).toEqual([])
      expect(shownErrorBoxes).toHaveLength(1)
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })
})

describe('update:installAndRestart — verification', () => {
  it('re-hashes the installer immediately before launching it', async () => {
    await invoke()
    expect(gh.stillMatchesCalls).toContain(INSTALLER)
  })

  it('aborts without launching when the file changed after verification', async () => {
    gh.stillMatches = [false]
    await expect(invoke()).rejects.toThrow(/changed on disk/)
    expect(spawnState.calls).toHaveLength(0)
    expect(exitCalls).toEqual([])
  })

  it('re-hashes the AppImage COPY, not just the staged original', async () => {
    // prepareLinuxAppImageUpdate copies the AppImage somewhere else, so the file
    // that was verified is not the file that gets spawned. Checking only the
    // staged original leaves everything between the copy and the launch
    // unverified (#174 adversarial review).
    const staged = '/mock/dataDir/updates/ccc-upd-XYZ/CCC-2.1.1.AppImage'
    const parked = '/mock/dataDir/bin/CCC-2.1.1.AppImage'
    gh.verified = { path: staged, sha256: 'a'.repeat(64) }
    gh.appImageResult = parked
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      await invoke()
      expect(gh.stillMatchesCalls).toContain(parked)
      expect(spawnState.calls[0].cmd).toBe(parked)
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })

  it('aborts when the AppImage copy does not match the verified digest', async () => {
    const staged = '/mock/dataDir/updates/ccc-upd-XYZ/CCC-2.1.1.AppImage'
    gh.verified = { path: staged, sha256: 'a'.repeat(64) }
    gh.appImageResult = '/mock/dataDir/bin/CCC-2.1.1.AppImage'
    gh.stillMatches = [true, false] // staged ok, copy not
    const original = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      await expect(invoke()).rejects.toThrow(/does not match the verified installer/)
      expect(spawnState.calls).toHaveLength(0)
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true })
    }
  })

  it('shows the integrity dialog, and only that one, on an integrity failure', async () => {
    // The download-time integrity dialog fires before the launch try/catch, so
    // it must not be joined by a second "could not be launched" box.
    gh.downloadError = new FakeIntegrityError('CCC-2.1.1.exe has no verified SHA-256 in release v2.1.1')
    await expect(invoke()).rejects.toThrow(/no verified SHA-256/)
    expect(shownErrorBoxes).toHaveLength(1)
    expect(shownErrorBoxes[0][0]).toMatch(/integrity check failed/i)
    expect(spawnState.calls).toHaveLength(0)
  })
})

describe('update:installAndRestart — reentrancy', () => {
  it('refuses a second concurrent install', async () => {
    // Two concurrent runs each prune the staging root keeping only THEIR OWN
    // directory, so each deletes the other's in-flight installer.
    spawnState.script = { emit: 'nothing' } // first call parks on the 3s timeout
    const first = invoke()
    await expect(invoke()).rejects.toThrow(/already in progress/)
    expect(spawnState.calls).toHaveLength(1)
    await first
  }, 10000)

  it('releases the latch so a later install can run', async () => {
    spawnState.script = { emit: 'error', error: new Error('boom') }
    await expect(invoke()).rejects.toThrow()
    spawnState.script = { emit: 'spawn' }
    await expect(invoke()).resolves.toBe(true)
  })
})
