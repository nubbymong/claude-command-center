import * as fs from 'fs'
import * as path from 'path'
import { getDataDirectory } from './ipc/setup-handlers'

// Get log base from custom data directory
function getLogBase(): string {
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
const sessionMeta = new Map<string, { configLabel: string; logDir: string }>()

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
  } catch { /* ignore rotation errors */ }
}

function getOrCreateStream(logDir: string): fs.WriteStream {
  const logPath = getLogPath(logDir)
  let stream = activeStreams.get(logPath)
  if (stream && !stream.destroyed) return stream

  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }

  rotateIfNeeded(logDir)

  stream = fs.createWriteStream(logPath, { flags: 'a' })
  activeStreams.set(logPath, stream)
  return stream
}

export function startSessionLog(sessionId: string, configLabel: string): void {
  const logDir = getLogDir(configLabel, sessionId)
  sessionMeta.set(sessionId, { configLabel, logDir })

  const stream = getOrCreateStream(logDir)
  const entry: LogEntry = { ts: Date.now(), type: 'start' }
  stream.write(JSON.stringify(entry) + '\n')
}

export function logSessionData(sessionId: string, data: string): void {
  const meta = sessionMeta.get(sessionId)
  if (!meta) return

  const stream = getOrCreateStream(meta.logDir)
  const entry: LogEntry = { ts: Date.now(), type: 'data', data }
  stream.write(JSON.stringify(entry) + '\n')
}

export function endSessionLog(sessionId: string): void {
  const meta = sessionMeta.get(sessionId)
  if (!meta) return

  const logPath = getLogPath(meta.logDir)
  const stream = activeStreams.get(logPath)
  if (stream) {
    const entry: LogEntry = { ts: Date.now(), type: 'end' }
    stream.write(JSON.stringify(entry) + '\n')
    stream.end()
    activeStreams.delete(logPath)
  }
  sessionMeta.delete(sessionId)
}

export function closeAllLogs(): void {
  for (const [, stream] of activeStreams) {
    try { stream.end() } catch { /* ignore */ }
  }
  activeStreams.clear()
  sessionMeta.clear()
}

// --- Query functions for log viewer ---

export interface LogSessionInfo {
  configLabel: string
  sessionId: string
  logDir: string
  startTime?: number
  endTime?: number
  size: number
}

export function listLogSessions(): LogSessionInfo[] {
  const results: LogSessionInfo[] = []
  if (!fs.existsSync(getLogBase())) return results

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
        if (!fs.existsSync(logPath)) continue

        const stat = fs.statSync(logPath)
        let startTime: number | undefined
        let endTime: number | undefined

        // Read first and last lines for timestamps
        try {
          const content = fs.readFileSync(logPath, 'utf-8')
          const lines = content.trim().split('\n')
          if (lines.length > 0) {
            const first = JSON.parse(lines[0])
            startTime = first.ts
            const last = JSON.parse(lines[lines.length - 1])
            endTime = last.ts
          }
        } catch { /* ignore */ }

        results.push({
          configLabel,
          sessionId,
          logDir: sessionPath,
          startTime,
          endTime,
          size: stat.size
        })
      }
    }
  } catch { /* ignore */ }

  return results.sort((a, b) => (b.startTime || 0) - (a.startTime || 0))
}

export function readLogEntries(
  logDir: string,
  offset = 0,
  limit = 500
): { entries: LogEntry[]; total: number } {
  const logPath = path.join(logDir, 'session.jsonl')
  if (!fs.existsSync(logPath)) return { entries: [], total: 0 }

  try {
    const content = fs.readFileSync(logPath, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    const total = lines.length
    const entries = lines.slice(offset, offset + limit).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean) as LogEntry[]
    return { entries, total }
  } catch {
    return { entries: [], total: 0 }
  }
}

export function searchLogs(
  logDir: string,
  query: string
): LogEntry[] {
  const logPath = path.join(logDir, 'session.jsonl')
  if (!fs.existsSync(logPath)) return []

  const lowerQuery = query.toLowerCase()
  const results: LogEntry[] = []

  try {
    const content = fs.readFileSync(logPath, 'utf-8')
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
