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
 * tails transcript files itself, so there is no hot-path capture in main (the
 * old capture/log-db/log-worker stack was removed in the deletion sweep).
 *
 * IMPORTANT import-graph rule: this module imports ONLY the supervisor, the
 * worker FORK helper, and readConfig. It must NEVER import `./transcripts-db`
 * or `./transcripts-worker` — those load better-sqlite3, which lives ONLY in
 * the forked worker (out/main/transcripts-worker.js). Pulling either in here
 * would drag the native dep into the main-process bundle.
 *
 * No default export (project convention).
 */
import { LogSupervisor } from './log-supervisor'
import { forkTranscriptsWorker } from './fork-transcripts-worker'
import { makeTranscriptBinder } from './transcript-binder'
import type { TranscriptBinder } from './transcript-binder'
import { readConfig } from '../config-manager'
import { logInfo } from '../debug-logger'
import { getRememberedName, writeNameSidecar, nodeNameSidecarDeps } from './session-name-sidecar'

// Module-level singleton. Null until initLogging() runs, and stays null when
// logging is disabled (no fork, no worker, no native dep loaded).
let _supervisor: LogSupervisor | null = null
// The transcript binder (Logs v2, Task 8): the single debounced sink both
// discovery sources feed (hooks gateway + statusline watcher). Created alongside
// the supervisor; null when logging is disabled.
let _binder: TranscriptBinder | null = null

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
  // Bind discovery sources to this supervisor. Uses Task-3 canonicalize + the
  // real ~/.claude/projects heuristic binder (defaults inside makeTranscriptBinder).
  // Diagnostics flow to the main app.log via the injected logInfo (paths only) so
  // first-/resumed-session bind failures are visible after the fact.
  // #480: `persist` writes the durable session->conversation record on every
  // exact bind, so restart resume has a crash-durable authoritative source.
  _binder = makeTranscriptBinder({
    supervisor: sup,
    log: logInfo,
    persist: (sessionId, path, uuid) => sup.persistSessionConversation(sessionId, path, uuid),
    // #536: when the exact transcript path becomes known, flush any CCC name that
    // was set for this session (e.g. renamed before the bind) to its sidecar.
    onExactBind: (sessionId, path) => {
      const name = getRememberedName(sessionId)
      if (name) writeNameSidecar(path, name, nodeNameSidecarDeps)
    },
  })
}

/** The supervisor, for run lifecycle + diagnostics + the read path. Null when disabled. */
export function getLogSupervisor(): LogSupervisor | null {
  return _supervisor
}

/** The transcript binder (discovery sink). Null when logging is disabled. T8b
 *  reads `getTranscriptBinder()?.getLatestTranscriptPath(sessionId)` to resume. */
export function getTranscriptBinder(): TranscriptBinder | null {
  return _binder
}

/**
 * Tear down on quit: best-effort graceful worker close + kill. Safe to call
 * when never initialised / disabled — the ref is null.
 */
export function shutdownLogging(): void {
  _supervisor?.shutdown()
  _supervisor = null
  _binder = null
}

/** Test seam: reset module state so each test starts clean. Not used in production. */
export function _resetLoggingForTest(): void {
  _supervisor = null
  _binder = null
}
