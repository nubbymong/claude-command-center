/**
 * Run a GUI-subsystem tool from the console-less main process and capture what
 * it prints (#379, fix A).
 *
 * This is the whole point of the issue. Electron's main process has no console,
 * so when the child does `AttachConsole(ATTACH_PARENT_PROCESS)` there is nothing
 * to attach to: the call fails, the `freopen("CONOUT$")` behind it fails with
 * it, and the pipes we handed the child survive. Measured: 5621 bytes captured,
 * nothing painted over anyone's TUI.
 *
 * SECURITY POSTURE — this is a renderer-reachable spawn, so it is deliberately
 * the narrowest one in the app:
 *
 *  - `shell: false`, always, and argv is an ARRAY. Nothing is ever concatenated
 *    into a command string, so there is no shell to inject into.
 *  - The file spawned is the ABSOLUTE PATH we resolved and then read. The OS is
 *    never asked to search PATH again, so the file that was sniffed is the file
 *    that runs (modulo the TOCTOU note below).
 *  - It REFUSES anything that is not a GUI-subsystem PE image. A `.cmd`/`.bat`
 *    shim is not a PE, so the CVE-2024-27980 argument-injection class that
 *    `scripts/resume-picker.js` documents cannot be reached from here at all.
 *    A console-subsystem exe is refused too: it has no bleed problem, so routing
 *    it here would only widen the surface for no benefit.
 *  - `detached: false`. DETACHED_PROCESS is what leaves a child with no console
 *    of its own, which is precisely the state in which it goes hunting for its
 *    parent's — it is never a fix here (issue #379, matrix row 2).
 *  - Output is capped, the run is capped, and concurrency is capped.
 *
 * It grants the renderer no NEW capability: a command button already types an
 * arbitrary line into a live shell, which is strictly more than "start one
 * GUI-subsystem exe with an argv array and no shell". What it adds is a parent
 * without a console.
 *
 * TOCTOU: between the sniff and the spawn the file could be swapped. That is not
 * a boundary this can close (an attacker who can rewrite an executable on the
 * user's PATH has already won), and the sniff is a UX hint, not an
 * authorisation — the user picked this command themselves.
 */
import { spawn as nodeSpawn, execFile, type ChildProcess } from 'child_process'
import { StringDecoder } from 'string_decoder'
import { randomId } from '../shared/id'
import { resolveCwd } from './path-utils'
import { firstToken, resolveExecutable } from './resolve-executable'
import { sniffExecutableSubsystem } from './pe-subsystem'
import {
  CAPTURED_RUN_MAX_BYTES,
  CAPTURED_RUN_MAX_CONCURRENT,
  CAPTURED_RUN_TIMEOUT_MS,
  type CapturedRunChunk,
  type CapturedRunExit,
  type CapturedRunStart,
  type ExeSubsystem,
} from '../shared/gui-exe'

/** Most argv elements we will pass on. A command button's arguments are a short
 *  list the user typed; a line with hundreds of tokens is not one. */
const MAX_ARGS = 128
/** Longest single argument. */
const MAX_ARG_LEN = 4096

/**
 * Both callbacks carry the `runId` in the payload rather than leaving the caller
 * to remember the one `start()` returned. The first chunk of a fast process can
 * land before that promise resolves, so a caller that closed over the returned
 * id would drop it.
 */
export interface CapturedRunEvents {
  onChunk: (chunk: CapturedRunChunk) => void
  onExit: (exit: CapturedRunExit) => void
}

export interface CapturedRunnerDeps {
  spawn?: typeof nodeSpawn
  sniff?: (p: string) => Promise<ExeSubsystem>
  resolve?: (token: string, cwd: string) => string | null
  resolveWorkingDir?: (cwd: string | undefined) => string
  now?: () => number
  newId?: () => string
  killTree?: (pid: number) => void
  platform?: NodeJS.Platform
}

export interface StartOptions {
  /** The command line exactly as the button would have typed it. */
  command: string
  cwd?: string
}

interface ActiveRun {
  child: ChildProcess
  timer: ReturnType<typeof setTimeout>
}

/**
 * Split the argument part of a typed line into argv.
 *
 * `buildCommandLine` (shared/command-secret) joins the user's arguments with a
 * single space and quotes NOTHING — "an argument containing a space arrives as
 * two", as its comment says, and the dialog tells the user so. This splitter
 * therefore has exactly one job: reproduce what the shell would have handed the
 * program, for the two spellings a user actually writes. Quotes group; a
 * backslash is NOT an escape (on Windows it is a path separator, and treating it
 * as an escape would mangle every path).
 */
export function splitArgs(rest: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let started = false

  for (const ch of rest) {
    if (quote) {
      if (ch === quote) { quote = null; continue }
      cur += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue }
    if (/\s/.test(ch)) {
      if (started) { out.push(cur); cur = ''; started = false }
      continue
    }
    cur += ch
    started = true
  }
  if (started) out.push(cur)
  return out
}

function defaultKillTree(pid: number): void {
  if (process.platform !== 'win32') return
  // Same recipe the vision and cloud-agent managers use. `pid` is a number taken
  // off the ChildProcess, never a string from anywhere else.
  execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => { /* best effort */ })
}

export interface CapturedRunner {
  start: (opts: StartOptions, events: CapturedRunEvents) => Promise<CapturedRunStart>
  cancel: (runId: string) => boolean
  cancelAll: () => void
  activeCount: () => number
}

