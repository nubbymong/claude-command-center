// The first start of a newly installed or updated Claude Code or Codex
// program, off the main thread (ADR-025).
//
// On Windows the first start of a newly written program holds the start call
// (CreateProcess) for one to four seconds while the OS checks the new
// program; later starts of the same file are fast. Node's spawn, execFile and
// node-pty all make that call on the thread that asks, and the app asks on
// the main thread, so the whole window froze for that long: after an install
// and "Add it to PATH", at the first check after Claude Code or Codex updated
// itself, and at the first terminal of a fresh install.
//
// So before a caller's own start of a program this app run has not started
// yet, the caller awaits a warm-up: the SAME file, started once in a worker
// thread (first-start-worker.cjs) with the fixed `--version`, which both CLIs
// answer and this app already runs. The caller's own start then finds the
// check done. It is a pre-start, never a gate: whatever the warm-up's outcome
// (a failure, a time-out, no answer within the bound), the caller goes on to
// do exactly what it did before, and never waits longer than
// FIRST_START_CALLER_BOUND_MS.
//
// Containment:
//   - Only a direct `.exe` on Windows, named by a drive or share path. A
//     `.cmd` or `.bat` shim is started through cmd.exe, already known to the
//     OS, so its main-thread start is not the first start of a new program.
//   - The program is the canonical path (real path) of what the main-process
//     caller's own discovery or resolution found. Callers are main-process
//     code only; no renderer input reaches this module (its importers, and
//     every file that names a warm-up call, the package ports included, are
//     pinned by tests/unit/main/first-start-warmup.test.ts).
//   - The argv is FIRST_START_ARGS, a constant: no caller passes arguments.
//   - The environment is the one the caller's own `--version` run is built
//     with (Claude's: reviewerEnv; Codex's: codexCliEnv over a throwaway
//     home), handed over as a prototype-free copy of its own string values.
//   - The working folder is the program's own folder.
//   - At most one warm-up per file identity (canonical path, size,
//     modification time, device and file id) is in flight, and an identity
//     that started once is not warmed again this run; a changed file is a new
//     identity.
//   - A warm-up still running at quit is ended (flushFirstStartWarmups).
import { Worker } from 'node:worker_threads'
import fs from 'node:fs'
import path from 'node:path'
import workerSource from './first-start-worker.cjs?raw'
import { logInfo } from './debug-logger'
import { windowsPathHasTrailingDotOrSpace } from './providers/windows-path-names'
import { programBaseName, SLOW_START_MS } from './main-thread-ops'

/** The only arguments a warm-up starts a program with. */
export const FIRST_START_ARGS: readonly string[] = Object.freeze(['--version'])
/** The program is ended if it has not exited by then. */
export const FIRST_START_TIMEOUT_MS = 10_000
/** How long the worker waits for an ended program to exit before it answers. */
export const FIRST_START_KILL_GRACE_MS = 2_000
/** The longest a caller waits for a warm-up, from its start. */
export const FIRST_START_CALLER_BOUND_MS = FIRST_START_TIMEOUT_MS + FIRST_START_KILL_GRACE_MS + 1_000
/** Characters of output kept; the rest is read and dropped. */
export const FIRST_START_MAX_OUTPUT = 4_096
/** The longest the quit waits for a running warm-up's program to be ended. */
const STOP_WAIT_MS = 500

/** The worker's text (first-start-worker.cjs), run as an eval worker so
 *  nothing is loaded from the app archive at run time. */
export const FIRST_START_WORKER_SOURCE: string = workerSource

/** What a caller's `--version` run is built with. `dispose` (a throwaway
 *  folder's removal) runs once the warm-up's program has finished. */
export interface FirstStartEnv { env: Readonly<Record<string, unknown>>; dispose?: () => void }
/** Built only when a warm-up is to run (an identity not yet warmed). */
export type FirstStartEnvSource = () => FirstStartEnv | Promise<FirstStartEnv>

/** What the worker is asked to start. */
export interface FirstStartRequest {
  file: string
  args: string[]
  env: Record<string, string>
  cwd: string
  timeoutMs: number
  killGraceMs: number
  maxOutput: number
}

/** The worker's answer. */
export interface FirstStartRun {
  exitCode: number | null
  timedOut: boolean
  /** An error code (ENOENT, ...) when the program could not be started. */
  spawnError?: string
  /** How long the start call itself held the worker thread. */
  startMs?: number
  stdout?: string
}

export interface FirstStartWorker {
  /** Never rejects. */
  result: Promise<FirstStartRun>
  /** Ends the program now (the quit). Synchronous; bounded. */
  stop(): void
}

export type FirstStartOutcome =
  | { outcome: 'skipped'; reason: 'not-windows' | 'refused-path' | 'not-exe' | 'unreadable' | 'already-warm' }
  | { outcome: 'ran'; exitCode: number | null; timedOut: boolean; spawnError?: string }
  | { outcome: 'gave-up' }

export interface FirstStartFileStat { size: number; mtimeMs: number; dev: string; ino: string; isFile: boolean }

