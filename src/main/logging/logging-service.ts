/**
 * logging-service.ts — module-level lifecycle owner for the SQLite logging stack.
 *
 * Encapsulates the LogSupervisor (owns the forked worker) + the LogCapture (the
 * hot-path per-session buffer) so neither index.ts nor pty-manager.ts constructs
 * them directly. index.ts calls initLogging() once at boot and shutdownLogging()
 * on quit; pty-manager calls getLogCapture() per spawn.
 *
 * IMPORTANT import-graph rule: this module imports ONLY the supervisor, the
 * capture factory, the worker FORK helper, and readConfig. It must NEVER import
 * `./log-db` or `./log-worker` — those load better-sqlite3, which lives ONLY in
 * the forked worker (out/main/log-worker.js). Pulling either in here would drag
 * the native dep into the main-process bundle. (The supervisor + capture + fork
 * helper are all native-free by the same rule.)
 *
 * No default export (project convention).
 */
import { LogSupervisor } from './log-supervisor'
import { makeCapture } from './log-capture'
import type { LogCapture } from './log-capture'
import { forkLogWorker } from './fork-log-worker'
import { readConfig } from '../config-manager'

// Module-level singletons. Both null until initLogging() runs, and both stay
// null when logging is disabled (no fork, no worker, no native dep loaded).
let _supervisor: LogSupervisor | null = null
let _capture: LogCapture | null = null

/**
 * Boot the logging stack. Reads `loggingEnabled` from the 'settings' config with
 * default-true semantics (off only when explicitly false). When DISABLED this is
 * a no-op: capture stays null, no worker is forked, and the native dep is never
 * loaded. When ENABLED it forks the worker, starts the supervisor (which
 * reconciles dangling sessions on its first ready), and wires the capture.
 *
 * Idempotent-safe: a second call while already initialised is a no-op.
 */
export function initLogging(opts: {
  emit: (channel: string, payload: unknown) => void
  dbPath: string
}): void {
  if (_supervisor) return   // already initialised — do not double-fork
  const settings = readConfig<{ loggingEnabled?: boolean }>('settings') ?? {}
  if (settings.loggingEnabled === false) return   // explicitly disabled → stay dark
  const sup = new LogSupervisor({
    forkChild: forkLogWorker,
    dbPath: opts.dbPath,
    emit: opts.emit,
  })
  sup.start()                       // forks the worker; reconcile() auto-fires on first ready
  const cap = makeCapture(sup)
  _supervisor = sup
  _capture = cap
}

/** The hot-path capture (null when disabled / not initialised). pty-manager uses this. */
export function getLogCapture(): LogCapture | null {
  return _capture
}

/** The supervisor, for diagnostics / the Phase 2 read path. Null when disabled. */
export function getLogSupervisor(): LogSupervisor | null {
  return _supervisor
}

/**
 * Flush + tear down on quit. Stops the capture timer (a final flushNow is driven
 * by the capture's own end-of-life path; we stop the periodic timer here) and
 * shuts the supervisor down (best-effort graceful worker close + kill). Safe to
 * call when never initialised / disabled — both refs are null.
 */
export function shutdownLogging(): void {
  _capture?.stop()
  _supervisor?.shutdown()
  _capture = null
  _supervisor = null
}

/** Test seam: reset module state so each test starts clean. Not used in production. */
export function _resetLoggingForTest(): void {
  _capture = null
  _supervisor = null
}
