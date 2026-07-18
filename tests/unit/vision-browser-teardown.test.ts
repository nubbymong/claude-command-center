// Leak fix + boot resilience: any browser CCC spawns is detached + unref'd, so
// without an explicit kill it survives app quit forever (orphan tree + open CDP
// port, blank window). These tests verify launchBrowser tracks the spawned pid,
// killSpawnedBrowser/stopGlobalVision tear it down, and the launch/relaunch path
// AWAITS the kill (serialised so the respawn never races the port) WITHOUT the
// execSync event-loop freeze, with a circuit breaker so a crash-looping browser
// can never storm or wedge boot.
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Capture spawn() calls and hand back controllable fake children with pids.
// Kill spawns (taskkill/powershell/pkill) do NOT consume a browser pid, and emit
// 'close' on a microtask so runKillAwait resolves promptly.
const spawnCalls: Array<{ executable: string; args: string[]; opts: any }> = []
let nextPid = 1000
const execSyncCalls: string[] = []
const KILL_RE = /taskkill|powershell|pkill/i

vi.mock('child_process', () => ({
  spawn: (executable: string, args: string[], opts: any) => {
    spawnCalls.push({ executable, args, opts })
    const isKill = KILL_RE.test(executable)
    return {
      pid: isKill ? undefined : nextPid++,
      on: (ev: string, cb: (code?: number) => void) => { if (ev === 'close') queueMicrotask(() => cb(0)) },
      unref: () => {},
    }
  },
  execSync: (cmd: string) => { execSyncCalls.push(cmd) },
}))
// Control whether isPortListening() sees the debug port as in use.
const netState = vi.hoisted(() => ({ portListening: true }))
vi.mock('net', () => ({
  Socket: class {
    private handlers: Record<string, (arg?: unknown) => void> = {}
    setTimeout() { /* noop */ }
    once(ev: string, cb: (arg?: unknown) => void) { this.handlers[ev] = cb; return this }
    connect() {
      queueMicrotask(() => {
        if (netState.portListening) this.handlers['connect']?.()
        else this.handlers['error']?.(new Error('ECONNREFUSED'))
      })
    }
    destroy() { /* noop */ }
  },
}))
vi.mock('fs', () => ({ existsSync: () => false }))
vi.mock('../../src/main/conductor-mcp-server', () => ({ getConductorMcpPort: () => 19333 }))
vi.mock('../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/res' }))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }))

const {
  launchBrowser, killSpawnedBrowser, stopGlobalVision, startGlobalVision,
  maybeAutoRelaunchBrowser, _resetAutoRelaunchForTest, _clearRelaunchCooldownForTest, _setCdpForTest,
} = await import('../../src/main/vision-manager')

// Let the fire-and-forget launchBrowser (async: awaits kills, then spawns) settle.
const flush = () => new Promise((r) => setTimeout(r, 0))

// The launch/relaunch path now kills via awaited spawn (non-blocking). The SYNC
// killSpawnedBrowser (quit/stop) still uses execSync.
const directKills = () => execSyncCalls.filter((c) => !c.startsWith('powershell') && !c.startsWith('pkill'))
const browserSpawns = () => spawnCalls.filter((c) => !KILL_RE.test(c.executable))
const killSpawnStrings = () => spawnCalls.filter((c) => KILL_RE.test(c.executable)).map((c) => `${c.executable} ${c.args.join(' ')}`)