export interface FirstStartWarmupDeps {
  platform(): NodeJS.Platform
  realpath(p: string): Promise<string>
  stat(p: string): Promise<FirstStartFileStat>
  startWorker(request: FirstStartRequest): FirstStartWorker
  log(message: string): void
  now(): number
}

/** A drive (`C:\`) or a share (`\\host\share\`), never `\\?\` or `\\.\`. */
const DRIVE_OR_SHARE = /^([A-Za-z]:\\|\\\\[^\\?.][^\\]*\\[^\\]+\\)/

/** The file's identity: canonical path (any case: Windows paths), size,
 *  whole-millisecond modification time, device and file id. */
export function firstStartIdentityKey(canonical: string, st: Pick<FirstStartFileStat, 'size' | 'mtimeMs' | 'dev' | 'ino'>): string {
  return JSON.stringify([canonical.toLowerCase(), st.size, Math.floor(st.mtimeMs), st.dev, st.ino])
}

/** A prototype-free copy of exactly the given object's own string values. */
function ownStrings(env: Readonly<Record<string, unknown>> | undefined): Record<string, string> {
  const out = Object.create(null) as Record<string, string>
  if (!env || typeof env !== 'object') return out
  for (const k of Object.keys(env)) {
    const v = env[k]
    if (typeof v === 'string') out[k] = v
  }
  return out
}

const failed = (spawnError: string): FirstStartRun => ({ exitCode: null, timedOut: false, spawnError })

export function createFirstStartWarmup(deps: FirstStartWarmupDeps): {
  warm(program: string, env: FirstStartEnvSource): Promise<FirstStartOutcome>
  /** At quit: ends every warm-up still running. */
  stopAll(): void
} {
  const warmed = new Set<string>()
  const inFlight = new Map<string, { done: Promise<FirstStartRun>; startedAt: number }>()
  const workers = new Set<FirstStartWorker>()
  const log = (m: string) => { try { deps.log(m) } catch { /* logging never breaks a warm-up */ } }

  const runOnce = async (key: string, canonical: string, envSource: FirstStartEnvSource, name: string): Promise<FirstStartRun> => {
    let source: FirstStartEnv
    try {
      source = await envSource()
    } catch {
      log(`[first-start] ${name}: its environment could not be built; not warmed`)
      return failed('no-environment')
    }
    const dispose = () => { try { source?.dispose?.() } catch { /* a leftover throwaway folder is harmless */ } }
    const request: FirstStartRequest = {
      file: canonical,
      args: [...FIRST_START_ARGS],
      env: ownStrings(source?.env),
      cwd: path.win32.dirname(canonical),
      timeoutMs: FIRST_START_TIMEOUT_MS,
      killGraceMs: FIRST_START_KILL_GRACE_MS,
      maxOutput: FIRST_START_MAX_OUTPUT,
    }
    let worker: FirstStartWorker
    try {
      worker = deps.startWorker(request)
    } catch {
      dispose()
      log(`[first-start] ${name}: the worker could not be started; not warmed`)
      return failed('worker-failed')
    }
    workers.add(worker)
    let run: FirstStartRun
    try { run = await worker.result } catch { run = failed('worker-failed') }
    workers.delete(worker)
    dispose()
    if (!run.spawnError) warmed.add(key)
    if (typeof run.startMs === 'number' && run.startMs > SLOW_START_MS) log(`[spawn] ${name} took ${Math.round(run.startMs)} ms to start (first start, off the main thread)`)
    if (run.spawnError) log(`[first-start] ${name} could not be started off the main thread (${run.spawnError})`)
    else if (run.timedOut) log(`[first-start] ${name} did not answer --version in ${FIRST_START_TIMEOUT_MS} ms and was ended`)
    return run
  }

  const waitFor = async (entry: { done: Promise<FirstStartRun>; startedAt: number }, name: string): Promise<FirstStartOutcome> => {
    const left = Math.max(0, entry.startedAt + FIRST_START_CALLER_BOUND_MS - deps.now())
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), left)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })
    const r = await Promise.race([entry.done, bound])
    if (timer) clearTimeout(timer)
    if (r === null) {
      log(`[first-start] ${name} had not answered in ${FIRST_START_CALLER_BOUND_MS} ms; going on without it`)
      return { outcome: 'gave-up' }
    }
    return { outcome: 'ran', exitCode: r.exitCode, timedOut: r.timedOut, ...(r.spawnError !== undefined ? { spawnError: r.spawnError } : {}) }
  }

  const warm = async (program: string, envSource: FirstStartEnvSource): Promise<FirstStartOutcome> => {
    try {
      if (deps.platform() !== 'win32') return { outcome: 'skipped', reason: 'not-windows' }
      if (typeof program !== 'string' || !DRIVE_OR_SHARE.test(program) || windowsPathHasTrailingDotOrSpace(program)) return { outcome: 'skipped', reason: 'refused-path' }
      // The caller's own program, not only its link target: a .cmd linked to
      // a program is started through cmd.exe, so it is not warmed either.
      if (!/\.exe$/i.test(program)) return { outcome: 'skipped', reason: 'not-exe' }
      let canonical: string
      let st: FirstStartFileStat
      try {
        canonical = await deps.realpath(program)
        if (typeof canonical !== 'string' || !DRIVE_OR_SHARE.test(canonical) || windowsPathHasTrailingDotOrSpace(canonical)) return { outcome: 'skipped', reason: 'refused-path' }
        if (!/\.exe$/i.test(canonical)) return { outcome: 'skipped', reason: 'not-exe' }
        st = await deps.stat(canonical)
      } catch {
        return { outcome: 'skipped', reason: 'unreadable' }
      }
      if (!st || st.isFile !== true) return { outcome: 'skipped', reason: 'unreadable' }
      const key = firstStartIdentityKey(canonical, st)
      if (warmed.has(key)) return { outcome: 'skipped', reason: 'already-warm' }
      const name = programBaseName(canonical)
      let entry = inFlight.get(key)
      if (!entry) {
        const startedAt = deps.now()
        const created = { done: runOnce(key, canonical, envSource, name), startedAt }
        entry = created
        inFlight.set(key, created)
        const forget = () => { if (inFlight.get(key) === created) inFlight.delete(key) }
        void created.done.then(forget, forget)
      }
      return await waitFor(entry, name)
    } catch {
      return { outcome: 'skipped', reason: 'unreadable' }
    }
  }

  return {
    warm,
    stopAll: () => {
      for (const w of [...workers]) { try { w.stop() } catch { /* best effort at quit */ } }
    },
  }
}

