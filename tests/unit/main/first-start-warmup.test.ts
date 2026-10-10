// [host] ADR-025: the first start of a new Claude Code or Codex program on
// Windows runs off the main thread, as a pre-start, before the caller's own
// start. PURE: a fake worker and fake file reads; nothing is started.
//
// What is held here: the warm-up is keyed by the file's identity (canonical
// path, size, modification time, file id), so a changed file warms again and
// the same file does not; one warm-up per identity is in flight; the caller
// never waits past the bound, whatever the worker does; a failed start
// resolves; only a direct .exe on Windows is warmed; and what reaches the
// worker is the canonical path the main process resolved, the fixed
// `--version`, and a prototype-free copy of the environment the caller built.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import {
  createFirstStartWarmup, firstStartIdentityKey, FIRST_START_ARGS, FIRST_START_CALLER_BOUND_MS, FIRST_START_TIMEOUT_MS,
} from '../../../src/main/first-start-warmup'
import type { FirstStartRequest, FirstStartRun, FirstStartWarmupDeps } from '../../../src/main/first-start-warmup'

const EXE = 'C:\\Users\\A\\.local\\bin\\claude.exe'
const REAL = 'C:\\Users\\A\\.local\\share\\claude\\versions\\2.1.296\\claude.exe'
type Stat = { size: number; mtimeMs: number; dev: string; ino: string; isFile: boolean }
const STAT: Stat = { size: 260_489_376, mtimeMs: 1_760_000_000_123.7, dev: '3456', ino: '281474976710656123', isFile: true }

function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => { resolve = r })
  return { promise, resolve }
}

function fakeDeps(over: Partial<FirstStartWarmupDeps> = {}) {
  const requests: FirstStartRequest[] = []
  const answers: Array<ReturnType<typeof deferred<FirstStartRun>>> = []
  const stops: number[] = []
  const logs: string[] = []
  let stat: Stat = { ...STAT }
  const deps: FirstStartWarmupDeps = {
    platform: () => 'win32',
    realpath: async (p) => (p === EXE ? REAL : p),
    stat: async () => ({ ...stat }),
    startWorker: (req) => {
      requests.push(req)
      const d = deferred<FirstStartRun>()
      answers.push(d)
      const i = answers.length - 1
      return { result: d.promise, stop: () => { stops.push(i) } }
    },
    log: (m) => { logs.push(m) },
    now: () => Date.now(),
    ...over,
  }
  return { deps, requests, answers, stops, logs, setStat: (s: Partial<Stat>) => { stat = { ...stat, ...s } } }
}

