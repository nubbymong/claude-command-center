// The vision browser the app starts is detached, so the app ends it itself: at
// stop, at quit and before a relaunch. A browser the app left from an earlier
// run (after a crash) still holds the debug port, so the next launch ends it.
// Every one of those ends a process only once it is verified as the app's own
// vision browser by its name, its command line and its creation time, and the
// kill re-checks the creation time of that same pid. While the debug port
// stays in use, the launch stops with VisionPortHeldError and starts
// nothing. A pid alone is never enough.
//
// The OS here is a fake process table behind the injected OwnerPorts, and
// child_process / net are replaced: no test in this file starts a program.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as path from 'path'
import * as nodeOs from 'os'
import type { OwnerPorts } from '../../src/main/vision-browser-owner'

interface Proc { name: string; commandLine: string; created: string; port: number | null }

const sys = vi.hoisted(() => {
  const s = {
    platform: 'win32' as NodeJS.Platform,
    procs: new Map<number, { name: string; commandLine: string; created: string; port: number | null }>(),
    nextPid: 1000,
    nextCreated: 1,
    failReads: false,
    /** Set to make the next browser the app spawns look like another program. */
    spawnAs: null as null | { name?: string },
    runs: [] as Array<{ file: string; args: string[]; sync: boolean }>,
    signals: [] as Array<[number, string]>,
    browserSpawns: [] as Array<{ executable: string; args: string[] }>,
    created(): string {
      const n = s.nextCreated++
      return s.platform === 'win32' ? `13370000000000${String(1000 + n)}` : `Wed Oct  1 10:${String(10 + (n % 50))}:00 2026`
    },
    commandLine(exe: string, args: string[]): string {
      return [exe, ...args].map((a) => (s.platform === 'win32' && /\s/.test(a) ? `"${a}"` : a)).join(' ')
    },
  }
  return s
})
const log = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }))

vi.mock('child_process', () => ({
  spawn: (executable: string, args: string[]) => {
    sys.browserSpawns.push({ executable, args })
    const pid = sys.nextPid++
    const portArg = args.find((a) => a.startsWith('--remote-debugging-port='))
    sys.procs.set(pid, {
      name: sys.spawnAs?.name ?? (sys.platform === 'win32' ? 'chrome.exe' : 'chrome'),
      commandLine: sys.commandLine(executable, args),
      created: sys.created(),
      port: portArg ? Number(portArg.split('=')[1]) : null,
    })
    return { pid, on: () => {}, unref: () => {} }
  },
  execSync: () => { throw new Error('test: execSync must not run') },
  execFileSync: () => { throw new Error('test: execFileSync must not run') },
}))
// isPortListening: a port is held while a process in the table listens on it.
vi.mock('net', () => ({
  Socket: class {
    private handlers: Record<string, (arg?: unknown) => void> = {}
    setTimeout() { /* noop */ }
    once(ev: string, cb: (arg?: unknown) => void) { this.handlers[ev] = cb; return this }
    connect(port: number) {
      queueMicrotask(() => {
        const held = [...sys.procs.values()].some((p) => p.port === port)
        if (held) this.handlers['connect']?.()
        else this.handlers['error']?.(new Error('ECONNREFUSED'))
      })
    }
    destroy() { /* noop */ }
  },
}))
vi.mock('fs', () => ({ existsSync: () => false }))
vi.mock('../../src/main/conductor-mcp-server', () => ({ getConductorMcpPort: () => 19333 }))
vi.mock('../../src/main/ipc/setup-handlers', () => ({ getResourcesDirectory: () => '/res' }))
vi.mock('../../src/main/debug-logger', () => ({ logInfo: log.info, logError: log.error }))

const {
  launchBrowser, killSpawnedBrowser, stopGlobalVision, startGlobalVision, VisionPortHeldError,
  maybeAutoRelaunchBrowser, _resetAutoRelaunchForTest, _clearRelaunchCooldownForTest, _setCdpForTest,
  _setVisionOwnerPortsForTest,
} = await import('../../src/main/vision-manager')

/** What the OS answers, from the table: the PowerShell scripts on Windows
 *  (read by what they ask), lsof and ps elsewhere. The kill script ends the
 *  pid only when its creation-time comparison (if it has one) holds, exactly
 *  as the real script would. */
