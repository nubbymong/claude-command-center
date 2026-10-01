// The vision browser the app starts is detached, so the app ends it itself: at
// stop, at quit and before a relaunch. It is the app's own child, so while its
// exit has not been observed it is ended by its pid (taskkill /T on Windows,
// its process group on Linux and macOS), with no read-back; once its exit was
// observed nothing is done with that pid.
//
// Before every launch, browsers left by an earlier run are found by their
// profile (this port's chrome-debug-<port> or edge-debug-<port> folder),
// whether or not they listen, and ended only once identified as the app's
// vision browser by name, command line and creation time. Then the launch
// waits for the port and the profile to be free. A program on the debug port
// that is not identified as the app's vision browser is left running and the
// launch stops with VisionPortHeldError.
//
// The OS here is a fake process table behind the injected OwnerPorts, and
// child_process / net are replaced: no test in this file starts a program.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'
import * as path from 'path'
import * as nodeOs from 'os'
import type { OwnerPorts } from '../../src/main/vision-browser-owner'

interface Proc { name: string; commandLine: string; created: string; port: number | null; group: number }
type FakeChild = EventEmitter & { pid: number; exitCode: number | null; signalCode: string | null; unref: () => void }

const sys = vi.hoisted(() => {
  const s = {
    platform: 'win32' as NodeJS.Platform,
    procs: new Map<number, { name: string; commandLine: string; created: string; port: number | null; group: number }>(),
    children: new Map<number, any>(),
    nextPid: 1000,
    nextCreated: 1,
    failReads: false,
    /** How long the OS takes to answer a query; a query whose bound is shorter fails. */
    queryLatencyMs: 0,
    /** Pids that do not end on SIGTERM. */
    ignoreTerm: new Set<number>(),
    /** Pids that no kill ends. */
    unkillable: new Set<number>(),
    /** Real paths the OS reports (another spelling of a folder -> its long form). */
    /** Real time (ms) before the app observes a child's exit; 0 = next microtask. */
    exitDelayMs: 0,
    /** Called when a process ends (a pid can be taken by another process at once). */
    onEnd: null as null | ((pid: number) => void),
    realpaths: new Map<string, string>(),
    runs: [] as Array<{ file: string; args: string[]; sync: boolean; timeoutMs: number }>,
    signals: [] as Array<[number, string]>,
    events: [] as string[],
    browserSpawns: [] as Array<{ executable: string; args: string[] }>,
    sleeps: 0,
    created(): string {
      const n = s.nextCreated++
      return s.platform === 'win32' ? `13370000000000${String(1000 + n)}` : `Wed Oct  1 10:${String(10 + (n % 50))}:00 2026`
    },
    commandLine(exe: string, args: string[]): string {
      return [exe, ...args].map((a) => (s.platform === 'win32' && /\s/.test(a) ? `"${a}"` : a)).join(' ')
    },
    /** A process ends: its exit is observed by the app later, as libuv does. */
    end(pid: number, sig: string | null): void {
      if (s.unkillable.has(pid)) return
      s.procs.delete(pid)
      s.events.push(`end:${pid}`)
      const child = s.children.get(pid)
      if (child && child.exitCode === null && child.signalCode === null) {
        const observe = () => {
          if (sig) child.signalCode = sig; else child.exitCode = 1
          s.events.push(`exit-observed:${pid}`)
          child.emit('exit', child.exitCode, child.signalCode)
        }
        if (s.exitDelayMs > 0) setTimeout(observe, s.exitDelayMs)
        else queueMicrotask(observe)
      }
      s.onEnd?.(pid)
    },
  }
  return s
})
const log = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }))

vi.mock('child_process', async () => {
  const { EventEmitter: EE } = await import('events')
  return {
    spawn: (executable: string, args: string[]) => {
      sys.browserSpawns.push({ executable, args })
      const pid = sys.nextPid++
      sys.events.push(`spawn:${pid}`)
      const portArg = args.find((a) => a.startsWith('--remote-debugging-port='))
      sys.procs.set(pid, {
        name: sys.platform === 'win32' ? 'chrome.exe' : 'chrome',
        commandLine: sys.commandLine(executable, args),
        created: sys.created(),
        port: portArg ? Number(portArg.split('=')[1]) : null,
        group: pid,
      })
      const child = Object.assign(new EE(), { pid, exitCode: null, signalCode: null, unref: () => {} })
      sys.children.set(pid, child)
      return child
    },
    execSync: () => { throw new Error('test: execSync must not run') },
    execFileSync: () => { throw new Error('test: execFileSync must not run') },
  }
})
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

