import * as fs from 'fs'
import * as path from 'path'
import { getDataDirectory } from './data-paths'

// Lazy-initialized: can't call getDataDirectory() at module load time
let LOG_DIR: string | null = null
let LOG_FILE: string | null = null

function getLogDirPath(): string {
  if (!LOG_DIR) {
    LOG_DIR = path.join(getDataDirectory(), 'debug')
  }
  return LOG_DIR
}

function getLogFilePath(): string {
  if (!LOG_FILE) {
    LOG_FILE = path.join(getLogDirPath(), 'app.log')
  }
  return LOG_FILE
}
const MAX_LOG_SIZE = 10 * 1024 * 1024 // 10MB
// Bounds a single formatted record (round-1 adversarial finding, MINOR): a
// single huge logError() call used to write past MAX_LOG_SIZE in one shot
// before the running-total check ever ran. Generous enough for a real stack
// trace; small enough that no single call can blow the rotation budget.
const MAX_RECORD_BYTES = 256 * 1024 // 256KB

let logStream: fs.WriteStream | null = null
// Bytes written to `logStream` since it was opened, seeded from the on-disk
// size of any pre-existing file at open time. Checked on every write (#487-B):
// a long-lived stream that only rotated at CREATION time never re-checked size,
// so a hot logger grew app.log without bound (observed: a 68GB app.log.1).
// Tracked in-process rather than via WriteStream.bytesWritten, which only
// counts bytes the OS has actually flushed and can lag a burst of writes.
let streamBytes = 0
// Set synchronously by writeToLog the instant `streamBytes` crosses the cap.
// openStream() honours this UNCONDITIONALLY on the next reopen (round-1
// adversarial finding, BLOCKER): re-deriving the rotate decision from
// fs.statSync() races the prior stream's async flush -- a synchronous write
// burst (no await) could cross the cap, end() the stream, and have the very
// next write's statSync() still see the pre-flush (smaller) on-disk size, so
// it skipped rotation AND reseeded `streamBytes` from that stale, too-small
// number -- the counter then never reached the cap again. This flag makes the
// in-process byte counter authoritative: rotation is a deterministic
// consequence of OUR OWN decision, never a re-read of a racing stat.
let mustRotate = false
let verboseMode = false
// Sticky channel-level baseline (beta builds default verbose ON). Kept separate
// from the debug toggle so turning debug mode off can't silence beta verbose
// logging (setVerboseMode ORs with it).
let verboseBaseline = false
let traceMode = false

/** Set the verbose baseline (beta builds enable this at boot). Never lowered by
 *  the debug-mode toggle. */
export function setVerboseBaseline(enabled: boolean): void {
  verboseBaseline = enabled
  verboseMode = verboseMode || enabled
}

export function setVerboseMode(enabled: boolean): void {
  verboseMode = enabled || verboseBaseline
}

export function isVerboseMode(): boolean {
  return verboseMode
}

/** Trace = the highest-volume, per-event diagnostics (e.g. every hook request).
 *  Gated SEPARATELY from verbose so beta-default verbose logging does NOT enable
 *  the hot per-tool-call logs -- that keeps verbose-on-beta perf-neutral. Opt-in
 *  only (not enabled by the channel baseline). */
export function setTraceMode(enabled: boolean): void {
  traceMode = enabled
}

export function isTraceMode(): boolean {
  return traceMode
}

