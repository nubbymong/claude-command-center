import { BrowserWindow } from 'electron'
import * as os from 'os'
import * as path from 'path'
import * as fs from 'fs'
import { logInfo, logError } from './debug-logger'
import { spawnPty, killPty, getPtyOutputBuffer } from './pty-manager'

// Track active side chats: parentSessionId -> sideChatSessionId
const activeSideChats = new Map<string, string>()

/**
 * Generate a side chat session ID from the parent session ID.
 */
export function generateSideChatId(parentSessionId: string): string {
  return `${parentSessionId}-sidechat-${Date.now()}`
}

/**
 * Extract recent context from a parent session's terminal output.
 * Returns the last N lines of readable output (stripped of ANSI escape codes).
 */
export function extractParentContext(parentSessionId: string, maxLines = 100): string {
  const buffer = getPtyOutputBuffer(parentSessionId)
  if (!buffer) return ''

  // Strip ANSI escape codes for readability
  const stripped = buffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')  // OSC sequences
    .replace(/\r/g, '')

  const lines = stripped.split('\n')
  const recentLines = lines.slice(-maxLines).filter(line => line.trim().length > 0)
  return recentLines.join('\n')
}

/**
 * Build the context injection content for a side chat.
 */
export function buildContextInjection(
  parentSessionId: string,
  parentLabel: string,
  workingDirectory: string,
  model?: string,
  contextPercent?: number,
  maxLines = 100,
): string {
  const recentOutput = extractParentContext(parentSessionId, maxLines)

  return `# Side Chat Context

You are in a side chat branched from the main session "${parentLabel}". Your responses here
do not affect the main thread. The user wants to ask questions about the
current work without derailing the main session.

## Current State
- Working directory: ${workingDirectory}
${model ? `- Model: ${model}` : ''}
${contextPercent != null ? `- Context usage: ${Math.round(contextPercent)}%` : ''}

## Recent Activity (main session)
${recentOutput || '(No recent output captured)'}
`
}

/**
 * Spawn a side chat PTY session.
 * Returns the side chat session ID.
 */
export function spawnSideChat(
  win: BrowserWindow,
  parentSessionId: string,
  options: {
    workingDirectory: string
    parentLabel: string
    model?: string
    contextPercent?: number
    contextLines?: number
    ssh?: {
      host: string
      port: number
      username: string
      remotePath: string
      postCommand?: string
    }
    cols?: number
    rows?: number
  },
): string {
  // Kill existing side chat for this parent if any
  const existing = activeSideChats.get(parentSessionId)
  if (existing) {
    killSideChat(existing)
  }

  const sideChatId = generateSideChatId(parentSessionId)
  activeSideChats.set(parentSessionId, sideChatId)

  logInfo(`[side-chat] Spawning side chat ${sideChatId} for parent ${parentSessionId}`)

  // Build context injection
  const context = buildContextInjection(
    parentSessionId,
    options.parentLabel,
    options.workingDirectory,
    options.model,
    options.contextPercent,
    options.contextLines || 100,
  )

  // Write temporary context file
  const contextDir = path.join(options.workingDirectory, '.claude')
  const contextFile = path.join(contextDir, 'side-chat-context.md')
  try {
    if (!fs.existsSync(contextDir)) {
      fs.mkdirSync(contextDir, { recursive: true })
    }
    fs.writeFileSync(contextFile, context, 'utf-8')
    logInfo(`[side-chat] Context file written to ${contextFile}`)
  } catch (err) {
    logError(`[side-chat] Failed to write context file: ${err}`)
  }

  // Spawn the PTY session (reuses existing pty-manager infrastructure)
  spawnPty(win, sideChatId, {
    cwd: options.workingDirectory,
    cols: options.cols || 80,
    rows: options.rows || 24,
    ssh: options.ssh,
    shellOnly: false,
    configLabel: `Side Chat (${options.parentLabel})`,
  })

  return sideChatId
}

/**
 * Kill a side chat PTY and clean up.
 */
export function killSideChat(sideChatId: string): void {
  logInfo(`[side-chat] Killing side chat ${sideChatId}`)
  killPty(sideChatId)

  // Remove from tracking
  for (const [parentId, chatId] of activeSideChats) {
    if (chatId === sideChatId) {
      activeSideChats.delete(parentId)
      break
    }
  }
}

/**
 * Get the active side chat session ID for a parent session.
 */
export function getActiveSideChat(parentSessionId: string): string | undefined {
  return activeSideChats.get(parentSessionId)
}

/**
 * Kill all active side chats (called during app shutdown).
 */
export function killAllSideChats(): void {
  for (const sideChatId of activeSideChats.values()) {
    killPty(sideChatId)
  }
  activeSideChats.clear()
}
