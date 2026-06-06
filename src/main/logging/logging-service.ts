/**
 * logging-service.ts — module-level lifecycle owner for the SQLite logging stack
 * (Logs v2: the transcript-indexing worker).
 *
 * Encapsulates the LogSupervisor (owns the forked transcripts worker) so neither
 * index.ts nor pty-manager.ts constructs it directly. index.ts calls
 * initLogging() once at boot and shutdownLogging() on quit; pty-manager calls
 * getLogSupervisor()?.runStart/runEnd per spawn/exit.
 *
 * The old byte-capture wiring (makeCapture/getLogCapture) is GONE — the worker
 * tails transcript files itself, so there is no hot-path capture in main. The
 * log-capture.ts module remains on disk (with the rest of the old stack) until
 * the Phase-5 deletion sweep, but nothing routes to it anymore.
 *
 * IMPORTANT import-graph rule: this module imports ONLY the supervisor, the
 * worker FORK helper, and readConfig. It must NEVER import `./transcripts-db`
 * or `./transcripts-worker` (nor the old `./log-db`/`./log-worker`) — those
 * load better-sqlite3, which lives ONLY in the forked worker
 * (out/main/transcripts-worker.js). Pulling either in here would drag the
 * native dep into the main-process bundle.
 *
 * No default export (project convention).
 */
import { LogSupervisor } from './log-supervisor'
import { forkTranscriptsWorker } from './fork-transcripts-worker'
import { readConfig } from '../config-manager'

// Module-level singleton. Null until initLogging() runs, and stays null when
// logging is disabled (no fork, no worker, no native dep loaded).
let _supervisor: LogSupervisor | null = null

/**
 * Boot the logging stack. Reads `loggingEnabled` from the 'settings' config with
 * default-true semantics (off only when explicitly false). When DISABLED this is
 * a no-op: no worker is forked and the native dep is never loaded. When ENABLED
 * it forks the transcripts worker and starts the supervisor (the worker closes
 * dangling runs + resumes transcript tails itself on open).
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
    forkChild: forkTranscriptsWorker,
    dbPath: opts.dbPath,
    emit: opts.emit,
  })
  sup.start()   // forks the worker; it reconciles dangling runs itself on open
  _supervisor = sup
}

/** The supervisor, for run lifecycle + diagnostics + the read path. Null when disabled. */
export function getLogSupervisor(): LogSupervisor | null {
  return _supervisor
}

/**
 * Tear down on quit: best-effort graceful worker close + kill. Safe to call
 * when never initialised / disabled — the ref is null.
 */
export function shutdownLogging(): void {
  _supervisor?.shutdown()
  _supervisor = null
}

/** Test seam: reset module state so each test starts clean. Not used in production. */
export function _resetLoggingForTest(): void {
  _supervisor = null
}
