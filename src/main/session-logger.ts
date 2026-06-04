import * as fs from 'fs'
import * as fsp from 'fs/promises'
import * as path from 'path'
import * as readline from 'readline'
import { getDataDirectory } from './ipc/setup-handlers'
import { logError, logWarn } from './debug-logger'

// ---------------------------------------------------------------------------
// Error reporter indirection — allows tests to inject a fake reporter without
// fighting ESM spy binding restrictions on logError. Production code delegates
// through this; the test seam replaces it per-test.
// ---------------------------------------------------------------------------
type ErrorReporter = (msg: string, err?: unknown) => void

let _errorReporter: ErrorReporter = (msg, err) => {
  if (err !== undefined) logError(msg, err)
  else logError(msg)
}

/**
 * Test seam: replace the error reporter. Pass null to restore the default
 * logError delegate. Resetting warnedSessions here keeps each test isolated.
 */
export function _setErrorReporterForTest(fn: ErrorReporter | null): void {
  _errorReporter = fn ?? ((msg, err) => {
    if (err !== undefined) logError(msg, err)
    else logError(msg)
  })
  // Reset per-session warning dedup so tests start clean.
  warnedSessions.clear()
}

// ---------------------------------------------------------------------------
// Log root override — test seam so tests never touch real data directories.
// ---------------------------------------------------------------------------
let logRootOverride: string | null = null

/** Test seam: override the log root. Pass null to restore the real data dir. */
export function _setLogRootForTest(p: string | null): void {
  logRootOverride = p
}

// ---------------------------------------------------------------------------
// Log root resolution
// ---------------------------------------------------------------------------

// Get log base from custom data directory
function getLogBase(): string {
  if (logRootOverride !== null) return path.join(logRootOverride, 'logs')
  return path.join(getDataDirectory(), 'logs')
}

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_ROTATED = 10

interface LogEntry {
  ts: number
  type: 'data' | 'start' | 'end'
  data?: string
}

const activeStreams = new Map<string, fs.WriteStream>()
const sessionMeta = new Map<string, { configLabel: string; logDir: string; accountEmail?: string; profileId?: string }>()

/** Sessions for which a "no meta" warning has already been emitted. */
const warnedSessions = new Set<string>()

/** Persisted, account-aware metadata for a logged session. */
export interface SessionLogMeta {
  configLabel?: string
  accountEmail?: string
  profileId?: string
}

/**
 * Write the session's account metadata as a `meta.json` sidecar next to the
 * JSONL log. Persisting it (rather than relying on the in-memory map) lets
 * `listLogSessions` label historical sessions by account after a restart.
 * Undefined fields are omitted so we never serialise nulls.
 */
export function writeSessionMeta(logDir: string, meta: SessionLogMeta): void {
  try {
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true })
    const clean: SessionLogMeta = {}
    if (meta.configLabel !== undefined) clean.configLabel = meta.configLabel
    if (meta.accountEmail !== undefined) clean.accountEmail = meta.accountEmail
    if (meta.profileId !== undefined) clean.profileId = meta.profileId
    fs.writeFileSync(path.join(logDir, 'meta.json'), JSON.stringify(clean))
  } catch (err) {
    // Metadata is best-effort; report but never block logging.
    _errorReporter('[logs] Failed to write session meta', err)
  }
}

/** Read the `meta.json` sidecar for a session log dir; {} when absent/corrupt. */
export function readSessionMeta(logDir: string): SessionLogMeta {
  try {
    const raw = fs.readFileSync(path.join(logDir, 'meta.json'), 'utf-8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function getLogDir(configLabel: string, sessionId: string): string {
  const sanitized = configLabel.replace(/[^a-zA-Z0-9_-]/g, '_') || 'default'
  return path.join(getLogBase(), sanitized, sessionId)
}

function getLogPath(logDir: string): string {
  return path.join(logDir, 'session.jsonl')
}

function rotateIfNeeded(logDir: string): void {
  const logPath = getLogPath(logDir)
  try {
    if (!fs.existsSync(logPath)) return
    const stat = fs.statSync(logPath)
    if (stat.size < MAX_FILE_SIZE) return

    // Close existing stream
    const stream = activeStreams.get(logPath)
    if (stream) {
      stream.end()
      activeStreams.delete(logPath)
    }

    // Rotate files
    for (let i = MAX_ROTATED - 1; i >= 1; i--) {
      const from = `${logPath}.${i}`
      const to = `${logPath}.${i + 1}`
      if (fs.existsSync(from)) {
        if (i + 1 > MAX_ROTATED) {
          fs.unlinkSync(from)
        } else {
          fs.renameSync(from, to)
        }
      }
    }
    fs.renameSync(logPath, `${logPath}.1`)
  } catch (err) {
    // Rotation failure is non-fatal but must be visible, not swallowed silently.
    _errorReporter('[logs] Log rotation failed', err)
  }
}

/**
 * Get or create a write stream for the given log directory.
 * Throws on failure — callers must guard. Attaches an 'error' listener so an
 * async stream error is surfaced rather than crashing the process.
 */
function getOrCreateStream(logDir: string): fs.WriteStream {
  const logPath = getLogPath(logDir)
  const existing = activeStreams.get(logPath)
  if (existing && !existing.destroyed) return existing

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true }) // throws on failure — caller catches
  }

  rotateIfNeeded(logDir)

  const stream = fs.createWriteStream(logPath, { flags: 'a' })
  // An unhandled WriteStream 'error' event propagates as an uncaught exception.
  // Attach a listener here so any async I/O error is surfaced via the reporter.
  stream.on('error', (err) => {
    _errorReporter(`[logs] WriteStream error for ${logPath}`, err)
    // Remove the dead stream so the next write attempt can create a fresh one.
    if (activeStreams.get(logPath) === stream) {
      activeStreams.delete(logPath)
    }
  })
  activeStreams.set(logPath, stream)
  return stream
}

