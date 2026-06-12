// Leak fix: the headless browser CCC spawns is detached + unref'd, so without an
// explicit kill it survives app quit forever (orphan process tree + an open CDP
// debug port). These tests verify launchBrowser tracks the CCC-spawned HEADLESS
// pid and that killSpawnedBrowser / stopGlobalVision tear it down — while leaving
// user-launched HEADED browsers alone, and killing the old one before a relaunch.
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

const { launchBrowser, killSpawnedBrowser, stopGlobalVision } = await import('../../src/main/vision-manager')

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
      expect(execSyncCalls).toHaveLength(1)
      expect(execSyncCalls[0]).toContain('taskkill')
      expect(execSyncCalls[0]).toContain('1000')
    }
    // Idempotent: a second teardown does nothing.
    execSyncCalls.length = 0
    killSpawnedBrowser()
    expect(execSyncCalls).toHaveLength(0)
  })

  it('does NOT track or kill a user-launched headed browser', () => {
    launchBrowser('chrome', 9222, undefined, false)
    killSpawnedBrowser()
    expect(execSyncCalls).toHaveLength(0)
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
      expect(execSyncCalls.some(c => c.includes('taskkill'))).toBe(true)
    }
  })
})