const TASKKILL = 'C:\\Windows\\System32\\taskkill.exe'
const isBrowser = (name: string) => ['chrome.exe', 'msedge.exe'].includes(name.toLowerCase())

/** What the OS answers, from the table: taskkill and the PowerShell scripts on
 *  Windows (read by what they ask), ps elsewhere. The verified kill script ends
 *  the pid only when its creation-time comparison holds, as the real one does. */
function answer(file: string, args: string[], timeoutMs: number): string {
  if (sys.failReads && !file.endsWith('taskkill.exe')) throw new Error('timed out')
  if (sys.queryLatencyMs > timeoutMs && !file.endsWith('taskkill.exe')) throw new Error('timed out')
  if (sys.platform === 'win32') {
    if (file.endsWith('taskkill.exe')) {
      expect(file).toBe(TASKKILL)
      const pid = Number(args[args.indexOf('/PID') + 1])
      sys.events.push(`taskkill:${pid}`)
      if (!sys.procs.has(pid)) throw new Error('exited with status 128')
      sys.end(pid, null)
      return 'SUCCESS\r\n'
    }
    expect(file).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/)
    const script = args[args.length - 1]
    if (/taskkill/.test(script)) {
      const pid = Number(/ProcessId=(\d+)/.exec(script)?.[1])
      const want = /-eq '(\d+)'/.exec(script)?.[1]
      const p = sys.procs.get(pid)
      sys.events.push(`verified-kill:${pid}`)
      if (p && p.created === want) { sys.end(pid, null); return 'ended\r\n' }
      return 'left\r\n'
    }
    let pids: number[]
    if (/Name=''chrome\.exe'' OR Name=''msedge\.exe''/.test(script)) {
      sys.events.push('query')
      pids = [...sys.procs].filter(([, p]) => isBrowser(p.name) && /remote-debugging-port/i.test(p.commandLine)).map(([pid]) => pid)
    } else {
      pids = [Number(/\$ids = @\((\d+)\)/.exec(script)?.[1])].filter((pid) => sys.procs.has(pid))
    }
    const out = pids.map((pid) => {
      const p = sys.procs.get(pid) as Proc
      return { pid, name: p.name, commandLine: p.commandLine, created: p.created }
    })
    return Buffer.from(JSON.stringify(out), 'utf8').toString('base64')
  }
  if (file.endsWith('lsof')) throw new Error('test: lsof must not run')
  expect(file).toMatch(/\/ps$/)
  if (args[0] === '-A') {
    sys.events.push('query')
    return [...sys.procs].map(([pid, p]) => `${String(pid).padStart(6)} ${p.commandLine}`).join('\n') + '\n'
  }
  const p = sys.procs.get(Number(args[args.indexOf('-p') + 1]))
  if (!p) throw new Error('exited with status 1')
  const field = args[args.indexOf('-o') + 1]
  return `${field === 'comm=' ? p.name : field === 'args=' ? p.commandLine : p.created}\n`
}

const fakePorts: OwnerPorts = {
  get platform() { return sys.platform },
  systemRoot: 'C:\\Windows',
  run: async (file, args, timeoutMs) => { sys.runs.push({ file, args, sync: false, timeoutMs }); return answer(file, args, timeoutMs) },
  runSync: (file, args, timeoutMs) => { sys.runs.push({ file, args, sync: true, timeoutMs }); return answer(file, args, timeoutMs) },
  signal: (pid, sig) => {
    sys.signals.push([pid, sig])
    sys.events.push(`signal:${pid}:${sig}`)
    const targets = pid < 0
      ? [...sys.procs].filter(([, p]) => p.group === -pid).map(([q]) => q)
      : (sys.procs.has(pid) ? [pid] : [])
    if (targets.length === 0) throw new Error('ESRCH')
    for (const q of targets) {
      if (sig === 'SIGTERM' && sys.ignoreTerm.has(q)) continue
      sys.end(q, sig)
    }
  },
  exists: (f) => !f.endsWith('lsof'),
  realpath: (p) => sys.realpaths.get(p) ?? null,
  // A long wait (a grace, an exit wait) takes a little real time; a poll none.
  sleep: async (ms) => { sys.sleeps++; await new Promise((r) => setTimeout(r, ms >= 1000 ? 10 : 0)) },
  sleepSync: (ms) => { sys.events.push(`sleepSync:${ms}`) },
}