/**
 * Begin logging for a session. This function is BEST-EFFORT: it will never
 * throw, because it runs in pty-manager BEFORE the logging onData handler and
 * endSessionLog wiring are attached. A throw here would silently skip all
 * subsequent log wiring, leaving the terminal working but capture permanently
 * dead for that session.
 */
export function startSessionLog(
  sessionId: string,
  configLabel: string,
  accountEmail?: string,
  profileId?: string,
): void {
  const logDir = getLogDir(configLabel, sessionId)
  try {
    const stream = getOrCreateStream(logDir)
    // Only register session meta after the stream is successfully created so
    // logSessionData can guard cleanly on meta presence.
    sessionMeta.set(sessionId, { configLabel, logDir, accountEmail, profileId })
    const entry: LogEntry = { ts: Date.now(), type: 'start' }
    stream.write(JSON.stringify(entry) + '\n')
    // Persist account attribution so the log viewer can label/filter by account
    // even for sessions that ended before the app restarted.
    writeSessionMeta(logDir, { configLabel, accountEmail, profileId })
  } catch (err) {
    _errorReporter(
      `[logs] startSessionLog failed for session ${sessionId} (logDir: ${logDir}) — logging disabled for this session`,
      err,
    )
    // Intentionally do NOT re-throw: the caller (pty-manager) must continue so
    // that the xterm onData + endSessionLog wiring is never skipped.
  }
}

export function logSessionData(sessionId: string, data: string): void {
  const meta = sessionMeta.get(sessionId)
  if (!meta) {
    // Warn once per unknown session — logSessionData is called on every PTY
    // data chunk, so a per-chunk warning would flood the log.
    if (!warnedSessions.has(sessionId)) {
      warnedSessions.add(sessionId)
      _errorReporter(
        `[logs] logSessionData called for unknown session ${sessionId} — startSessionLog may have failed or session already ended`,
      )
    }
    return
  }

  try {
    const stream = getOrCreateStream(meta.logDir)
    const entry: LogEntry = { ts: Date.now(), type: 'data', data }
    stream.write(JSON.stringify(entry) + '\n')
  } catch (err) {
    _errorReporter(`[logs] logSessionData write failed for session ${sessionId}`, err)
  }
}

export function endSessionLog(sessionId: string): void {
  const meta = sessionMeta.get(sessionId)
  if (!meta) return

  const logPath = getLogPath(meta.logDir)
  const stream = activeStreams.get(logPath)
  if (stream) {
    try {
      const entry: LogEntry = { ts: Date.now(), type: 'end' }
      stream.write(JSON.stringify(entry) + '\n')
      stream.end()
    } catch (err) {
      _errorReporter(`[logs] endSessionLog write/close failed for session ${sessionId}`, err)
    }
    activeStreams.delete(logPath)
  }
  sessionMeta.delete(sessionId)
  // Clear warn dedup for this session so a future session with the same id
  // (unlikely but defensive) still gets its warning.
  warnedSessions.delete(sessionId)
}

export function closeAllLogs(): void {
  for (const [, stream] of activeStreams) {
    try { stream.end() } catch { /* ignore — shutting down */ }
  }
  activeStreams.clear()
  sessionMeta.clear()
  warnedSessions.clear()
}

// --- Query functions for log viewer (all async to avoid blocking UI) ---

export interface LogSessionInfo {
  configLabel: string
  sessionId: string
  logDir: string
  startTime?: number
  endTime?: number
  size: number
  accountEmail?: string
  profileId?: string
}

