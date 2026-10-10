// The Codex runner's stop: a stopped run reports settling until its process
// has exited. At the settle bound, a run whose kill is still under way, or
// whose kill has finished while its root still runs, carries `killSettled`;
// it resolves once the kill has finished and the root has exited (a tree
// stop: and what the run's records prove is left of it has been ended), or
// CODEX_KILL_WORST_MS after the stop (a tree stop: plus
// CODEX_LEFTOVERS_WORST_MS), whichever is first. An exec run whose root has
// exited is held the same way while its leftovers step is still under way at
// the bound, for CODEX_LEFTOVERS_WORST_MS from that step's start at most. A
// caller holding the account's lease, a realm lock or a runs folder for the
// run lets go only then. A stop that ended within the bound carries none.
//
// PURE: an injected spawn returning a scripted child and an injected kill; no
// process starts, fake timers only.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { runCodexCli, CODEX_KILL_SETTLE_MS, CODEX_KILL_WORST_MS, CODEX_LEFTOVERS_WORST_MS, CODEX_PROCESS_TABLE_TIMEOUT_MS, CODEX_TASKKILL_TIMEOUT_MS } from '../../../../src/main/providers/codex/cli-runner'
import type { CodexCommand, CodexRunDeps } from '../../../../src/main/providers/codex/cli-runner'

class FakeStream extends EventEmitter { setEncoding() { return this } destroy() { return this } }

function fakeChild() {
  return Object.assign(new EventEmitter(), { stdout: new FakeStream(), stderr: new FakeStream(), stdin: null, pid: 4242 })
}

const CMD: CodexCommand = { file: '/usr/local/bin/codex', args: ['login'], verbatim: false, cwd: '/usr/local/bin' }
const WIN_CMD: CodexCommand = { file: 'C:\\Tools\\codex.exe', args: ['login'], verbatim: false, cwd: 'C:\\Tools' }

function rig(killTree: CodexRunDeps['killTree'], platform: NodeJS.Platform = 'linux') {
  const child = fakeChild()
  const deps: CodexRunDeps = { spawn: (() => child as unknown as ChildProcess) as never, platform, killTree }
  return { child, deps }
}

/** Watches a promise without awaiting it. */
function watch(p: Promise<void>) {
  const s = { done: false }
  void p.then(() => { s.done = true })
  return s
}

afterEach(() => { vi.useRealTimers() })

