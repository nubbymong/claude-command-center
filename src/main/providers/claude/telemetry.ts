/**
 * Per-session Claude telemetry subscription (lifted from statusline-watcher.ts in P0.7).
 *
 * The actual filesystem watcher is a single global watcher in statusline-watcher.ts
 * (one fs.watch + poll covers all <resourcesDir>/status/*.json files). This module
 * exposes a per-session subscription API: a caller registers a callback for a given
 * session ID, and the global dispatcher routes matching updates here.
 *
 * The global dispatcher always sends every update to the renderer + tokenomics
 * (unchanged behaviour). Per-session subscribers are an additional fan-out for
 * provider-aware consumers that want a typed StatuslineData stream scoped to one session.
 *
 * P0.8 additionally lifts Claude history-file walking and per-file transcript parsing
 * out of tokenomics-manager.ts so they live with the provider. tokenomics-manager
 * imports these and continues to drive ingestion + aggregation; the helpers themselves
 * are pure provider-shaped utilities (filesystem walk + JSONL line parse).
 */
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as readline from 'readline'
import type { StatuslineData } from '../../../shared/types'
import type { TelemetrySource, HistorySession } from '../types'
import { logError } from '../../debug-logger'

type Listener = (data: StatuslineData) => void

const listeners = new Map<string, Set<Listener>>()

/**
 * Internal: called by the global statusline dispatcher (statusline-watcher.ts and
 * pty-manager's SSH OSC sentinel parser) for every parsed StatuslineData payload.
 * Routes to per-session subscribers registered via watchClaudeStatuslineFile().
 */
export function notifyClaudeTelemetry(data: StatuslineData): void {
  if (!data || !data.sessionId) return
  const set = listeners.get(data.sessionId)
  if (!set || set.size === 0) return
  for (const cb of set) {
    try { cb(data) } catch { /* ignore subscriber errors */ }
  }
}

/**
 * Subscribe to statusline updates for a specific session. The returned
 * TelemetrySource's stop() unregisters the callback.
 *
 * The underlying watcher is a single global fs.watch+poll started by
 * startStatuslineWatcher() at app boot — this function does NOT start a new
 * filesystem watcher per session.
 */
export function watchClaudeStatuslineFile(
  sessionId: string,
  onUpdate: (data: StatuslineData) => void
): TelemetrySource {
  let set = listeners.get(sessionId)
  if (!set) {
    set = new Set()
    listeners.set(sessionId, set)
  }
  set.add(onUpdate)

  return {
    stop(): void {
      const s = listeners.get(sessionId)
      if (!s) return
      s.delete(onUpdate)
      if (s.size === 0) listeners.delete(sessionId)
    },
  }
}

// ── Claude history-file walking (lifted from tokenomics-manager.ts P0.8) ──

/**
 * Per-message tokens parsed out of a Claude transcript JSONL file.
 * Shape preserved verbatim from tokenomics-manager.ts so ingestion stays identical.
 */
export interface ClaudeParsedMessage {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  timestamp: string
  sessionId: string
}

/**
 * Walk ~/.claude/projects/<encoded>/*.jsonl and return file metadata.
 * Lifted verbatim from tokenomics-manager.ts (formerly findJsonlFiles).
 */