/** Read only the first and last lines of a file without loading it all into memory */
async function readFirstLastTimestamps(logPath: string): Promise<{ start?: number; end?: number }> {
  try {
    const fd = await fsp.open(logPath, 'r')
    try {
      // Read first line
      let start: number | undefined
      const rl = readline.createInterface({ input: fd.createReadStream({ encoding: 'utf-8' }), crlfDelay: Infinity })
      for await (const line of rl) {
        try { start = JSON.parse(line).ts } catch { /* skip */ }
        break
      }

      // Read last line — read from end of file in chunks
      const stat = await fd.stat()
      let end: number | undefined
      if (stat.size > 0) {
        const chunkSize = Math.min(4096, stat.size)
        const buf = Buffer.alloc(chunkSize)
        const { bytesRead } = await fd.read(buf, 0, chunkSize, Math.max(0, stat.size - chunkSize))
        const tail = buf.subarray(0, bytesRead).toString('utf-8')
        const lines = tail.trim().split('\n')
        if (lines.length > 0) {
          try { end = JSON.parse(lines[lines.length - 1]).ts } catch { /* skip */ }
        }
      }

      return { start, end }
    } finally {
      await fd.close()
    }
  } catch {
    return {}
  }
}

export async function listLogSessions(): Promise<LogSessionInfo[]> {
  const results: LogSessionInfo[] = []
  const logBase = getLogBase()
  if (!fs.existsSync(logBase)) return results

  try {
    const configDirs = await fsp.readdir(logBase)
    for (const configLabel of configDirs) {
      const configPath = path.join(logBase, configLabel)
      const configStat = await fsp.stat(configPath)
      if (!configStat.isDirectory()) continue

      const sessionDirs = await fsp.readdir(configPath)
      for (const sessionId of sessionDirs) {
        const sessionPath = path.join(configPath, sessionId)
        const sessionStat = await fsp.stat(sessionPath)
        if (!sessionStat.isDirectory()) continue

        const logPath = path.join(sessionPath, 'session.jsonl')
        try {
          const fileStat = await fsp.stat(logPath)
          const { start, end } = await readFirstLastTimestamps(logPath)
          const meta = readSessionMeta(sessionPath)

          results.push({
            configLabel,
            sessionId,
            logDir: sessionPath,
            startTime: start,
            endTime: end,
            size: fileStat.size,
            accountEmail: meta.accountEmail,
            profileId: meta.profileId,
          })
        } catch { /* file doesn't exist, skip */ }
      }
    }
  } catch { /* ignore */ }

  return results.sort((a, b) => (b.startTime || 0) - (a.startTime || 0))
}

export async function readLogEntries(
  logDir: string,
  offset = 0,
  limit = 500
): Promise<{ entries: LogEntry[]; total: number; hasMore: boolean }> {
  const logPath = path.join(logDir, 'session.jsonl')
  try {
    await fsp.access(logPath)
  } catch {
    return { entries: [], total: 0, hasMore: false }
  }

  try {
    const content = await fsp.readFile(logPath, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    const total = lines.length
    const entries = lines.slice(offset, offset + limit).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean) as LogEntry[]
    return { entries, total, hasMore: offset + entries.length < total }
  } catch {
    return { entries: [], total: 0, hasMore: false }
  }
}

export async function searchLogs(
  logDir: string,
  query: string
): Promise<LogEntry[]> {
  const logPath = path.join(logDir, 'session.jsonl')
  try {
    await fsp.access(logPath)
  } catch {
    return []
  }

  const lowerQuery = query.toLowerCase()
  const results: LogEntry[] = []

  try {
    const content = await fsp.readFile(logPath, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    for (const line of lines) {
      try {
        const entry = JSON.parse(line) as LogEntry
        if (entry.data) {
          // Strip ANSI for search
          const stripped = entry.data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
          if (stripped.toLowerCase().includes(lowerQuery)) {
            results.push(entry)
          }
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* ignore */ }

  return results
}

export function cleanupOldLogs(retentionDays = 30): number {
  let cleaned = 0
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000

  if (!fs.existsSync(getLogBase())) return 0

  try {
    const configDirs = fs.readdirSync(getLogBase())
    for (const configLabel of configDirs) {
      const configPath = path.join(getLogBase(), configLabel)
      if (!fs.statSync(configPath).isDirectory()) continue

      const sessionDirs = fs.readdirSync(configPath)
      for (const sessionId of sessionDirs) {
        const sessionPath = path.join(configPath, sessionId)
        if (!fs.statSync(sessionPath).isDirectory()) continue

        const logPath = path.join(sessionPath, 'session.jsonl')
        try {
          if (fs.existsSync(logPath)) {
            const stat = fs.statSync(logPath)
            if (stat.mtimeMs < cutoff) {
              fs.rmSync(sessionPath, { recursive: true, force: true })
              cleaned++
            }
          }
        } catch { /* ignore */ }
      }

      // Clean empty config dirs
      try {
        const remaining = fs.readdirSync(configPath)
        if (remaining.length === 0) fs.rmdirSync(configPath)
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  return cleaned
}