describe('a stopped run reports settling until its process has exited', () => {
  it('a kill that finished while the root still runs: the run settles at its bound carrying killSettled, which resolves once the root exits', async () => {
    vi.useFakeTimers()
    for (const how of ['cancel', 'deadline'] as const) {
      // The kill command returns at once; the root does not exit.
      const { child, deps } = rig(async () => {})
      const ac = new AbortController()
      const p = runCodexCli(CMD, { env: {}, timeoutMs: how === 'deadline' ? 100 : 60_000, signal: ac.signal }, deps)
      if (how === 'cancel') ac.abort()
      else await vi.advanceTimersByTimeAsync(100)
      await vi.advanceTimersByTimeAsync(CODEX_KILL_SETTLE_MS + 10)
      const r = await p
      expect(r, how).toMatchObject({ exitCode: null, stopped: how })
      expect(r.killSettled, how).toBeInstanceOf(Promise)
      const settled = watch(r.killSettled!)
      // Twenty seconds after the stop the root still runs: still held.
      await vi.advanceTimersByTimeAsync(5_000)
      expect(settled.done, how).toBe(false)
      child.emit('exit', null, 'SIGKILL')
      await vi.advanceTimersByTimeAsync(0)
      expect(settled.done, how).toBe(true)
    }
  })

  it('a kill that failed while the root still runs is held the same way', async () => {
    vi.useFakeTimers()
    const { child, deps } = rig(() => Promise.reject(new Error('taskkill missing')))
    const ac = new AbortController()
    const p = runCodexCli(CMD, { env: {}, timeoutMs: 60_000, signal: ac.signal }, deps)
    ac.abort()
    await vi.advanceTimersByTimeAsync(CODEX_KILL_SETTLE_MS + 10)
    const r = await p
    expect(r).toMatchObject({ spawnError: 'cancelled', stopped: 'cancel' })
    const settled = watch(r.killSettled!)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled.done).toBe(false)
    child.emit('exit', 1, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(settled.done).toBe(true)
  })

  it('a tree stop whose root exits late is held until what is left of the run has been ended too', async () => {
    vi.useFakeTimers()
    let endLeftovers!: () => void
    const leftovers = vi.fn(() => new Promise<void>((res) => { endLeftovers = res }))
    const kill = Object.assign(async () => {}, { leftovers })
    const { child, deps } = rig(kill as never, 'win32')
    const ac = new AbortController()
    const p = runCodexCli(WIN_CMD, { env: {}, timeoutMs: 60_000, signal: ac.signal, killScope: 'tree' }, deps)
    ac.abort()
    await vi.advanceTimersByTimeAsync(CODEX_KILL_SETTLE_MS + 10)
    const r = await p
    expect(r).toMatchObject({ stopped: 'cancel' })
    const settled = watch(r.killSettled!)
    expect(leftovers).not.toHaveBeenCalled()
    child.emit('exit', null, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(0)
    expect(leftovers).toHaveBeenCalledTimes(1)
    expect(settled.done).toBe(false)
    endLeftovers()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled.done).toBe(true)
  })

  it('a root that never exits holds the run no longer than CODEX_KILL_WORST_MS after the stop', async () => {
    vi.useFakeTimers()
    const { deps } = rig(async () => {})
    const ac = new AbortController()
    const p = runCodexCli(CMD, { env: {}, timeoutMs: 60_000, signal: ac.signal }, deps)
    ac.abort()
    await vi.advanceTimersByTimeAsync(CODEX_KILL_SETTLE_MS + 10)
    const settled = watch((await p).killSettled!)
    await vi.advanceTimersByTimeAsync(CODEX_KILL_WORST_MS - CODEX_KILL_SETTLE_MS - 20)
    expect(settled.done).toBe(false)
    await vi.advanceTimersByTimeAsync(20)
    expect(settled.done).toBe(true)
  })

  it('a stop whose kill landed and whose root exited within the bound settles then, carrying nothing', async () => {
    vi.useFakeTimers()
    const { deps } = rig((c) => { queueMicrotask(() => (c as unknown as EventEmitter).emit('exit', null, 'SIGKILL')) })
    const ac = new AbortController()
    let settled = false
    const p = runCodexCli(CMD, { env: {}, timeoutMs: 60_000, signal: ac.signal }, deps).then((r) => { settled = true; return r })
    ac.abort()
    await vi.advanceTimersByTimeAsync(10)
    expect(settled).toBe(true)
    expect('killSettled' in (await p)).toBe(false)
  })

  it('a root that exited at once while its kill is still under way: held until the kill has finished', async () => {
    vi.useFakeTimers()
    let finishKill!: () => void
    const { child, deps } = rig(() => new Promise<void>((res) => { finishKill = res }))
    const ac = new AbortController()
    const p = runCodexCli(CMD, { env: {}, timeoutMs: 60_000, signal: ac.signal }, deps)
    ac.abort()
    child.emit('exit', null, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(CODEX_KILL_SETTLE_MS + 10)
    const settled = watch((await p).killSettled!)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled.done).toBe(false)
    finishKill()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled.done).toBe(true)
  })

  it('a tree stop whose root exits just before the kill\'s own worst case is held until its leftovers step has run, for that step\'s worst case at most', async () => {
    vi.useFakeTimers()
    for (const answers of [true, false]) {
      let endLeftovers!: () => void
      const leftovers = vi.fn(() => new Promise<void>((res) => { endLeftovers = res }))
      const { child, deps } = rig(Object.assign(async () => {}, { leftovers }) as never, 'win32')
      const ac = new AbortController()
      const p = runCodexCli(WIN_CMD, { env: {}, timeoutMs: 60_000, signal: ac.signal, killScope: 'tree' }, deps)
      ac.abort()
      await vi.advanceTimersByTimeAsync(CODEX_KILL_SETTLE_MS + 10)
      const settled = watch((await p).killSettled!)
      // The root exits a second before the kill's worst case; its leftovers step starts then.
      await vi.advanceTimersByTimeAsync(CODEX_KILL_WORST_MS - CODEX_KILL_SETTLE_MS - 1_010)
      child.emit('exit', null, 'SIGKILL')
      await vi.advanceTimersByTimeAsync(0)
      expect(leftovers).toHaveBeenCalledTimes(1)
      // Past the kill's own worst case the leftovers step still runs: still held.
      await vi.advanceTimersByTimeAsync(2_000)
      expect(settled.done, String(answers)).toBe(false)
      if (answers) {
        endLeftovers()
        await vi.advanceTimersByTimeAsync(0)
        expect(settled.done).toBe(true)
      } else {
        // A step that never answers: let go once the kill's and the step's worst cases have passed.
        await vi.advanceTimersByTimeAsync(CODEX_LEFTOVERS_WORST_MS - 1_000 - 20)
        expect(settled.done).toBe(false)
        await vi.advanceTimersByTimeAsync(20)
        expect(settled.done).toBe(true)
      }
    }
  })
})