const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0)) }
/** Let relaunches fired in the background run to their end, so none reaches the next test. */
const settle = () => new Promise((r) => setTimeout(r, 150))
const tmp = () => process.env.TEMP || process.env.TMP || nodeOs.tmpdir()
const scriptOf = (r: { args: string[] }) => r.args[r.args.length - 1]
/** Every kill the app asked the OS for: taskkill directly, a verified kill script, or a signal. */
const directKills = () => sys.runs.filter((r) => r.file.endsWith('taskkill.exe'))
const verifiedKills = () => sys.runs.filter((r) => /taskkill/.test(scriptOf(r)))
const queries = () => sys.events.filter((e) => e === 'query')
const logged = (re: RegExp) => log.info.mock.calls.some(([m]) => re.test(String(m)))

function addProc(pid: number, opts: { name?: string; profile?: string; port?: number | null; portArg?: number; extra?: string[] } = {}): void {
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
    group: pid,
  })
}

describe.each(['win32', 'linux'] as const)('vision browser teardown and launch (%s)', (platform) => {
  beforeEach(() => {
    sys.platform = platform
    _setVisionOwnerPortsForTest(fakePorts)
    _resetAutoRelaunchForTest()
    killSpawnedBrowser() // drop anything tracked by an earlier test
    sys.procs.clear()
    sys.children.clear()
    sys.nextPid = 1000
    sys.failReads = false
    sys.queryLatencyMs = 0
    sys.ignoreTerm.clear()
    sys.unkillable.clear()
    sys.realpaths.clear()
    sys.exitDelayMs = 0
    sys.onEnd = null
    sys.runs.length = 0
    sys.signals.length = 0
    sys.events.length = 0
    sys.browserSpawns.length = 0
    sys.sleeps = 0
    log.info.mockClear()
  })

  /** The quit kill: taskkill /T /F by pid (Windows) or SIGTERM, a bounded wait, SIGKILL to the group. */
  function expectQuitKillOf(pid: number): void {
    if (platform === 'win32') {
      expect(directKills()).toHaveLength(1)
      expect(directKills()[0]).toMatchObject({ file: TASKKILL, args: ['/PID', String(pid), '/T', '/F'], sync: true })
    } else {
      expect(sys.signals[0]).toEqual([-pid, 'SIGTERM'])
      const term = sys.events.indexOf(`signal:-${pid}:SIGTERM`)
      const wait = sys.events.findIndex((e) => e.startsWith('sleepSync:'))
      const kill = sys.events.indexOf(`signal:-${pid}:SIGKILL`)
      expect(term).toBeGreaterThanOrEqual(0)
      expect(wait).toBeGreaterThan(term)
      expect(kill).toBeGreaterThan(wait)
    }
  }

  it('ends the browser it started at quit, by its pid, before any read-back could settle', async () => {
    const { pid } = await launchBrowser('chrome', 9222, undefined, true)
    expect(pid).toBe(1000)
    // No flush: the quit comes at once.
    sys.runs.length = 0
    sys.events.length = 0
    killSpawnedBrowser()
    expect(sys.procs.has(1000)).toBe(false)
    expectQuitKillOf(1000)
    // Nothing was asked about the browser: no read-back, no PowerShell, no ps.
    expect(sys.runs.every((r) => r.file.endsWith('taskkill.exe'))).toBe(true)
    sys.runs.length = 0
    sys.signals.length = 0
    killSpawnedBrowser() // idempotent
    expect(sys.runs).toHaveLength(0)
    expect(sys.signals).toHaveLength(0)
  })

  it('asks the OS nothing about the browser it spawned (no read-back after spawn)', async () => {
    await launchBrowser('chrome', 9222, undefined, true)
    const spawnAt = sys.events.indexOf('spawn:1000')
    await flush()
    expect(sys.events.slice(spawnAt + 1)).toEqual([])
    expect(sys.runs.filter((r) => scriptOf(r).includes('@(1000)') || r.args.includes('1000'))).toHaveLength(0)
  })

  it('ends the browser it started at quit even when every read would fail', async () => {
    sys.failReads = true
    await launchBrowser('chrome', 9222, undefined, true)
    await flush()
    sys.runs.length = 0
    sys.events.length = 0
    killSpawnedBrowser()
    expect(sys.procs.has(1000)).toBe(false)
    expectQuitKillOf(1000)
  })

  it('ends a HEADED browser it started too', async () => {
    await launchBrowser('chrome', 9222, undefined, false)
    killSpawnedBrowser()
    expect(sys.procs.has(1000)).toBe(false)
  })

  it('stopGlobalVision ends the browser it started', async () => {
    await launchBrowser('chrome', 9222, undefined, true)
    await stopGlobalVision()
    expect(sys.procs.has(1000)).toBe(false)
  })

  it('once its exit was observed, quit does nothing with its pid, even when that pid names another process now', async () => {
    await launchBrowser('chrome', 9222, undefined, true)
    sys.end(1000, null)
    await flush() // the exit is observed
    addProc(1000, { port: null }) // the pid now belongs to another process
    sys.runs.length = 0
    killSpawnedBrowser()
    expect(sys.procs.has(1000)).toBe(true)
    expect(sys.runs).toHaveLength(0)
    expect(sys.signals).toHaveLength(0)
  })

  it('a relaunch ends the previous browser by its pid and waits for its exit before it spawns the next', async () => {
    await launchBrowser('chrome', 9222, undefined, true)
    sys.events.length = 0
    await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.procs.has(1000)).toBe(false)
    expect(sys.procs.has(1001)).toBe(true)
    expect(sys.browserSpawns).toHaveLength(2)
    expect(sys.events.indexOf('end:1000')).toBeLessThan(sys.events.indexOf('spawn:1001'))
    expect(sys.children.get(1000).exitCode !== null || sys.children.get(1000).signalCode !== null).toBe(true)
    if (platform === 'win32') expect(directKills().map((r) => r.args)).toEqual([['/PID', '1000', '/T', '/F']])
    else expect(sys.signals).toEqual([[-1000, 'SIGTERM']])
  })

  it('a relaunch waits until the previous browser exit is observed before it spawns', async () => {
    await launchBrowser('chrome', 9222, undefined, true)
    sys.exitDelayMs = 3
    await launchBrowser('chrome', 9222, undefined, true)
    const observed = sys.events.indexOf('exit-observed:1000')
    expect(observed).toBeGreaterThanOrEqual(0)
    expect(observed).toBeLessThan(sys.events.indexOf('spawn:1001'))
    expect(sys.signals.filter(([, s]) => s === 'SIGKILL')).toHaveLength(0)
  })

  it('a relaunch ends the previous browser even when every read would fail', async () => {
    sys.failReads = true
    await launchBrowser('chrome', 9222, undefined, true)
    await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.procs.has(1000)).toBe(false)
    expect(sys.browserSpawns).toHaveLength(2)
  })

  it('once its exit was observed, a relaunch does nothing with its pid', async () => {
    await launchBrowser('chrome', 9222, undefined, true)
    sys.end(1000, null)
    await flush()
    addProc(1000, { port: null, name: platform === 'win32' ? 'notepad.exe' : 'node' })
    await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.procs.has(1000)).toBe(true)
    expect(sys.browserSpawns).toHaveLength(2)
    expect(directKills()).toHaveLength(0)
    expect(verifiedKills()).toHaveLength(0)
    expect(sys.signals).toHaveLength(0)
  })

  if (platform === 'linux') {
    it('a relaunch sends SIGKILL to the previous browser group when SIGTERM does not end it within the grace', async () => {
      await launchBrowser('chrome', 9222, undefined, true)
      sys.ignoreTerm.add(1000)
      sys.exitDelayMs = 3
      await launchBrowser('chrome', 9222, undefined, true)
      expect(sys.signals).toEqual([[-1000, 'SIGTERM'], [-1000, 'SIGKILL']])
      expect(sys.procs.has(1000)).toBe(false)
      expect(sys.events.indexOf('exit-observed:1000')).toBeGreaterThanOrEqual(0)
      expect(sys.events.indexOf('exit-observed:1000')).toBeLessThan(sys.events.indexOf('spawn:1001'))
    })

    it('a leftover that ignores SIGTERM gets SIGKILL after the grace, then the launch goes ahead', async () => {
      addProc(500, { port: null })
      sys.ignoreTerm.add(500)
      await launchBrowser('chrome', 9222, undefined, true)
      expect(sys.signals).toEqual([[-500, 'SIGTERM'], [-500, 'SIGKILL']])
      expect(sys.procs.has(500)).toBe(false)
      expect(sys.browserSpawns).toHaveLength(1)
    })
  }

  it('crash case: a leftover holding the profile but not the port is ended before the spawn', async () => {
    addProc(500, { port: null }) // after a crash: holds chrome-debug-9222, not listening
    await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.procs.has(500)).toBe(false)
    expect(sys.browserSpawns).toHaveLength(1)
    expect(sys.events.indexOf('end:500')).toBeLessThan(sys.events.indexOf('spawn:1000'))
    expect(logged(/pid 500/)).toBe(true)
    if (platform === 'win32') expect(verifiedKills().map((r) => /ProcessId=(\d+)/.exec(scriptOf(r))?.[1])).toEqual(['500'])
    else expect(sys.signals).toEqual([[-500, 'SIGTERM']])
  })

  it('ends the leftovers on either profile folder (chrome or edge), listening or not, verified, then launches', async () => {
    addProc(500)
    addProc(501, { profile: path.join(tmp(), 'edge-debug-9222'), port: null, name: platform === 'win32' ? 'msedge.exe' : 'msedge' })
    await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.procs.has(500)).toBe(false)
    expect(sys.procs.has(501)).toBe(false)
    expect(sys.browserSpawns).toHaveLength(1)
    if (platform === 'win32') {
      expect(verifiedKills().map((r) => /ProcessId=(\d+)/.exec(scriptOf(r))?.[1]).sort()).toEqual(['500', '501'])
      expect(directKills()).toHaveLength(0)
    } else {
      expect(sys.signals.map(([p]) => p).sort((a, b) => a - b)).toEqual([-501, -500])
    }
  })

  if (platform === 'win32') {
    it('B-M8-2: a leftover started with TEMP in another case, or in its short form, is identified and ended', async () => {
      const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP }
      process.env.TEMP = 'C:\\Users\\longusername\\AppData\\Local\\Temp'
      try {
        const long = path.win32.join(process.env.TEMP, 'chrome-debug-9222')
        const short = 'C:\\Users\\LONGUS~1\\AppData\\Local\\Temp\\chrome-debug-9222'
        sys.realpaths.set(short, long)
        sys.realpaths.set(long, long)
        sys.realpaths.set(path.join(process.env.TEMP, 'chrome-debug-9222'), long)
        addProc(500, { port: null, profile: short })
        addProc(501, { port: null, profile: long.toUpperCase() })
        await launchBrowser('chrome', 9222, undefined, true)
        expect(sys.procs.has(500)).toBe(false)
        expect(sys.procs.has(501)).toBe(false)
        expect(sys.browserSpawns).toHaveLength(1)
      } finally {
        for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
      }
    })

    it('B-M8-4: a query that answers after 4 s still identifies the leftover', async () => {
      sys.queryLatencyMs = 6000
      addProc(500, { port: null })
      await launchBrowser('chrome', 9222, undefined, true)
      expect(sys.procs.has(500)).toBe(false)
      expect(sys.runs.filter((r) => !r.sync).every((r) => r.timeoutMs >= 20000)).toBe(true)
      // No PowerShell ever runs synchronously.
      expect(sys.runs.filter((r) => r.sync && !r.file.endsWith('taskkill.exe'))).toHaveLength(0)
    })
  }

  if (platform === 'linux') {
    it('B-M8-3: with no lsof on the machine the leftover is identified by its profile through ps', async () => {
      addProc(500)
      await launchBrowser('chrome', 9222, undefined, true)
      expect(sys.procs.has(500)).toBe(false)
      expect(sys.runs.some((r) => r.file.endsWith('lsof'))).toBe(false)
      expect(sys.browserSpawns).toHaveLength(1)
    })
  }

  it('an ended leftover whose pid at once names another process does not hold the launch', async () => {
    addProc(500, { port: null })
    sys.onEnd = (pid) => { if (pid === 500) { sys.onEnd = null; addProc(500, { port: null, profile: path.join(tmp(), 'MyOwnProfile') }) } }
    await launchBrowser('chrome', 9222, undefined, true)
    expect(sys.browserSpawns).toHaveLength(1)
    expect(sys.procs.has(500)).toBe(true) // the other process is left running
  })

  it('a leftover that does not end in time stops the launch, which spawns nothing', async () => {
    addProc(500, { port: null })
    sys.unkillable.add(500)
    const err = await launchBrowser('chrome', 9222, undefined, true).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(VisionPortHeldError)
    expect((err as Error).message).toBe("the vision browser's profile folder is still in use; vision was not started")
    expect(sys.browserSpawns).toHaveLength(0)
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
    expect(directKills()).toHaveLength(0)
    expect(verifiedKills()).toHaveLength(0)
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

  it('fast path: nothing listening and no leftover found, one query and no further work', async () => {
    addProc(700, { port: null, profile: path.join(tmp(), 'MyOwnProfile') }) // a browser that is not the app's
    await launchBrowser('chrome', 9222, undefined, true)
    expect(queries()).toHaveLength(1)
    expect(sys.sleeps).toBe(0)
    expect(sys.procs.has(700)).toBe(true)
    expect(sys.browserSpawns).toHaveLength(1)
  })

  it('logs the browser exit with its code or signal', async () => {
    await launchBrowser('chrome', 9222, undefined, true)
    sys.end(1000, null)
    await flush()
    expect(logged(/pid 1000\) exited/)).toBe(true)
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
      await settle()
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
      await settle()
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