const ENV = () => ({ env: { PATH: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows', NoDefaultCurrentDirectoryInExePath: '1' } })
const ok: FirstStartRun = { exitCode: 0, timedOut: false, startMs: 12 }

afterEach(() => { vi.useRealTimers() })

describe('the first-start warm-up (ADR-025)', () => {
  it('starts the canonical path the main process resolved, with the fixed --version, in its own folder', async () => {
    const f = fakeDeps()
    const p = createFirstStartWarmup(f.deps).warm(EXE, ENV)
    await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    const req = f.requests[0]
    // Program path only from the main process's resolution: the file the
    // caller named, canonicalised, never a name looked up elsewhere.
    expect(req.file).toBe(REAL)
    // Argv fixed: --version, whatever the caller is about to run.
    expect(req.args).toEqual(['--version'])
    expect(FIRST_START_ARGS).toEqual(['--version'])
    expect(req.cwd).toBe('C:\\Users\\A\\.local\\share\\claude\\versions\\2.1.296')
    expect(req.timeoutMs).toBe(FIRST_START_TIMEOUT_MS)
    expect(req.maxOutput).toBeGreaterThan(0)
    f.answers[0].resolve(ok)
    expect(await p).toEqual({ outcome: 'ran', exitCode: 0, timedOut: false })
  })

  it('hands the worker a prototype-free copy of only the caller\'s own string variables', async () => {
    const f = fakeDeps()
    const proto = { INHERITED_MARK: 'from-a-prototype' }
    const env = Object.assign(Object.create(proto) as Record<string, unknown>, { PATH: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows', N: 3, U: undefined })
    const p = createFirstStartWarmup(f.deps).warm(EXE, () => ({ env: env as Record<string, string> }))
    await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    expect({ ...f.requests[0].env }).toEqual({ PATH: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows' })
    expect(Object.getPrototypeOf(f.requests[0].env)).toBeNull()
    f.answers[0].resolve(ok)
    await p
  })

  it('the same identity is warmed once; a changed size, modification time or file id warms again', async () => {
    const f = fakeDeps()
    const w = createFirstStartWarmup(f.deps)
    const first = w.warm(EXE, ENV)
    await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    f.answers[0].resolve(ok)
    await first
    expect(await w.warm(EXE, ENV)).toEqual({ outcome: 'skipped', reason: 'already-warm' })
    expect(await w.warm(REAL, ENV)).toEqual({ outcome: 'skipped', reason: 'already-warm' })
    expect(f.requests).toHaveLength(1)

    for (const [i, change] of ([{ mtimeMs: STAT.mtimeMs + 5_000 }, { size: STAT.size + 1 }, { ino: '281474976710656999' }] as Array<Partial<Stat>>).entries()) {
      f.setStat(change)
      const again = w.warm(EXE, ENV)
      await vi.waitFor(() => expect(f.requests).toHaveLength(2 + i))
      f.answers[1 + i].resolve(ok)
      expect(await again).toMatchObject({ outcome: 'ran' })
    }
  })

  it('the identity key is the canonical path (any case on Windows), size, whole-ms modification time, device and file id', () => {
    const a = firstStartIdentityKey(REAL, STAT)
    expect(firstStartIdentityKey(REAL.toUpperCase(), STAT)).toBe(a)
    expect(firstStartIdentityKey(REAL, { ...STAT, mtimeMs: STAT.mtimeMs + 0.2 })).toBe(a)
    for (const s of [{ size: 1 }, { mtimeMs: 1 }, { dev: '1' }, { ino: '1' }]) expect(firstStartIdentityKey(REAL, { ...STAT, ...s })).not.toBe(a)
    expect(firstStartIdentityKey('C:\\other\\claude.exe', STAT)).not.toBe(a)
  })

  it('one warm-up per identity is in flight: overlapping callers share it', async () => {
    const f = fakeDeps()
    const w = createFirstStartWarmup(f.deps)
    const env = vi.fn(ENV)
    const a = w.warm(EXE, env)
    const b = w.warm(EXE, env)
    const c = w.warm(REAL, env)
    await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    await new Promise((r) => setTimeout(r, 20))
    expect(f.requests).toHaveLength(1)
    expect(env).toHaveBeenCalledTimes(1)
    f.answers[0].resolve(ok)
    expect(await Promise.all([a, b, c])).toEqual([0, 1, 2].map(() => ({ outcome: 'ran', exitCode: 0, timedOut: false })))
  })

  it('a worker that never answers holds the caller no longer than the bound, and the identity is not marked warm', async () => {
    vi.useFakeTimers()
    // Promise turns only: no fake time passes while the warm-up reads the file.
    const turns = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
    const f = fakeDeps()
    const w = createFirstStartWarmup(f.deps)
    let settled: unknown = null
    void w.warm(EXE, ENV).then((r) => { settled = r })
    await turns()
    expect(f.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(FIRST_START_CALLER_BOUND_MS - 1)
    expect(settled).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    await turns()
    expect(settled).toEqual({ outcome: 'gave-up' })
    expect(f.logs.some((l) => l.includes('claude.exe') && !l.includes('\\'))).toBe(true)
    // A later caller joins the same run, within what is left of its bound: none.
    let later: unknown = null
    void w.warm(EXE, ENV).then((r) => { later = r })
    await turns()
    await vi.advanceTimersByTimeAsync(1)
    await turns()
    expect(f.requests).toHaveLength(1)
    expect(later).toEqual({ outcome: 'gave-up' })
    // The worker answers at last (its own timeout): the identity is warm now.
    f.answers[0].resolve({ exitCode: null, timedOut: true, startMs: 4_000 })
    await turns()
    expect(await w.warm(EXE, ENV)).toEqual({ outcome: 'skipped', reason: 'already-warm' })
  })

  it('a timed-out start resolves with timedOut, and a start that failed resolves with its error and is tried again next time', async () => {
    const f = fakeDeps()
    const w = createFirstStartWarmup(f.deps)
    const a = w.warm(EXE, ENV)
    await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    f.answers[0].resolve({ exitCode: null, timedOut: true, startMs: 3 })
    expect(await a).toEqual({ outcome: 'ran', exitCode: null, timedOut: true })

    f.setStat({ mtimeMs: 7 })
    const b = w.warm(EXE, ENV)
    await vi.waitFor(() => expect(f.requests).toHaveLength(2))
    f.answers[1].resolve({ exitCode: null, timedOut: false, spawnError: 'ENOENT' })
    expect(await b).toEqual({ outcome: 'ran', exitCode: null, timedOut: false, spawnError: 'ENOENT' })
    const c = w.warm(EXE, ENV)
    await vi.waitFor(() => expect(f.requests).toHaveLength(3))
    f.answers[2].resolve(ok)
    await c
  })

  it('a worker that throws on start, a result that rejects, or an environment that cannot be built resolves and never rejects', async () => {
    const throwing = fakeDeps({ startWorker: () => { throw new Error('no worker') } })
    expect(await createFirstStartWarmup(throwing.deps).warm(EXE, ENV)).toMatchObject({ outcome: 'ran', spawnError: expect.any(String) })
    const rejecting = fakeDeps({ startWorker: () => ({ result: Promise.reject(new Error('x')), stop: () => {} }) })
    expect(await createFirstStartWarmup(rejecting.deps).warm(EXE, ENV)).toMatchObject({ outcome: 'ran', spawnError: expect.any(String) })
    const f = fakeDeps()
    expect(await createFirstStartWarmup(f.deps).warm(EXE, () => { throw new Error('no env') })).toMatchObject({ spawnError: expect.any(String) })
    expect(f.requests).toHaveLength(0)
    const unreadable = fakeDeps({ realpath: async () => { throw new Error('ENOENT') } })
    expect(await createFirstStartWarmup(unreadable.deps).warm(EXE, ENV)).toEqual({ outcome: 'skipped', reason: 'unreadable' })
  })

  it('skips off Windows, for a .cmd or .bat shim, a relative or device path, a name ending in a dot or space, and a folder', async () => {
    const off = fakeDeps({ platform: () => 'linux', realpath: vi.fn(async (p: string) => p) })
    expect(await createFirstStartWarmup(off.deps).warm('/usr/local/bin/claude', ENV)).toEqual({ outcome: 'skipped', reason: 'not-windows' })
    expect(off.deps.realpath).not.toHaveBeenCalled()
    const f = fakeDeps()
    const w = createFirstStartWarmup(f.deps)
    expect(await w.warm('C:\\npm\\claude.cmd', ENV)).toEqual({ outcome: 'skipped', reason: 'not-exe' })
    expect(await w.warm('C:\\npm\\claude.bat', ENV)).toEqual({ outcome: 'skipped', reason: 'not-exe' })
    for (const p of ['claude.exe', 'bin\\claude.exe', '\\\\?\\C:\\x\\claude.exe', '\\\\.\\C:\\x\\claude.exe', 'C:\\x.\\claude.exe', 'C:\\x\\claude.exe.']) {
      expect(await w.warm(p, ENV), p).toEqual({ outcome: 'skipped', reason: 'refused-path' })
    }
    const folder = fakeDeps({ stat: async () => ({ ...STAT, isFile: false }) })
    expect(await createFirstStartWarmup(folder.deps).warm(EXE, ENV)).toEqual({ outcome: 'skipped', reason: 'unreadable' })
    expect(f.requests).toHaveLength(0)
  })

  it('a .cmd that is a link to a program is skipped: the caller starts it through cmd.exe, so its target is never warmed', async () => {
    const realpath = vi.fn(async (p: string) => (p === 'C:\\npm\\claude.cmd' ? 'C:\\Tools\\other.exe' : p))
    const f = fakeDeps({ realpath })
    expect(await createFirstStartWarmup(f.deps).warm('C:\\npm\\claude.cmd', ENV)).toEqual({ outcome: 'skipped', reason: 'not-exe' })
    expect(f.requests).toHaveLength(0)
  })

  it('logs a slow first start by the program\'s base name only, never its folder, arguments or environment', async () => {
    const f = fakeDeps()
    const p = createFirstStartWarmup(f.deps).warm(EXE, ENV)
    await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    f.answers[0].resolve({ exitCode: 0, timedOut: false, startMs: 1906.6 })
    await p
    expect(f.logs).toContain('[spawn] claude.exe took 1907 ms to start (first start, off the main thread)')
    for (const l of f.logs) expect(l).not.toMatch(/\\|--version|SystemRoot|PATH/)
  })

  it('the environment is disposed once the worker has answered, never before', async () => {
    const f = fakeDeps()
    const dispose = vi.fn()
    const p = createFirstStartWarmup(f.deps).warm(EXE, () => ({ ...ENV(), dispose }))
    await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    expect(dispose).not.toHaveBeenCalled()
    f.answers[0].resolve(ok)
    await p
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('at quit every worker still running is stopped', async () => {
    const f = fakeDeps()
    const w = createFirstStartWarmup(f.deps)
    void w.warm(EXE, ENV)
    await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    w.stopAll()
    expect(f.stops).toEqual([0])
  })
})

// No renderer input reaches the warm-up: it is a main-process module, started
// only from the reviewed main-side callers below with a program their own
// discovery or resolution found. No preload or renderer file, and no IPC
// handler outside setup's own (which passes main's resolution, never its
// arguments; first-start-routing tests), imports it, and none names a call
// of it: the module's own function, the provider packages' port
// (launch.warmFirstStart, reachable through the provider registry with no
// import of this module), the Claude review port and Codex discovery's warm.
describe('who can start a first-start warm-up', () => {
  const ROOT = resolve(__dirname, '..', '..', '..')
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, out)
      else if (/\.(ts|tsx|js|cjs|mjs)$/.test(e.name)) out.push(relative(ROOT, p).split(sep).join('/'))
    }
    return out
  }
  const IMPORTERS = [
    'src/main/account-web/claude-cli-auth.ts',
    'src/main/claude-cli-version.ts',
    'src/main/claude-headless.ts',
    'src/main/cloud-agent-manager.ts',
    'src/main/insights-runner.ts',
    'src/main/ipc/setup-handlers.ts',
    'src/main/providers/codex/index.ts',
    'src/main/providers/compose.ts',
  ]
  // Every file that names a warm-up call: the importers above, and the
  // reviewed holders of the ports (the package interface, the accounts
  // service's launch, Claude's review port, Codex discovery's warm).
  const CALLERS = [
    ...IMPORTERS,
    'src/main/providers/claude/review-launch.ts',
    'src/main/providers/codex/discovery.ts',
    'src/main/providers/core/accounts-service.ts',
    'src/main/providers/core/package.ts',
  ].sort()
  const NAMES_A_CALL = /\b(?:warmFirstStart|warmCodexFirstStart|startFirstStartWorker)\b|\bdeps\s*\??\.\s*warm\b/
  const source = () => walk(join(ROOT, 'src')).filter((f) => f !== 'src/main/first-start-warmup.ts')
  it('only the reviewed main-process callers import it', () => {
    // An import or a require of either file, in any file but the module itself.
    const IMPORTS = /\b(?:from|import|require)\s*\(?\s*['"][^'"]*first-start-(?:warmup|worker)[^'"]*['"]/
    const found = source().filter((f) => IMPORTS.test(readFileSync(join(ROOT, f), 'utf8')))
    expect(found.sort()).toEqual(IMPORTERS)
  })
  it('only the reviewed main-process files name a warm-up call, the package and review ports included', () => {
    const found = source().filter((f) => NAMES_A_CALL.test(readFileSync(join(ROOT, f), 'utf8')))
    expect(found.sort()).toEqual(CALLERS)
  })
  it('no IPC handler but the setup terminal\'s names a warm-up call', () => {
    for (const f of source().filter((x) => x.startsWith('src/main/ipc/') && x !== 'src/main/ipc/setup-handlers.ts')) {
      expect(readFileSync(join(ROOT, f), 'utf8'), f).not.toMatch(NAMES_A_CALL)
    }
  })
  it('no IPC channel, preload or renderer file names it', () => {
    for (const f of walk(join(ROOT, 'src')).filter((x) => /^src\/(preload|renderer|shared)\//.test(x))) {
      expect(readFileSync(join(ROOT, f), 'utf8'), f).not.toMatch(/first-?start|warmFirstStart/i)
    }
  })
})
