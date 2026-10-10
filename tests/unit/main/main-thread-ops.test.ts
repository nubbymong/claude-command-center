// [host] ADR-025: attributing a main-thread stall. A synchronous program start
// on the main thread is timed; one over 500 ms is logged by the program's base
// name only ("[spawn] claude.exe took N ms to start"), never its folder,
// arguments or environment; and the [jank] line names the operation that was
// in flight during the stall, or says that no tracked one was. Clocks and the
// log are faked; nothing is started.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const logs = vi.hoisted(() => [] as string[])
vi.mock('../../../src/main/debug-logger', () => ({
  logInfo: (m: string) => { logs.push(m) }, logWarn: (m: string) => { logs.push(m) }, logError: (m: string) => { logs.push(m) },
}))

const ops = await import('../../../src/main/main-thread-ops')
const { startJankDetector, _stopJankDetectorForTest } = await import('../../../src/main/jank-detector')
const { runCodexCli } = await import('../../../src/main/providers/codex/cli-runner')

let now = 1_000
beforeEach(() => {
  logs.length = 0
  now = 1_000
  ops._setMainThreadClockForTest(() => now)
})
afterEach(() => {
  ops._resetMainThreadOpsForTest()
  _stopJankDetectorForTest()
  vi.useRealTimers()
})

describe('timing a program start on the main thread', () => {
  it('logs a start over 500 ms by the program\'s base name only', () => {
    const r = ops.timedStart('C:\\Users\\A\\.local\\bin\\claude.exe', () => { now += 1907; return 'child' })
    expect(r).toBe('child')
    expect(logs).toEqual(['[spawn] claude.exe took 1907 ms to start'])
  })

  it('logs nothing for a start of 500 ms or less, and still returns what the start returned', () => {
    expect(ops.timedStart('/usr/local/bin/codex', () => { now += 500; return 42 })).toBe(42)
    expect(logs).toEqual([])
  })

  it('a start that throws still ends its operation, and the error goes on to the caller', () => {
    expect(() => ops.timedStart('C:\\x\\codex.exe', () => { now += 600; throw new Error('EINVAL') })).toThrow('EINVAL')
    expect(logs).toEqual(['[spawn] codex.exe took 600 ms to start'])
    expect(ops.mainThreadOpSince(now + 1)).toBeNull()
  })

  it('names a program by its last path part, either slash, with control characters dropped', () => {
    expect(ops.programBaseName('C:\\a\\b\\claude.exe')).toBe('claude.exe')
    expect(ops.programBaseName('/opt/x/codex')).toBe('codex')
    expect(ops.programBaseName('claude')).toBe('claude')
    expect(ops.programBaseName('C:\\a\\cl\u001b[2Jaude.exe')).toBe('cl[2Jaude.exe')
  })
})

describe('the [jank] line names what was in flight', () => {
  it('a stall during a timed start names that start', () => {
    const since = now
    ops.timedStart('C:\\Users\\A\\.local\\bin\\claude.exe', () => { now += 1800 })
    expect(ops.mainThreadOpSince(since)).toBe('start of claude.exe')
    // Ended before the window began: not this stall's.
    expect(ops.mainThreadOpSince(now + 1)).toBeNull()
  })

  it('of several in the window, the longest is named', () => {
    const since = now
    ops.timedStart('C:\\a\\node.exe', () => { now += 50 })
    ops.timedStart('C:\\a\\codex.exe', () => { now += 1500 })
    ops.timedStart('C:\\a\\git.exe', () => { now += 80 })
    expect(ops.mainThreadOpSince(since)).toBe('start of codex.exe')
  })

  it('the detector logs the operation in flight, and says when no tracked one was', async () => {
    vi.useFakeTimers()
    startJankDetector(() => now)
    // A start that held the main thread for 1.9 s between two ticks.
    ops.timedStart('C:\\Users\\A\\.local\\bin\\claude.exe', () => { now += 1900 })
    now += 250
    await vi.advanceTimersByTimeAsync(250)
    expect(logs.filter((l) => l.startsWith('[jank]'))).toEqual(['[jank] main loop stalled 2150ms (expected ~250ms) near start of claude.exe'])
    // A stall with nothing tracked in flight.
    now += 2000
    await vi.advanceTimersByTimeAsync(250)
    expect(logs.filter((l) => l.startsWith('[jank]'))[1]).toBe('[jank] main loop stalled 2000ms (expected ~250ms) near tick (no tracked app operation in flight)')
  })
})

describe('the CLI runner times its start', () => {
  it('a slow spawn is logged by the program\'s base name, never its arguments or environment', async () => {
    const { EventEmitter } = await import('node:events')
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: null, pid: 7, exitCode: null, signalCode: null, kill: () => true })
    const run = runCodexCli(
      { file: 'C:\\Users\\A\\AppData\\Local\\codex\\codex.exe', args: ['login', 'status'], verbatim: false, cwd: 'C:\\x' },
      { env: { SECRET_MARK: 'never-logged' }, timeoutMs: 10_000 },
      { spawn: (() => { now += 2400; return child }) as never, platform: 'win32', killTree: (() => {}) as never },
    )
    child.emit('exit', 0)
    child.emit('close', 0)
    await run
    expect(logs).toEqual(['[spawn] codex.exe took 2400 ms to start'])
  })
})