/** The worker's shared state (see first-start-worker.cjs), when this process
 *  can share memory with a worker; null otherwise (the quit then asks the
 *  worker to stop without waiting for it). */
function sharedState(): Int32Array | null {
  try { return typeof SharedArrayBuffer === 'function' ? new Int32Array(new SharedArrayBuffer(4)) : null } catch { return null }
}

/** Starts one request in a new worker thread. The worker's own environment is
 *  empty: the program gets exactly `request.env`. */
export function startFirstStartWorker(request: FirstStartRequest): FirstStartWorker {
  const state = sharedState()
  const worker = new Worker(FIRST_START_WORKER_SOURCE, {
    eval: true,
    workerData: { request, ...(state ? { state } : {}) },
    env: {},
  })
  worker.unref()
  const result = new Promise<FirstStartRun>((resolve) => {
    let done = false
    const settle = (r: FirstStartRun) => { if (!done) { done = true; resolve(r) } }
    worker.once('message', (m: unknown) => {
      const a = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>
      settle({
        exitCode: typeof a.exitCode === 'number' ? a.exitCode : null,
        timedOut: a.timedOut === true,
        ...(typeof a.spawnError === 'string' ? { spawnError: a.spawnError } : {}),
        ...(typeof a.startMs === 'number' ? { startMs: a.startMs } : {}),
        ...(typeof a.stdout === 'string' ? { stdout: a.stdout } : {}),
      })
    })
    worker.once('error', () => settle(failed('worker-failed')))
    worker.once('exit', () => settle(failed('worker-ended')))
  })
  return {
    result,
    stop: () => {
      // Not started yet: it never will be.
      if (state && Atomics.compareExchange(state, 0, 0, 3) === 0) return
      try { worker.postMessage('stop') } catch { /* already ended */ }
      if (!state) return
      // Starting or running: wait, bounded, for the worker to end it.
      const until = Date.now() + STOP_WAIT_MS
      for (;;) {
        const s = Atomics.load(state, 0)
        const left = until - Date.now()
        if (s !== 1 || left <= 0) return
        try { Atomics.wait(state, 0, 1, left) } catch { return }
      }
    },
  }
}

let shared: ReturnType<typeof createFirstStartWarmup> | null = null
function warmup(): ReturnType<typeof createFirstStartWarmup> {
  if (!shared) {
    shared = createFirstStartWarmup({
      platform: () => process.platform,
      // realpath.native semantics; never on the main thread's own time.
      realpath: (p) => fs.promises.realpath(p),
      stat: async (p) => {
        // bigint: NTFS file ids exceed 2^53.
        const s = await fs.promises.stat(p, { bigint: true })
        return { size: Number(s.size), mtimeMs: Number(s.mtimeMs), dev: String(s.dev), ino: String(s.ino), isFile: s.isFile() }
      },
      startWorker: startFirstStartWorker,
      log: (m) => logInfo(m),
      now: () => Date.now(),
    })
  }
  return shared
}

/** Before a main-process caller's own start of `program`: its first start
 *  this run, off the main thread (see the header). Never rejects. */
export function warmFirstStart(program: string, env: FirstStartEnvSource): Promise<FirstStartOutcome> {
  return warmup().warm(program, env)
}

/** At app quit: a warm-up's program still running is ended. Never throws. */
export function flushFirstStartWarmups(): void {
  try { shared?.stopAll() } catch { /* best effort at quit */ }
}