export function createCapturedRunner(deps: CapturedRunnerDeps = {}): CapturedRunner {
  const spawn = deps.spawn ?? nodeSpawn
  const sniff = deps.sniff ?? sniffExecutableSubsystem
  const resolveWorkingDir = deps.resolveWorkingDir ?? resolveCwd
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? randomId
  const killTree = deps.killTree ?? defaultKillTree
  const platform = deps.platform ?? process.platform
  const resolve =
    deps.resolve ??
    ((token: string, cwd: string) =>
      resolveExecutable(token, { cwd, pathEnv: process.env.PATH, pathExt: process.env.PATHEXT, platform }))

  const active = new Map<string, ActiveRun>()

  const cancel = (runId: string): boolean => {
    const run = active.get(runId)
    if (!run) return false
    try { run.child.kill() } catch { /* already gone */ }
    if (run.child.pid) killTree(run.child.pid)
    return true
  }

  const start = async (opts: StartOptions, events: CapturedRunEvents): Promise<CapturedRunStart> => {
    if (active.size >= CAPTURED_RUN_MAX_CONCURRENT) {
      return { runId: null, exePath: null, error: `Too many captured runs already going (${CAPTURED_RUN_MAX_CONCURRENT}).` }
    }

    const parsed = firstToken(opts.command)
    if (!parsed) return { runId: null, exePath: null, error: 'That command line has no program in it.' }

    const cwd = resolveWorkingDir(opts.cwd)
    const exePath = resolve(parsed.token, cwd)
    if (!exePath) {
      return { runId: null, exePath: null, error: `Could not find ${parsed.token} on PATH.` }
    }

    // THE GATE. Only a GUI-subsystem PE gets a console-less parent; everything
    // else keeps its existing route. See the header for why this is narrow on
    // purpose.
    const subsystem = await sniff(exePath)
    if (subsystem !== 'gui') {
      return {
        runId: null,
        exePath,
        error: `${exePath} is not a GUI-subsystem program (${subsystem}); it does not need the console-less path.`,
      }
    }

    const args = splitArgs(parsed.rest)
    if (args.length > MAX_ARGS) {
      return { runId: null, exePath, error: `Too many arguments (${args.length} > ${MAX_ARGS}).` }
    }
    if (args.some((a) => a.length > MAX_ARG_LEN)) {
      return { runId: null, exePath, error: 'One of the arguments is too long.' }
    }

    const runId = newId()
    const startedAt = now()

    let child: ChildProcess
    try {
      child = spawn(exePath, args, {
        cwd,
        // The whole fix: main has no console, and these pipes are not replaced
        // because the freopen("CONOUT$") behind AttachConsole has nothing to
        // reopen onto. stdin is ignored — this is a non-interactive capture, and
        // a tool that blocked on input would otherwise hang forever unseen.
        stdio: ['ignore', 'pipe', 'pipe'],
        // Belt and braces for the GUI half: the tool may also want to show a
        // window. windowsHide only suppresses a CONSOLE window, so a real GUI
        // still appears — which is what the user asked for by running it.
        windowsHide: true,
        // NEVER true. See the header.
        detached: false,
        // NEVER true. argv is an array precisely so there is no shell.
        shell: false,
      })
    } catch (err) {
      return { runId: null, exePath, error: err instanceof Error ? err.message : 'Could not start that program.' }
    }

    let truncated = false
    let settled = false
    const budget = { stdout: CAPTURED_RUN_MAX_BYTES, stderr: CAPTURED_RUN_MAX_BYTES }

    const pipe = (stream: 'stdout' | 'stderr', src: NodeJS.ReadableStream | null): void => {
      if (!src) return
      // A decoder per stream so a multi-byte character split across two chunks
      // is not turned into two replacement characters.
      const decoder = new StringDecoder('utf8')
      src.on('data', (buf: Buffer) => {
        if (budget[stream] <= 0) { truncated = true; return }
        const slice = buf.length > budget[stream] ? buf.subarray(0, budget[stream]) : buf
        if (slice.length < buf.length) truncated = true
        budget[stream] -= slice.length
        const text = decoder.write(slice)
        if (text) events.onChunk({ runId, stream, chunk: text })
      })
      src.on('error', () => { /* the exit/error handler reports it */ })
    }

    pipe('stdout', child.stdout)
    pipe('stderr', child.stderr)

    const finish = (exit: Omit<CapturedRunExit, 'runId'>): void => {
      if (settled) return
      settled = true
      const run = active.get(runId)
      if (run) { clearTimeout(run.timer); active.delete(runId) }
      events.onExit({ runId, ...exit })
    }

    const timer = setTimeout(() => {
      cancel(runId)
      finish({ code: null, signal: 'SIGKILL', truncated, durationMs: now() - startedAt, error: 'Timed out.' })
    }, CAPTURED_RUN_TIMEOUT_MS)
    // The timer must not hold the app open at quit.
    if (typeof timer.unref === 'function') timer.unref()

    active.set(runId, { child, timer })

    child.on('error', (err: Error) => {
      finish({ code: null, signal: null, truncated, durationMs: now() - startedAt, error: err.message })
    })
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      finish({ code, signal: signal ?? null, truncated, durationMs: now() - startedAt })
    })

    return { runId, exePath }
  }

  return {
    start,
    cancel,
    cancelAll: () => { for (const id of [...active.keys()]) cancel(id) },
    activeCount: () => active.size,
  }
}