function answer(file: string, args: string[]): string {
  if (sys.failReads) throw new Error('timed out')
  if (sys.platform === 'win32') {
    expect(file).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/)
    const script = args[args.length - 1]
    if (/taskkill/.test(script)) {
      const pid = Number(/ProcessId=(\d+)/.exec(script)?.[1])
      const want = /-eq '(\d+)'/.exec(script)
      const p = sys.procs.get(pid)
      if (p && (!want || p.created === want[1])) { sys.procs.delete(pid); return 'ended\r\n' }
      return 'left\r\n'
    }
    const listen = /Get-NetTCPConnection[^\n]*-LocalPort (\d+)/.exec(script)
    const pids = listen
      ? [...sys.procs].filter(([, p]) => p.port === Number(listen[1])).map(([pid]) => pid)
      : [Number(/\$ids = @\((\d+)\)/.exec(script)?.[1])]
    const out = pids.filter((pid) => sys.procs.has(pid)).map((pid) => {
      const p = sys.procs.get(pid) as Proc
      return { pid, name: p.name, commandLine: p.commandLine, created: p.created }
    })
    return Buffer.from(JSON.stringify(out), 'utf8').toString('base64')
  }
  if (file.endsWith('lsof')) {
    const port = Number(args.find((a) => a.startsWith('-iTCP:'))?.slice(6))
    const pids = [...sys.procs].filter(([, p]) => p.port === port).map(([pid]) => pid)
    if (pids.length === 0) throw new Error('exited with status 1')
    return pids.join('\n') + '\n'
  }
  expect(file).toMatch(/\/ps$/)
  const p = sys.procs.get(Number(args[args.indexOf('-p') + 1]))
  if (!p) throw new Error('exited with status 1')
  const field = args[args.indexOf('-o') + 1]
  return `${field === 'comm=' ? p.name : field === 'args=' ? p.commandLine : p.created}\n`
}

const fakePorts: OwnerPorts = {
  get platform() { return sys.platform },
  systemRoot: 'C:\\Windows',
  run: async (file, args) => { sys.runs.push({ file, args, sync: false }); return answer(file, args) },
  runSync: (file, args) => { sys.runs.push({ file, args, sync: true }); return answer(file, args) },
  signal: (pid, sig) => {
    sys.signals.push([pid, sig])
    if (!sys.procs.has(Math.abs(pid))) throw new Error('ESRCH')
    sys.procs.delete(Math.abs(pid))
  },
  exists: () => true,
}

const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)) }
const tmp = () => process.env.TEMP || process.env.TMP || nodeOs.tmpdir()
const scriptOf = (r: { args: string[] }) => r.args[r.args.length - 1]
/** Every kill the app asked the OS for: a taskkill script, or a signal. */
const killScripts = () => sys.runs.filter((r) => /taskkill/.test(scriptOf(r)))
const listenerQueries = () => sys.runs.filter((r) => /Get-NetTCPConnection/.test(scriptOf(r)) || r.file.endsWith('lsof'))

function addProc(pid: number, opts: { name?: string; profile?: string; port?: number; portArg?: number; extra?: string[] } = {}): void {
  const exe = sys.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/opt/google/chrome/chrome'
  const args = [
    `--remote-debugging-port=${opts.portArg ?? 9222}`, '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${opts.profile ?? path.join(tmp(), 'chrome-debug-9222')}`, '--headless=new', ...(opts.extra ?? []),
  ]
  sys.procs.set(pid, {
    name: opts.name ?? (sys.platform === 'win32' ? 'chrome.exe' : 'chrome'),
    commandLine: sys.commandLine(exe, args),
    created: sys.created(),
    port: opts.port === undefined ? 9222 : opts.port,
  })
}