function ensureLogDir() {
  const dir = getLogDirPath()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

// Renames logFile -> .1, cascading any existing .1/.2 up to .3 (oldest
// dropped). Renaming does not disturb a still-open WriteStream fd pointed at
// that inode (true on POSIX always, and on Windows because Node opens files
// with FILE_SHARE_DELETE) -- so this is safe to call even while a just-ended
// stream is still flushing its last buffered bytes to the now-renamed file.
function rotateLogFiles(logFile: string) {
  const rot3 = `${logFile}.3`
  const rot2 = `${logFile}.2`
  const rot1 = `${logFile}.1`
  try { if (fs.existsSync(rot3)) fs.unlinkSync(rot3) } catch { /* ignore */ }
  try { if (fs.existsSync(rot2)) fs.renameSync(rot2, rot3) } catch { /* ignore */ }
  try { if (fs.existsSync(rot1)) fs.renameSync(rot1, rot2) } catch { /* ignore */ }
  try { if (fs.existsSync(logFile)) fs.renameSync(logFile, rot1) } catch { /* ignore */ }
}

/** Cold-start-only stat-based rotation: used ONLY when this process has no
 *  in-process byte-count history to trust (the very first stream this process
 *  opens), to catch a file a PRIOR process left oversized. Never used to
 *  decide rotation for a stream WE ourselves just closed -- see `mustRotate`. */
function rotateIfNeeded() {
  try {
    const logFile = getLogFilePath()
    if (fs.existsSync(logFile)) {
      const stat = fs.statSync(logFile)
      if (stat.size > MAX_LOG_SIZE) {
        if (logStream) {
          logStream.end()
          logStream = null
        }
        rotateLogFiles(logFile)
      }
    }
  } catch { /* ignore */ }
}

/** Opens a fresh log stream. Rotation is decided ONE OF TWO ways, never both:
 *
 *  - `mustRotate` set (writeToLog crossed MAX_LOG_SIZE on the PRIOR stream):
 *    rotate UNCONDITIONALLY and reset `streamBytes` to 0. Deliberately does
 *    NOT re-derive this decision from fs.statSync() -- that stat can lag the
 *    prior stream's async flush (a synchronous write burst crosses the cap
 *    well before the OS has written it out), which used to both skip
 *    rotation and reseed `streamBytes` from the stale, too-small on-disk
 *    size, so the counter never reached the cap again (#487 round-1 BLOCKER).
 *
 *  - Cold start (no `mustRotate`, i.e. the first stream this process opens):
 *    no in-process history exists yet, so fall back to a stat-based check for
 *    a file a prior process left oversized, and seed `streamBytes` from disk
 *    -- there is nothing else to seed it from at this point. */
function openStream(): fs.WriteStream {
  ensureLogDir()
  const filePath = getLogFilePath()
  if (mustRotate) {
    rotateLogFiles(filePath)
    mustRotate = false
    streamBytes = 0
  } else {
    rotateIfNeeded()
    let existingSize = 0
    try { existingSize = fs.statSync(filePath).size } catch { /* file doesn't exist yet */ }
    streamBytes = existingSize
  }
  // Open the fd SYNCHRONOUSLY and hand it to createWriteStream, instead of
  // letting the stream open it internally (which is asynchronous -- Node
  // schedules the actual open() syscall on the libuv threadpool and only
  // creates the on-disk file once that completes). In a genuinely synchronous
  // write burst (no await, no setImmediate) the event loop never turns, so an
  // async-opened file may not exist on disk yet even after many writes have
  // been queued into the stream's internal buffer -- which made the
  // rotateLogFiles() rename above a silent no-op the first time this ran
  // (fs.existsSync(filePath) was false), and every subsequent "rotated"
  // stream kept opening the SAME still-nonexistent path, so all of them
  // converged on one growing file once the opens finally settled (#487
  // round-1 BLOCKER, synchronous-burst case). Opening the fd here makes file
  // existence unconditional and immediate, so the NEXT crossing's
  // rotateLogFiles() can always find and rename the real file.
  const fd = fs.openSync(filePath, 'a')
  const stream = fs.createWriteStream(filePath, { fd })
  // A stream-level write failure (ENOSPC, EBADF, permission loss) must never be
  // left as an unhandled 'error' event -- that becomes an uncaughtException,
  // which (before this fix) re-entered logError -> getStream -> another failing
  // write, a second crash-loop entry point distinct from #487-A (audit, high).
  // Deliberately does NOT call logError: logging the failure is exactly the
  // write that just failed.
  stream.on('error', () => {
    if (logStream === stream) logStream = null
  })
  return stream
}

function getStream(): fs.WriteStream | null {
  if (logStream && !logStream.destroyed) return logStream
  try {
    logStream = openStream()
    return logStream
  } catch {
    // If data directory resolution fails, fall back to console-only logging
    return null
  }
}

/**
 * One log record is one physical line: `[<iso>] [<LEVEL>] <message>\n`.
 *
 * So a CR or LF anywhere INSIDE `message` ends the record early and everything
 * after it becomes a line the value's author fully controls -- including a
 * fabricated timestamp, level and subsystem tag. Plenty of values interpolated
 * into log lines here are remote-influenced (a transcript path off an SSH
 * sentinel, a hook body field), and forging `[ERROR] [ssh] ...` records is a
 * cheap way to mislead whoever reads the log after an incident. Flooding evicts
 * genuine history through rotation for the same reason.
 *
 * Escaped at the SINK rather than at each caller: the callers are many, several
 * are on hot paths, and one that forgets is invisible until someone reads the
 * log. A stack trace's own newlines are preserved -- those are ours and a reader
 * needs them -- by escaping each arg before the multi-line Error case is joined.
 */
function stripRecordBreaks(s: string): string {
  return s.includes('\n') || s.includes('\r')
    ? s.replace(/\r/g, '\\r').replace(/\n/g, '\\n')
    : s
}

function formatMessage(level: string, ...args: unknown[]): string {
  const timestamp = new Date().toISOString()
  const message = args.map(arg => {
    if (arg instanceof Error) {
      // Our own stack — keep it readable across lines.
      return `${stripRecordBreaks(arg.message)}\n${arg.stack}`
    }
    if (typeof arg === 'object') {
      try { return stripRecordBreaks(JSON.stringify(arg)) } catch { return stripRecordBreaks(String(arg)) }
    }
    return stripRecordBreaks(String(arg))
  }).join(' ')
  return `[${timestamp}] [${level}] ${message}\n`
}

/**
 * Single write sink for every log level. Tracks bytes written to the CURRENT
 * stream instance and rotates the instant the running total crosses
 * MAX_LOG_SIZE (#487-B), instead of only re-checking size when a new stream
 * happens to get created. Ending the stream here, nulling it out, and setting
 * `mustRotate` means the very next call reopens via getStream() ->
 * openStream(), which rotates the now-oversized file UNCONDITIONALLY (not via
 * a racing statSync) before appending further.
 */
function writeToLog(formatted: string): void {
  const stream = getStream()
  if (!stream) return
  let toWrite = formatted
  if (Buffer.byteLength(toWrite) > MAX_RECORD_BYTES) {
    // A single absurdly large record (round-1 adversarial finding, MINOR)
    // must never itself exceed the rotation budget -- truncate before it
    // ever reaches stream.write(), not after.
    const marker = '...[truncated]\n'
    const budget = MAX_RECORD_BYTES - Buffer.byteLength(marker)
    toWrite = Buffer.from(toWrite, 'utf8').subarray(0, budget).toString('utf8') + marker
  }
  stream.write(toWrite)
  streamBytes += Buffer.byteLength(toWrite)
  if (streamBytes >= MAX_LOG_SIZE) {
    mustRotate = true
    stream.end()
    if (logStream === stream) logStream = null
  }
}

/** Only writes when verbose/debug mode is enabled */
export function logDebug(...args: unknown[]): void {
  if (!verboseMode) return
  writeToLog(formatMessage('DEBUG', ...args))
}

/** Per-event hot-path diagnostics (every hook request, etc.). Writes ONLY in
 *  trace mode -- early-returns under plain verbose/beta so it costs nothing on
 *  the hot path unless explicitly opted in. */
export function logTrace(...args: unknown[]): void {
  if (!traceMode) return
  writeToLog(formatMessage('TRACE', ...args))
}

export function logInfo(...args: unknown[]): void {
  writeToLog(formatMessage('INFO', ...args))
  // A broken stdout pipe must never escape as a thrown exception from inside a
  // logging call (#487 audit): the file line above already landed.
  try { console.log(...args) } catch { /* stdout gone */ }
}

export function logWarn(...args: unknown[]): void {
  writeToLog(formatMessage('WARN', ...args))
  try { console.warn(...args) } catch { /* stderr gone */ }
}

export function logError(...args: unknown[]): void {
  writeToLog(formatMessage('ERROR', ...args))
  try { console.error(...args) } catch { /* stderr gone */ }
}

export function getLogDir(): string {
  return getLogDirPath()
}

export function closeDebugLogger(): void {
  if (logStream) {
    logStream.end()
    logStream = null
  }
}

// Re-entrancy guard for the uncaughtException handler below (#487-A). Scoped to
// the synchronous body of ONE invocation: if handling the current exception
// somehow re-triggers the same handler before it returns (the historical bug --
// logError -> console.error -> throws EPIPE -> Node re-emits uncaughtException
// -> handler runs again -> repeat), the re-entrant call returns immediately
// instead of logging and rethrowing again. Reset in `finally` so a LATER,
// unrelated exception is still handled normally.
let inUncaughtExceptionHandler = false

// Capture unhandled errors
export function installGlobalErrorHandlers(): void {
  // A handled stream 'error' event never becomes an uncaughtException, so
  // console.* on a broken pipe degrades to a silent no-op instead of feeding
  // the exception machinery below at all (#487 audit, medium). Belt-and-
  // suspenders with the try/catch around each console.* call above.
  process.stdout.on('error', () => { /* broken pipe: drop it, file logging continues */ })
  process.stderr.on('error', () => { /* same */ })

  process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
    if (inUncaughtExceptionHandler) return
    inUncaughtExceptionHandler = true
    try {
      // EPIPE/EIO from a dead PTY/stdout pipe FIRST, and BEFORE any console
      // write -- logging through logError (which calls console.error) on a
      // broken pipe was exactly what re-emitted the next EPIPE as a fresh
      // uncaughtException (#487-A). Write straight to the file stream instead.
      if (err.code === 'EPIPE' || err.code === 'EIO') {
        try {
          writeToLog(formatMessage('ERROR', 'Uncaught exception (suppressed):', err))
        } catch { /* never let the handler throw */ }
        return
      }
      logError('Uncaught exception:', err)
      // For other errors, still throw to crash properly
      throw err
    } finally {
      inUncaughtExceptionHandler = false
    }
  })

  process.on('unhandledRejection', (reason) => {
    // Second broken-pipe entry point (#487 audit, high): an unhandled rejection
    // occurring while stdout/stderr is broken hit the same unguarded
    // logError -> console.error path with no suppression at all.
    const code = (reason as NodeJS.ErrnoException | null | undefined)?.code
    if (code === 'EPIPE' || code === 'EIO') {
      try {
        writeToLog(formatMessage('ERROR', 'Unhandled rejection (suppressed):', reason))
      } catch { /* never let the handler throw */ }
      return
    }
    logError('Unhandled rejection:', reason)
  })
}

/**
 * P8.18: redact accountEmail from a statusline payload before logging.
 * The email survives in tokenomics.json (its purpose) but doesn't need
 * to appear in app.log where it would be harder to scrub.
 */
export function redactStatuslinePayload<T extends { accountEmail?: string }>(payload: T): T {
  if (typeof payload?.accountEmail !== 'string') return payload
  return { ...payload, accountEmail: '<redacted>' }
}
