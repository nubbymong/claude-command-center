import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc-channels'
import { logInfo, logError } from './debug-logger'

interface WatcherState {
  watcher: fs.FSWatcher
  filePath: string
  offset: number
  sessionId: string
  win: BrowserWindow
}

const watchers = new Map<string, WatcherState>()

/**
 * Derive the Claude projects directory hash from a working directory path.
 * On Windows: `C:\Users\nicho` becomes `C--Users-nicho`
 * On Unix: `/home/user/project` becomes `-home-user-project`
 */
function projectHash(workingDirectory: string): string {
  // Normalize to forward slashes
  let normalized = workingDirectory.replace(/\\/g, '/')

  // Remove trailing slash
  normalized = normalized.replace(/\/$/, '')

  // Replace colon with dash (C: -> C-)
  normalized = normalized.replace(':', '-')

  // Replace slashes and underscores with dashes
  normalized = normalized.replace(/[/_]/g, '-')

  return normalized
}

/**
 * Find the project transcript directory, trying exact hash first then falling back to scan.
 */
function findProjectDir(workingDirectory: string): string | null {
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects')
  const hash = projectHash(workingDirectory)
  const exactPath = path.join(claudeProjectsDir, hash)

  if (fs.existsSync(exactPath)) return exactPath

  // Fallback: case-insensitive scan
  try {
    const dirs = fs.readdirSync(claudeProjectsDir)
    const hashLower = hash.toLowerCase()
    const match = dirs.find(d => d.toLowerCase() === hashLower)
    if (match) return path.join(claudeProjectsDir, match)
  } catch { /* ignore */ }

  logInfo(`[transcript-watcher] No project dir found for hash: ${hash}`)
  return null
}

/**
 * Get the full path to the Claude projects transcript directory for a given working directory.
 */
export function getProjectTranscriptDir(workingDirectory: string): string | null {
  return findProjectDir(workingDirectory)
}

/**
 * Find the most recently modified .jsonl transcript file in a project directory.
 * Skips files in subdirectories (e.g. subagents/).
 */
export function findLatestTranscript(projectDir: string): string | null {
  try {
    if (!fs.existsSync(projectDir)) {
      return null
    }

    const entries = fs.readdirSync(projectDir, { withFileTypes: true })
    let latestFile: string | null = null
    let latestMtime = 0

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue

      const filePath = path.join(projectDir, entry.name)
      try {
        const stat = fs.statSync(filePath)
        if (stat.mtimeMs > latestMtime) {
          latestMtime = stat.mtimeMs
          latestFile = filePath
        }
      } catch {
        // Skip files we can't stat
      }
    }

    return latestFile
  } catch (err) {
    logError(`[transcript-watcher] Error scanning project dir: ${err}`)
    return null
  }
}

/**
 * Read the last N lines from a file efficiently by reading from the end.
 */
function readLastLines(filePath: string, maxLines: number): { lines: string[]; offset: number } {
  const stat = fs.statSync(filePath)
  const fileSize = stat.size

  if (fileSize === 0) {
    return { lines: [], offset: 0 }
  }

  // Read in chunks from the end to find the last N lines
  const chunkSize = 64 * 1024 // 64KB chunks
  let buffer = ''
  let position = fileSize
  const fd = fs.openSync(filePath, 'r')

  try {
    while (position > 0) {
      const readSize = Math.min(chunkSize, position)
      position -= readSize
      const chunk = Buffer.alloc(readSize)
      fs.readSync(fd, chunk, 0, readSize, position)
      buffer = chunk.toString('utf-8') + buffer

      // Count newlines - if we have enough, stop reading
      const lineCount = buffer.split('\n').length - 1
      if (lineCount > maxLines + 10) break // Read a few extra for safety
    }
  } finally {
    fs.closeSync(fd)
  }

  // Split into lines and take the last maxLines
  const allLines = buffer.split('\n').filter((line) => line.trim().length > 0)
  const lastLines = allLines.slice(-maxLines)

  return { lines: lastLines, offset: fileSize }
}

/**
 * Parse JSONL lines, filtering to only assistant and user type entries.
 */