describe('vision browser teardown + boot resilience', () => {
  beforeEach(() => {
    spawnCalls.length = 0
    execSyncCalls.length = 0
    nextPid = 1000
    netState.portListening = true // default: an orphan holds the port → sweep runs
    _resetAutoRelaunchForTest()
    killSpawnedBrowser() // clear any tracked pid from a prior test
    execSyncCalls.length = 0
    spawnCalls.length = 0
  })

  it('tracks the CCC-spawned headless browser and kills its tree on teardown (sync)', async () => {
    const { pid } = await launchBrowser('chrome', 9222, undefined, true)
    expect(pid).toBe(1000)
    killSpawnedBrowser()
    if (process.platform === 'win32') {
      expect(directKills()).toHaveLength(1)
      expect(directKills()[0]).toContain('taskkill')
      expect(directKills()[0]).toContain('1000')
    }
    execSyncCalls.length = 0
    killSpawnedBrowser() // idempotent
    expect(directKills()).toHaveLength(0)
  })

  it('tracks and kills a CCC-spawned HEADED browser too (boot-spawn leak fix)', async () => {
    const { pid } = await launchBrowser('chrome', 9222, undefined, false)
    expect(pid).toBe(1000)
    killSpawnedBrowser()
    if (process.platform === 'win32') {
      expect(directKills()).toHaveLength(1)
      expect(directKills()[0]).toContain('taskkill')
      expect(directKills()[0]).toContain('1000')
    }
  })

  it('sweeps the debug PORT via an AWAITED spawn (fast, not execSync/CIM)', async () => {
    await launchBrowser('chrome', 9222, undefined, true)
    // The sweep must go through spawn (the resilience fix) — never execSync,
    // which froze the event loop / boot — and it targets the port (fast), not a
    // Win32_Process command-line scan (pathologically slow).
    expect(killSpawnStrings().some((c) => c.includes('9222'))).toBe(true)
    expect(killSpawnStrings().some((c) => c.includes('Win32_Process'))).toBe(false)
    expect(execSyncCalls.some((c) => c.startsWith('powershell') || c.startsWith('pkill'))).toBe(false)
  })

  it('skips the port sweep entirely when nothing is listening (fast boot path)', async () => {
    netState.portListening = false // port free → no orphan → no kill spawn
    await launchBrowser('chrome', 9222, undefined, true)
    expect(killSpawnStrings().some((c) => c.includes('9222'))).toBe(false)
    expect(browserSpawns()).toHaveLength(1) // browser still launches
  })

  it('kills the previous browser before relaunching — serialised, no execSync freeze', async () => {
    await launchBrowser('chrome', 9222, undefined, true) // pid 1000
    expect(browserSpawns()).toHaveLength(1)
    await launchBrowser('chrome', 9222, undefined, true) // kills 1000 (awaited spawn), spawns 1001
    if (process.platform === 'win32') {
      expect(killSpawnStrings().some((c) => c.includes('taskkill') && c.includes('1000'))).toBe(true)
    }
    expect(browserSpawns()).toHaveLength(2)
    expect(directKills().some((c) => c.includes('1000'))).toBe(false) // not a blocking execSync
  })

  it('stopGlobalVision tears down the spawned browser (sync kill on stop)', async () => {
    await launchBrowser('chrome', 9222, undefined, true)
    await stopGlobalVision()
    if (process.platform === 'win32') {
      expect(directKills().some((c) => c.includes('taskkill'))).toBe(true)
    }
  })

  it('auto-relaunches when the heartbeat finds it gone, then backs off', async () => {
    _setCdpForTest(() => Promise.reject(new Error('no browser')))
    _resetAutoRelaunchForTest()
    try {
      await startGlobalVision({ browser: 'chrome', debugPort: 9222, headless: true } as any, () => null)
      spawnCalls.length = 0

      expect(maybeAutoRelaunchBrowser(9222)).toBe(true)   // attempt 1 → relaunch (async)
      await flush()
      expect(browserSpawns()).toHaveLength(1)
      expect(maybeAutoRelaunchBrowser(9222)).toBe(false)  // backoff blocks an immediate retry
      await flush()
      expect(browserSpawns()).toHaveLength(1)
      expect(maybeAutoRelaunchBrowser(9333)).toBe(false)  // wrong port → not ours
    } finally {
      await stopGlobalVision()
      _setCdpForTest(null)
      _resetAutoRelaunchForTest()
    }
  })

  it('circuit breaker: disables auto-relaunch after repeated failures', async () => {
    _setCdpForTest(() => Promise.reject(new Error('no browser')))
    _resetAutoRelaunchForTest()
    try {
      await startGlobalVision({ browser: 'chrome', debugPort: 9222, headless: true } as any, () => null)
      // MAX_RELAUNCH_ATTEMPTS is 4: four attempts succeed, the fifth trips the breaker.
      let attempts = 0
      for (let i = 0; i < 4; i++) {
        _clearRelaunchCooldownForTest()
        if (maybeAutoRelaunchBrowser(9222)) attempts++
      }
      expect(attempts).toBe(4)
      _clearRelaunchCooldownForTest()
      expect(maybeAutoRelaunchBrowser(9222)).toBe(false) // breaker tripped
      _clearRelaunchCooldownForTest()
      expect(maybeAutoRelaunchBrowser(9222)).toBe(false) // still disabled
      _resetAutoRelaunchForTest() // manual Start / reconnect re-arms
      _clearRelaunchCooldownForTest()
      expect(maybeAutoRelaunchBrowser(9222)).toBe(true)
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
    expect(browserSpawns()).toHaveLength(0)
  })
})
