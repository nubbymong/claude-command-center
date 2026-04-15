import * as fs from 'fs'
import * as path from 'path'
import { getDataDirectory } from './ipc/setup-handlers'

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

export function setVerboseMode(enabled: boolean): void {
  verboseMode = enabled
}

export function isVerboseMode(): boolean {
  return verboseMode
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
