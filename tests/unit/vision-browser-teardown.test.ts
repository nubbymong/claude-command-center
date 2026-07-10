// Leak fix: any browser CCC spawns is detached + unref'd, so without an explicit
// kill it survives app quit forever (orphan process tree + an open CDP debug port,
// showing as a blank window). These tests verify launchBrowser tracks the pid of
// whatever it spawned — headless OR headed, since both are CCC's own child — and
// that killSpawnedBrowser / stopGlobalVision tear it down, killing the old one
// before a relaunch. (A browser the USER opened themselves never comes through
// launchBrowser, so it is never tracked/killed — but that path isn't exercised here.)
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Capture spawn() calls and hand back controllable fake children with pids.
const spawnCalls: Array<{ executable: string; args: string[]; opts: any }> = []
let nextPid = 1000
const execSyncCalls: string[] = []

vi.mock('child_process', () => ({
  spawn: (executable: string, args: string[], opts: any) => {
    spawnCalls.push({ executable, args, opts })
    return { pid: nextPid++, on: vi.fn(), unref: vi.fn() }
  },
  execSync: (cmd: string) => { execSyncCalls.push(cmd) },
}))
// fs.existsSync(false) forces launchBrowser onto the platform fallback executable
// name (no real browser path needed) — spawn is mocked anyway.
vi.mock('fs', () => ({ existsSync: () => false }))
vi.mock('../../src/main/conductor-mcp-server', () => ({ getConductorMcpPort: () => 19333 }))
vi.mock('../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/res' }))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

const { launchBrowser, killSpawnedBrowser, stopGlobalVision, startGlobalVision, maybeAutoRelaunchBrowser, _resetAutoRelaunchForTest, _setCdpForTest } = await import('../../src/main/vision-manager')

// launchBrowser now ALSO fires an orphan sweep (powershell/pkill) via execSync on
// every launch, so tests that count kill commands must filter to the DIRECT
// tracked-pid kill (`taskkill /pid <n>` on Windows) and ignore sweep commands.
const directKills = () => execSyncCalls.filter((c) => !c.startsWith('powershell') && !c.startsWith('pkill'))
const sweepCalls = () => execSyncCalls.filter((c) => c.startsWith('powershell') || c.startsWith('pkill'))

describe('vision browser teardown (leak fix)', () => {
  beforeEach(() => {
    spawnCalls.length = 0
    execSyncCalls.length = 0
    nextPid = 1000
    // Clear any tracked pid from a prior test so killSpawnedBrowser is a no-op.
    killSpawnedBrowser()
    execSyncCalls.length = 0
  })

  it('tracks the CCC-spawned headless browser and kills its tree on teardown', () => {
    const { pid } = launchBrowser('chrome', 9222, undefined, true)
    expect(pid).toBe(1000)
    killSpawnedBrowser()
    if (process.platform === 'win32') {
      expect(directKills()).toHaveLength(1)
      expect(directKills()[0]).toContain('taskkill')
      expect(directKills()[0]).toContain('1000')
    }
    // Idempotent: a second teardown does nothing.
    execSyncCalls.length = 0
    killSpawnedBrowser()
    expect(directKills()).toHaveLength(0)
  })

  it('tracks and kills a CCC-spawned HEADED browser too (the boot-spawn leak fix)', () => {
    // launchBrowser is ALWAYS CCC spawning its own detached child — headless or
    // headed. A headed one that leaked a blank window and outlived the app was the
    // bug, so it must be tracked + killed like any CCC-spawned browser.
    const { pid } = launchBrowser('chrome', 9222, undefined, false)
    expect(pid).toBe(1000)
    killSpawnedBrowser()
    if (process.platform === 'win32') {
      expect(directKills()).toHaveLength(1)
      expect(directKills()[0]).toContain('taskkill')
      expect(directKills()[0]).toContain('1000')
    }
  })

  it('sweeps orphaned debug browsers (by profile signature) on every launch', () => {
    launchBrowser('chrome', 9222, undefined, true)
    // The sweep is the cross-restart safety net: a crashed CCC loses the tracked
    // pid, so the next launch must kill any process holding our debug profile.
    expect(sweepCalls().some((c) => c.includes('debug-9222'))).toBe(true)
  })

  it('kills the previous headless browser before relaunching a new one', () => {
    launchBrowser('chrome', 9222, undefined, true) // pid 1000
    expect(spawnCalls).toHaveLength(1)
    launchBrowser('chrome', 9222, undefined, true) // should kill 1000, spawn pid 1001
    if (process.platform === 'win32') {
      // One taskkill for the old pid happened during the second launch.
      expect(execSyncCalls.some(c => c.includes('1000'))).toBe(true)
    }
    expect(spawnCalls).toHaveLength(2)
  })

  it('stopGlobalVision tears down the spawned browser', async () => {
    launchBrowser('chrome', 9222, undefined, true)
    await stopGlobalVision()
    if (process.platform === 'win32') {
      expect(directKills().some(c => c.includes('taskkill'))).toBe(true)
    }
  })

  it('auto-relaunches the browser when the heartbeat finds it gone (cooldown-limited)', async () => {
    // Fake CDP that never connects — mirrors "browser died before first connect",
    // the case that previously left the Vision panel on "Browser launching…" forever.
    _setCdpForTest(() => Promise.reject(new Error('no browser')))
    _resetAutoRelaunchForTest()
    try {
      await startGlobalVision({ browser: 'chrome', debugPort: 9222, headless: true } as any, () => null)
      spawnCalls.length = 0

      expect(maybeAutoRelaunchBrowser(9222)).toBe(true)   // relaunch attempted...
      expect(spawnCalls).toHaveLength(1)                   // ...and a browser spawned
      expect(maybeAutoRelaunchBrowser(9222)).toBe(false)  // cooldown blocks a storm
      expect(spawnCalls).toHaveLength(1)
      expect(maybeAutoRelaunchBrowser(9333)).toBe(false)  // wrong port → not ours
    } finally {
      await stopGlobalVision()
      _setCdpForTest(null)
      _resetAutoRelaunchForTest()
    }
  })

  it('does NOT auto-relaunch when vision is not running (no global config)', () => {
    _resetAutoRelaunchForTest()
    spawnCalls.length = 0
    expect(maybeAutoRelaunchBrowser(9222)).toBe(false)
    expect(spawnCalls).toHaveLength(0)
  })
})