describe('an exec run whose root has exited reports settling until what is left of it has been ended', () => {
  function exec(leftovers: () => Promise<void>) {
    return rig(Object.assign(async () => {}, { leftovers: vi.fn(leftovers) }) as never, 'win32')
  }

  it('its own exit: a leftovers step still under way at the bound is carried as killSettled, which resolves when that step ends', async () => {
    vi.useFakeTimers()
    let endLeftovers!: () => void
    const { child, deps } = exec(() => new Promise<void>((res) => { endLeftovers = res }))
    const p = runCodexCli(WIN_CMD, { env: {}, timeoutMs: 600_000, settleAfterExitMs: 2_000 }, deps)
    child.emit('exit', 0, null)
    await vi.advanceTimersByTimeAsync(2_000 + CODEX_KILL_SETTLE_MS + 10)
    const r = await p
    expect(r).toMatchObject({ exitCode: 0, timedOut: false })
    expect(r.stopped).toBeUndefined()
    expect(r.killSettled).toBeInstanceOf(Promise)
    const settled = watch(r.killSettled!)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled.done).toBe(false)
    endLeftovers()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled.done).toBe(true)
  })

  it('a stop after its root exited: the same, and the result keeps the root\'s exit code', async () => {
    vi.useFakeTimers()
    let endLeftovers!: () => void
    const { child, deps } = exec(() => new Promise<void>((res) => { endLeftovers = res }))
    const ac = new AbortController()
    const p = runCodexCli(WIN_CMD, { env: {}, timeoutMs: 600_000, settleAfterExitMs: 2_000, signal: ac.signal, killScope: 'tree' }, deps)
    child.emit('exit', 1, null)
    await vi.advanceTimersByTimeAsync(500)
    ac.abort()
    await vi.advanceTimersByTimeAsync(CODEX_KILL_SETTLE_MS + 10)
    const r = await p
    expect(r).toMatchObject({ exitCode: 1, stopped: 'cancel' })
    expect(r.killSettled).toBeInstanceOf(Promise)
    const settled = watch(r.killSettled!)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(settled.done).toBe(false)
    endLeftovers()
    await vi.advanceTimersByTimeAsync(0)
    expect(settled.done).toBe(true)
  })

  it('a leftovers step that never answers holds the run no longer than CODEX_LEFTOVERS_WORST_MS from its start', async () => {
    vi.useFakeTimers()
    let stepAt = 0
    const { child, deps } = exec(() => { stepAt = Date.now(); return new Promise<void>(() => {}) })
    const p = runCodexCli(WIN_CMD, { env: {}, timeoutMs: 600_000, settleAfterExitMs: 2_000 }, deps)
    child.emit('exit', 0, null)
    await vi.advanceTimersByTimeAsync(2_000 + CODEX_KILL_SETTLE_MS + 10)
    const settled = watch((await p).killSettled!)
    await vi.advanceTimersByTimeAsync(stepAt + CODEX_LEFTOVERS_WORST_MS - 10 - Date.now())
    expect(settled.done).toBe(false)
    await vi.advanceTimersByTimeAsync(20)
    expect(settled.done).toBe(true)
  })

  it('a leftovers step that ended within the bound: the run settles then, carrying nothing', async () => {
    vi.useFakeTimers()
    const { child, deps } = exec(() => new Promise<void>((res) => { setTimeout(res, 3_000) }))
    let settled = false
    const p = runCodexCli(WIN_CMD, { env: {}, timeoutMs: 600_000, settleAfterExitMs: 2_000 }, deps).then((r) => { settled = true; return r })
    child.emit('exit', 0, null)
    await vi.advanceTimersByTimeAsync(2_000 + 3_000 + 10)
    expect(settled).toBe(true)
    expect('killSettled' in (await p)).toBe(false)
  })

  it('the leftovers step\'s worst case is a read under way, its own read and taskkill, with a margin', () => {
    const phases = 2 * CODEX_PROCESS_TABLE_TIMEOUT_MS + CODEX_TASKKILL_TIMEOUT_MS
    expect(CODEX_LEFTOVERS_WORST_MS).toBeGreaterThanOrEqual(phases + 1000)
    expect(CODEX_LEFTOVERS_WORST_MS).toBeLessThanOrEqual(phases + 2000)
  })
})
