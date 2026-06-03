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

let logStream: fs.WriteStream | null = null
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

function rotateIfNeeded() {
  try {
    const logFile = getLogFilePath()
    if (fs.existsSync(logFile)) {
      const stat = fs.statSync(logFile)
      if (stat.size > MAX_LOG_SIZE) {
        // Close existing stream
        if (logStream) {
          logStream.end()
          logStream = null
        }
        // Keep up to 3 rotated logs
        const rot3 = `${logFile}.3`
        const rot2 = `${logFile}.2`
        const rot1 = `${logFile}.1`
        try { if (fs.existsSync(rot3)) fs.unlinkSync(rot3) } catch { /* ignore */ }
        try { if (fs.existsSync(rot2)) fs.renameSync(rot2, rot3) } catch { /* ignore */ }
        try { if (fs.existsSync(rot1)) fs.renameSync(rot1, rot2) } catch { /* ignore */ }
        fs.renameSync(logFile, rot1)
      }
    }
  } catch { /* ignore */ }
}

function getStream(): fs.WriteStream | null {
  if (logStream && !logStream.destroyed) return logStream
  try {
    ensureLogDir()
    rotateIfNeeded()
    logStream = fs.createWriteStream(getLogFilePath(), { flags: 'a' })
    return logStream
  } catch {
    // If data directory resolution fails, fall back to console-only logging
    return null
  }
}

function formatMessage(level: string, ...args: unknown[]): string {
  const timestamp = new Date().toISOString()
  const message = args.map(arg => {
    if (arg instanceof Error) {
      return `${arg.message}\n${arg.stack}`
    }
    if (typeof arg === 'object') {
      try { return JSON.stringify(arg) } catch { return String(arg) }
    }
    return String(arg)
  }).join(' ')
  return `[${timestamp}] [${level}] ${message}\n`
}

/** Only writes when verbose/debug mode is enabled */
export function logDebug(...args: unknown[]): void {
  if (!verboseMode) return
  const stream = getStream()
  stream?.write(formatMessage('DEBUG', ...args))
}

/** Per-event hot-path diagnostics (every hook request, etc.). Writes ONLY in
 *  trace mode -- early-returns under plain verbose/beta so it costs nothing on
 *  the hot path unless explicitly opted in. */
export function logTrace(...args: unknown[]): void {
  if (!traceMode) return
  const stream = getStream()
  stream?.write(formatMessage('TRACE', ...args))
}

export function logInfo(...args: unknown[]): void {
  const stream = getStream()
  stream?.write(formatMessage('INFO', ...args))
  console.log(...args)
}

export function logWarn(...args: unknown[]): void {
  const stream = getStream()
  stream?.write(formatMessage('WARN', ...args))
  console.warn(...args)
}

export function logError(...args: unknown[]): void {
  const stream = getStream()
  stream?.write(formatMessage('ERROR', ...args))
  console.error(...args)
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

// Capture unhandled errors
export function installGlobalErrorHandlers(): void {
  process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
    logError('Uncaught exception:', err)
    // Suppress EPIPE/EIO from PTY
    if (err.code === 'EPIPE' || err.code === 'EIO') {
      return
    }
    // For other errors, still throw to crash properly
    throw err
  })

  process.on('unhandledRejection', (reason) => {
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