function parseAndFilterEntries(lines: string[]): unknown[] {
  const entries: unknown[] = []

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line)
      if (parsed && (parsed.type === 'assistant' || parsed.type === 'user')) {
        entries.push(parsed)
      }
    } catch {
      // Skip malformed lines
    }
  }

  return entries
}

/**
 * Start watching a transcript file for a given session.
 * Reads the last 200 lines initially, then streams new entries.
 */
export function startTranscriptWatcher(
  win: BrowserWindow,
  sessionId: string,
  workingDirectory: string
): void {
  // Stop any existing watcher for this session
  stopTranscriptWatcher(sessionId)

  const projectDir = getProjectTranscriptDir(workingDirectory)
  if (!projectDir) {
    logInfo(`[transcript-watcher] No project dir found for session ${sessionId} (${workingDirectory})`)
    return
  }
  logInfo(`[transcript-watcher] Project dir for session ${sessionId}: ${projectDir}`)

  const transcriptFile = findLatestTranscript(projectDir)
  if (!transcriptFile) {
    logInfo(`[transcript-watcher] No transcript file found for session ${sessionId}`)
    return
  }

  logInfo(`[transcript-watcher] Watching ${transcriptFile} for session ${sessionId}`)

  // Read last 200 lines for initial load
  const { lines, offset } = readLastLines(transcriptFile, 200)
  const initialEntries = parseAndFilterEntries(lines)

  if (initialEntries.length > 0 && !win.isDestroyed()) {
    win.webContents.send(IPC.TRANSCRIPT_ENTRIES, sessionId, initialEntries)
  }

  // Start watching for changes
  let currentOffset = offset
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  try {
    const watcher = fs.watch(transcriptFile, (eventType) => {
      if (eventType !== 'change') return

      // Debounce rapid changes
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        readNewContent(transcriptFile, currentOffset, sessionId, win, (newOffset) => {
          currentOffset = newOffset
        })
      }, 100)
    })

    watcher.on('error', (err) => {
      logError(`[transcript-watcher] Watcher error for session ${sessionId}: ${err}`)
      stopTranscriptWatcher(sessionId)
    })

    watchers.set(sessionId, {
      watcher,
      filePath: transcriptFile,
      offset: currentOffset,
      sessionId,
      win,
    })
  } catch (err) {
    logError(`[transcript-watcher] Failed to start watcher for session ${sessionId}: ${err}`)
  }
}

/**
 * Read new content from a transcript file starting at the given offset.
 */
function readNewContent(
  filePath: string,
  fromOffset: number,
  sessionId: string,
  win: BrowserWindow,
  updateOffset: (offset: number) => void
): void {
  try {
    const stat = fs.statSync(filePath)
    if (stat.size <= fromOffset) return

    const bytesToRead = stat.size - fromOffset
    const buffer = Buffer.alloc(bytesToRead)
    const fd = fs.openSync(filePath, 'r')

    try {
      fs.readSync(fd, buffer, 0, bytesToRead, fromOffset)
    } finally {
      fs.closeSync(fd)
    }

    updateOffset(stat.size)

    const text = buffer.toString('utf-8')
    const lines = text.split('\n').filter((line) => line.trim().length > 0)
    const entries = parseAndFilterEntries(lines)

    if (entries.length > 0 && !win.isDestroyed()) {
      win.webContents.send(IPC.TRANSCRIPT_ENTRIES, sessionId, entries)
    }
  } catch (err) {
    logError(`[transcript-watcher] Error reading new content for session ${sessionId}: ${err}`)
  }
}

/**
 * Stop watching transcripts for a specific session.
 */
export function stopTranscriptWatcher(sessionId: string): void {
  const state = watchers.get(sessionId)
  if (state) {
    logInfo(`[transcript-watcher] Stopping watcher for session ${sessionId}`)
    try {
      state.watcher.close()
    } catch {
      // Ignore close errors
    }
    watchers.delete(sessionId)
  }
}

/**
 * Stop all transcript watchers. Call on app shutdown.
 */
export function stopAllTranscriptWatchers(): void {
  for (const [sessionId] of watchers) {
    stopTranscriptWatcher(sessionId)
  }
}