export function findClaudeHistoryFiles(): Array<{ path: string; mtime: number; projectDir: string }> {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects')
  const files: Array<{ path: string; mtime: number; projectDir: string }> = []

  try {
    if (!fs.existsSync(claudeDir)) return files

    const projects = fs.readdirSync(claudeDir)
    for (const project of projects) {
      const projectPath = path.join(claudeDir, project)
      try {
        const stat = fs.statSync(projectPath)
        if (!stat.isDirectory()) continue

        const entries = fs.readdirSync(projectPath)
        for (const entry of entries) {
          if (!entry.endsWith('.jsonl')) continue
          const filePath = path.join(projectPath, entry)
          try {
            const fstat = fs.statSync(filePath)
            files.push({
              path: filePath,
              mtime: fstat.mtimeMs,
              projectDir: project,
            })
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
    }
  } catch (err) {
    logError(`[claude-telemetry] Failed to enumerate JSONL files: ${err}`)
  }

  return files
}

/**
 * Parse a single Claude transcript JSONL file.
 * Lifted verbatim from tokenomics-manager.ts (formerly parseTranscriptFile).
 *
 * Streams the file line-by-line, fast-paths past non-assistant lines via a
 * substring check, and aggregates per-message token usage. Malformed lines are
 * skipped silently; a file that fails to open returns an empty array.
 */
export async function parseClaudeTranscriptFile(filePath: string): Promise<ClaudeParsedMessage[]> {
  const messages: ClaudeParsedMessage[] = []
  try {
    const stream = fs.createReadStream(filePath, { encoding: 'utf-8' })
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })

    for await (const line of rl) {
      // Quick string check before JSON.parse
      if (!line.includes('"type":"assistant"') && !line.includes('"type": "assistant"')) continue

      try {
        const entry = JSON.parse(line)
        if (entry.type !== 'assistant') continue

        const usage = entry.message?.usage
        if (!usage) continue

        const model = entry.message?.model || 'unknown'
        messages.push({
          model,
          inputTokens: usage.input_tokens || 0,
          outputTokens: usage.output_tokens || 0,
          cacheReadTokens: usage.cache_read_input_tokens || 0,
          cacheWriteTokens: usage.cache_creation_input_tokens || 0,
          timestamp: entry.timestamp || '',
          sessionId: entry.sessionId || '',
        })
      } catch { /* skip malformed lines */ }
    }
  } catch {
    // File read error — skip silently (matches prior behavior)
  }
  return messages
}

/**
 * Decode a Claude project folder name (encoded path) back to a real filesystem path.
 * e.g. F--CLAUDE-MULTI-APP -> F:/CLAUDE_MULTI_APP
 *
 * Mirrors the inverse of pathToClaudeProjectFolder (claude-project-path.ts) and
 * the sanitizeProjectPath helper in session-discovery.ts.
 */
function decodeClaudeProjectDir(encoded: string): string {
  // Replace leading drive-letter pattern: "X--" -> "X:/"
  return encoded.replace(/-/g, '/').replace(/^([A-Za-z])\/\//, '$1:/')
}

/**
 * List Claude resumable sessions for the resume picker.
 * Returns HistorySession[] sorted by lastModified desc.
 *
 * cwd: read from the first JSONL line that carries a `cwd` field (type=attachment
 * or type=user lines in real Claude transcripts). Falls back to decoding the
 * encoded projectDir name so the renderer always receives a real path string.
 *
 * Label: derived from the first user/human message in the JSONL (gates on
 * obj.type === 'user' || obj.type === 'human' before reading content, matching
 * session-discovery.ts line 119). Falls back to sessionId on any failure.
 */
export async function listClaudeResumableSessions(): Promise<HistorySession[]> {
  const files = findClaudeHistoryFiles()
  const result: HistorySession[] = []

  for (const f of files) {
    const sessionId = path.basename(f.path, '.jsonl')
    let label = sessionId
    let cwd = decodeClaudeProjectDir(f.projectDir)

    try {
      const text = fs.readFileSync(f.path, 'utf-8')
      for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        try {
          const obj = JSON.parse(line)

          // Extract real cwd from the first line that carries it
          if (!cwd || cwd === decodeClaudeProjectDir(f.projectDir)) {
            if (typeof obj.cwd === 'string' && obj.cwd.trim()) {
              cwd = obj.cwd.trim()
            }
          }

          // Gate on user/human type before treating content as the session label
          if (obj.type !== 'user' && obj.type !== 'human') continue

          const content = obj?.message?.content
          if (typeof content === 'string' && content.trim()) {
            label = content.slice(0, 120)
            break
          }
          if (Array.isArray(content)) {
            const firstText = content.find((b: any) => b && b.type === 'text' && typeof b.text === 'string')
            if (firstText && firstText.text.trim()) {
              label = firstText.text.slice(0, 120)
              break
            }
          }
        } catch { /* keep scanning lines */ }
      }
    } catch { /* keep sessionId as label, decoded projectDir as cwd */ }

    result.push({
      provider: 'claude',
      sessionId,
      cwd,
      label,
      lastModified: f.mtime,
    })
  }

  result.sort((a, b) => b.lastModified - a.lastModified)
  return result
}