describe.each(['win32', 'linux'] as const)('vision browser teardown and launch (%s)', (platform) => {
  beforeEach(() => {
    sys.platform = platform
    _setVisionOwnerPortsForTest(fakePorts)
    _resetAutoRelaunchForTest()
    killSpawnedBrowser() // drop anything tracked by an earlier test
    sys.procs.clear()
    sys.nextPid = 1000
    sys.failReads = false
    sys.spawnAs = null
    sys.runs.length = 0
    sys.signals.length = 0
    sys.browserSpawns.length = 0
    log.info.mockClear()
  })

  it('ends the browser it started at quit, verified by its creation time (sync)', async () => {
    const { pid } = await launchBrowser('chrome', 9222, undefined, true)
    expect(pid).toBe(1000)
    await flush()
    expect(sys.procs.has(1000)).toBe(true)
    sys.runs.length = 0
    killSpawnedBrowser()
    expect(sys.procs.has(1000)).toBe(false)
    expect(sys.runs.every((r) => r.sync)).toBe(true)
    if (platform === 'win32') {
      expect(killScripts()).toHaveLength(1)
      expect(scriptOf(killScripts()[0])).toContain('ProcessId=1000')
    } else {
      expect(sys.signals).toEqual([[-1000, 'SIGTERM']])
    }
    sys.runs.length = 0
    sys.signals.length = 0
    killSpawnedBrowser() // idempotent
    expect(sys.runs).toHaveLength(0)
    expect(sys.signals).toHaveLength(0)
  })

  it('ends a HEADED browser it started too', async () => {
    await launchBrowser('chrome', 9222, undefined, false)
    await flush()
    killSpawnedBrowser()
    expect(sys.procs.has(1000)).toBe(false)
  })

  it('stopGlobalVision ends the browser it started', async () => {
    await launchBrowser('chrome', 9222, undefined, true)
    await flush()
    await stopGlobalVision()
    expect(sys.procs.has(1000)).toBe(false)
  })

  it('a relaunch ends the previous browser, verified, before it spawns the next', async () => {
    await launchBrowser('chrome', 9222, undefined, true)
    await flush()
    await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.procs.has(1000)).toBe(false)
    expect(sys.procs.has(1001)).toBe(true)
    expect(sys.browserSpawns).toHaveLength(2)
  })

  it('at quit, a tracked pid that now has another creation time is not ended', async () => {
    await launchBrowser('chrome', 9222, undefined, true)
    await flush()
    // The browser exited and its pid now belongs to another process: same pid,
    // same name and command line, another creation time.
    const before = sys.procs.get(1000) as Proc
    sys.procs.set(1000, { ...before, created: sys.created(), port: null })
    killSpawnedBrowser()
    expect(sys.procs.has(1000)).toBe(true)
    expect(sys.signals).toHaveLength(0)
  })

  it('at relaunch, a tracked pid that now has another creation time is not ended', async () => {
    await launchBrowser('chrome', 9222, undefined, true)
    await flush()
    const before = sys.procs.get(1000) as Proc
    sys.procs.set(1000, { ...before, created: sys.created(), port: null })
    await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.procs.has(1000)).toBe(true)
    expect(sys.browserSpawns).toHaveLength(2)
    expect(killScripts()).toHaveLength(0)
    expect(sys.signals).toHaveLength(0)
  })

  it('a browser whose facts could not be read after spawn is never ended by pid', async () => {
    sys.failReads = true
    await launchBrowser('chrome', 9222, undefined, true)
    await flush()
    sys.failReads = false
    sys.runs.length = 0
    killSpawnedBrowser()
    expect(sys.procs.has(1000)).toBe(true)
    expect(sys.runs).toHaveLength(0)
    expect(sys.signals).toHaveLength(0)
    expect(log.info.mock.calls.some(([m]) => /pid 1000/.test(String(m)) && /not verified/.test(String(m)))).toBe(true)
  })

  it('at relaunch, a browser whose facts could not be read after spawn is left running, and says so', async () => {
    sys.failReads = true
    await launchBrowser('chrome', 9222, undefined, true)
    await flush()
    sys.failReads = false
    const p = sys.procs.get(1000) as Proc
    sys.procs.set(1000, { ...p, port: null }) // it no longer holds the port
    await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.procs.has(1000)).toBe(true)
    expect(sys.browserSpawns).toHaveLength(2)
    expect(killScripts()).toHaveLength(0)
    expect(sys.signals).toHaveLength(0)
    expect(log.info.mock.calls.some(([m]) => /pid 1000/.test(String(m)) && /not verified/.test(String(m)))).toBe(true)
  })

  it('a spawned pid that does not verify as the app vision browser is never ended by pid', async () => {
    sys.spawnAs = { name: platform === 'win32' ? 'notepad.exe' : 'node' }
    await launchBrowser('chrome', 9222, undefined, true)
    await flush()
    sys.spawnAs = null
    killSpawnedBrowser()
    expect(sys.procs.has(1000)).toBe(true)
    expect(killScripts()).toHaveLength(0)
    expect(sys.signals).toHaveLength(0)
  })

  it('ends a browser the app left from an earlier run on the port, verified, then launches', async () => {
    addProc(500)
    addProc(501, { profile: path.join(tmp(), 'edge-debug-9222'), port: 9222 })
    await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.procs.has(500)).toBe(false)
    expect(sys.procs.has(501)).toBe(false)
    expect(sys.browserSpawns).toHaveLength(1)
    expect(listenerQueries()).toHaveLength(1)
    if (platform === 'win32') {
      expect(killScripts().map((r) => /ProcessId=(\d+)/.exec(scriptOf(r))?.[1]).sort()).toEqual(['500', '501'])
    } else {
      expect(sys.signals.map(([p]) => p).sort((a, b) => a - b)).toEqual([-501, -500])
    }
  })

  it('a program on the port that is not identified as the app vision browser is left running; the launch throws and spawns nothing', async () => {
    addProc(600, { profile: path.join(tmp(), 'MyOwnProfile') })                    // another profile
    addProc(601, { name: platform === 'win32' ? 'node.exe' : 'node' })            // not a browser
    addProc(602, { extra: ['--type=renderer'] })                                   // not a main browser process
    addProc(603, { portArg: 92220 })                                               // another port argument
    addProc(604, { profile: `${path.join(tmp(), 'chrome-debug-9222')}-x` })       // another profile folder
    const err = await launchBrowser('chrome', 9222, undefined, true).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(VisionPortHeldError)
    expect((err as Error).message).toBe("the vision browser's debug port 9222 is in use; vision was not started")
    for (const pid of [600, 601, 602, 603, 604]) expect(sys.procs.has(pid), String(pid)).toBe(true)
    expect(sys.browserSpawns).toHaveLength(0)
    expect(killScripts()).toHaveLength(0)
    expect(sys.signals).toHaveLength(0)
  })

  it('a listener whose facts cannot be read is not ended, and the launch throws', async () => {
    addProc(500)
    sys.failReads = true
    const err = await launchBrowser('chrome', 9222, undefined, true).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(VisionPortHeldError)
    expect(sys.procs.has(500)).toBe(true)
    expect(sys.browserSpawns).toHaveLength(0)
    expect(sys.signals).toHaveLength(0)
  })

  it('asks the OS nothing about listeners when the port is free (fast path)', async () => {
    await launchBrowser('chrome', 9222, undefined, true)
    expect(listenerQueries()).toHaveLength(0)
    expect(sys.browserSpawns).toHaveLength(1)
  })

  it('auto-relaunches when the heartbeat finds it gone, then backs off', async () => {
    _setCdpForTest(() => Promise.reject(new Error('no browser')))
    try {
      await startGlobalVision({ browser: 'chrome', debugPort: 9222, headless: true } as any, () => null)
      expect(maybeAutoRelaunchBrowser(9222)).toBe(true)   // attempt 1: relaunch (async)
      await flush()
      expect(sys.browserSpawns).toHaveLength(1)
      expect(maybeAutoRelaunchBrowser(9222)).toBe(false)  // backoff blocks an immediate retry
      await flush()
      expect(sys.browserSpawns).toHaveLength(1)
      expect(maybeAutoRelaunchBrowser(9333)).toBe(false)  // another port: not this vision
    } finally {
      await stopGlobalVision()
      _setCdpForTest(null)
      _resetAutoRelaunchForTest()
    }
  })

  it('circuit breaker: disables auto-relaunch after repeated failures', async () => {
    _setCdpForTest(() => Promise.reject(new Error('no browser')))
    try {
      await startGlobalVision({ browser: 'chrome', debugPort: 9222, headless: true } as any, () => null)
      // MAX_RELAUNCH_ATTEMPTS is 4: four attempts go ahead, the fifth trips the breaker.
      let attempts = 0
      for (let i = 0; i < 4; i++) {
        _clearRelaunchCooldownForTest()
        if (maybeAutoRelaunchBrowser(9222)) attempts++
      }
      expect(attempts).toBe(4)
      _clearRelaunchCooldownForTest()
      expect(maybeAutoRelaunchBrowser(9222)).toBe(false) // breaker tripped
      _clearRelaunchCooldownForTest()
      expect(maybeAutoRelaunchBrowser(9222)).toBe(false) // still off
      _resetAutoRelaunchForTest() // Start / a reconnect re-arms it
      _clearRelaunchCooldownForTest()
      expect(maybeAutoRelaunchBrowser(9222)).toBe(true)
      await flush()
    } finally {
      await stopGlobalVision()
      _setCdpForTest(null)
      _resetAutoRelaunchForTest()
    }
  })

  it('does not auto-relaunch when vision is not running (no global config)', () => {
    expect(maybeAutoRelaunchBrowser(9222)).toBe(false)
    expect(sys.browserSpawns).toHaveLength(0)
  })
})
