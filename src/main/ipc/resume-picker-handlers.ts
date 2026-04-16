import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { IPC } from '../../shared/ipc-channels'
import { getProjectTranscriptDir } from '../transcript-watcher'
import { logInfo, logError } from '../debug-logger'
import type { ConversationSummary } from '../../shared/types'

/**
 * Extract user-visible text from a JSONL message object.
 * Mirrors the logic in resume-picker.js exactly.
 */
function extractUserText(obj: Record<string, unknown>): string | null {
  if (obj.isMeta) return null

  let text: string | null = null

  if (typeof obj.message === 'string') {
    text = obj.message
  } else if (obj.message && typeof obj.message === 'object') {
    const msg = obj.message as Record<string, unknown>
    if (msg.content) {
      if (typeof msg.content === 'string') {
        text = msg.content
      } else if (Array.isArray(msg.content)) {
        const textBlock = msg.content.find(
          (b: Record<string, unknown>) => b.type === 'text'
        ) as Record<string, unknown> | undefined
        if (textBlock) text = textBlock.text as string
      }
    }
  }

  if (!text) return null

  // Skip commands, caveats, and tool interrupts
  if (
    text.startsWith('<command-name>') ||
    text.startsWith('<local-command') ||
    text.startsWith('[Request interrupted')
  ) {
    return null
  }

  return text.replace(/[\r\n]+/g, ' ').trim()
}

/**
 * Format a timestamp as a human-readable "time ago" string.
 */
function timeAgo(ms: number): string {
  const sec = Math.floor((Date.now() - ms) / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hrs = Math.floor(min / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  return `${Math.floor(days / 7)}w ago`
}

/**
 * Format bytes as a human-readable size string.
 */
function formatSize(bytes: number): string {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB'
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return bytes + ' B'
}

/**
 * Parse a single .jsonl transcript file to extract conversation summary.
 * Reads head (first 32KB) for first user message + model, and
 * tail (last 128KB) for the last 5 user messages.
 */
function parseConversation(filePath: string): ConversationSummary | null {
  try {
    const stat = fs.statSync(filePath)
    if (stat.size < 20480) return null // Skip ghost sessions (<20KB)

    const fd = fs.openSync(filePath, 'r')
    const sessionId = path.basename(filePath, '.jsonl')

    // ── Read HEAD (first 32KB) for first message + model ──
    const headSize = Math.min(32768, stat.size)
    const headBuf = Buffer.alloc(headSize)
    fs.readSync(fd, headBuf, 0, headSize, 0)
    const headText = headBuf.toString('utf-8')
    const headLines = headText.split('\n').filter(Boolean)

    let firstMessage: string | null = null
    let model: string | null = null

    for (const line of headLines) {
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'user' && !firstMessage) {
          firstMessage = extractUserText(obj)
        }
        if (obj.type === 'assistant' && obj.message?.model && !model) {
          model = obj.message.model
        }
        if (firstMessage && model) break
      } catch {
        /* skip malformed lines */
      }
    }

    // ── Read TAIL (last 128KB) for recent user messages ──
    const tailSize = Math.min(131072, stat.size)
    const tailOffset = Math.max(0, stat.size - tailSize)
    const tailBuf = Buffer.alloc(tailSize)
    fs.readSync(fd, tailBuf, 0, tailSize, tailOffset)
    fs.closeSync(fd)

    const tailText = tailBuf.toString('utf-8')
    // If we started mid-line, skip the first partial line
    const tailStart = tailOffset > 0 ? tailText.indexOf('\n') + 1 : 0
    const tailLines = tailText.slice(tailStart).split('\n').filter(Boolean)

    const recentMessages: string[] = []
    for (const line of tailLines) {
      try {
        const obj = JSON.parse(line)
        if (obj.type === 'user') {
          const text = extractUserText(obj)
          if (text) recentMessages.push(text)
        }
      } catch {
        /* skip */
      }
    }

    // Last 5 user messages
    const lastMessages = recentMessages.slice(-5)

    return {
      sessionId,
      firstMessage: (firstMessage || '(continued session)').trim(),
      lastMessages,
      model,
      timeAgo: timeAgo(stat.mtimeMs),
      size: formatSize(stat.size),
      mtimeMs: stat.mtimeMs,
    }
  } catch {
    return null
  }
}

export function registerResumePickerHandlers(): void {
  ipcMain.handle(
    IPC.RESUME_PICKER_LIST,
    async (_event, workingDirectory: string): Promise<ConversationSummary[]> => {
      logInfo(`[resume-picker] Listing conversations for: ${workingDirectory}`)

      const projectDir = getProjectTranscriptDir(workingDirectory)
      if (!projectDir) {
        logInfo('[resume-picker] No project dir found')
        return []
      }

      // Scan for .jsonl files that have a companion directory
      // (current Claude CLI format -- older conversations without a dir can't be resumed)
      let files: string[]
      try {
        const entries = fs.readdirSync(projectDir)
        const dirSet = new Set(
          entries.filter((e) => {
            try {
              return fs.statSync(path.join(projectDir, e)).isDirectory()
            } catch {
              return false
            }
          })
        )
        files = entries
          .filter(
            (f) =>
              f.endsWith('.jsonl') && dirSet.has(f.replace('.jsonl', ''))
          )
          .map((f) => path.join(projectDir, f))
      } catch {
        logInfo('[resume-picker] Could not read project dir')
        return []
      }

      if (files.length === 0) {
        logInfo('[resume-picker] No .jsonl files with companion dirs found')
        return []
      }

      // Parse conversations, filter nulls, sort by mtime desc, limit to 15
      const conversations = files
        .map(parseConversation)
        .filter((c): c is ConversationSummary => c !== null)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)
        .slice(0, 15)

      logInfo(
        `[resume-picker] Found ${conversations.length} conversations in ${projectDir}`
      )
      return conversations
    }
  )
}
