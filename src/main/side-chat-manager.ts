import * as path from 'path'
import * as fs from 'fs'
import { logInfo, logError } from './debug-logger'
import { killPty, getPtyOutputBuffer } from './pty-manager'

// Track active side chats: parentSessionId -> { sideChatSessionId, contextFilePath }
const activeSideChats = new Map<string, { sideChatId: string; contextFile?: string }>()

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

  // Strip ANSI escape codes and OSC sequences for readability
  const stripped = buffer
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')       // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')  // OSC sequences (BEL or ST terminated)
    .replace(/\x1b[78DME]/g, '')                   // Single-char escape sequences
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

  const lines = [
    '# Side Chat Context',
    '',
    `You are in a side chat branched from the main session "${parentLabel}". Your responses here`,
    'do not affect the main thread. The user wants to ask questions about the',
    'current work without derailing the main session.',
    '',
    '## Current State',
    `- Working directory: ${workingDirectory}`,
  ]
  if (model) lines.push(`- Model: ${model}`)
  if (contextPercent != null) lines.push(`- Context usage: ${Math.round(contextPercent)}%`)
  lines.push('')
  lines.push('## Recent Activity (main session)')
  lines.push(recentOutput || '(No recent output captured)')
  lines.push('')

  return lines.join('\n')
}

/**
 * Prepare a side chat session: generate ID, write context file, track state.
 * The actual PTY spawn is handled by TerminalView in the renderer (via pty:spawn IPC).
 * Returns the side chat session ID.
 */
export function spawnSideChat(
  _win: unknown,
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
    killSideChat(existing.sideChatId)
  }

  const sideChatId = generateSideChatId(parentSessionId)

  logInfo(`[side-chat] Preparing side chat ${sideChatId} for parent ${parentSessionId}`)

  // Build and write context injection file
  const context = buildContextInjection(
    parentSessionId,
    options.parentLabel,
    options.workingDirectory,
    options.model,
    options.contextPercent,
    options.contextLines || 100,
  )

  let contextFile: string | undefined
  const contextDir = path.join(options.workingDirectory, '.claude')
  const contextPath = path.join(contextDir, 'side-chat-context.md')
  try {
    if (!fs.existsSync(contextDir)) {
      fs.mkdirSync(contextDir, { recursive: true })
    }
    fs.writeFileSync(contextPath, context, 'utf-8')
    contextFile = contextPath
    logInfo(`[side-chat] Context file written to ${contextPath}`)
  } catch (err) {
    logError(`[side-chat] Failed to write context file: ${err}`)
  }

  activeSideChats.set(parentSessionId, { sideChatId, contextFile })
  return sideChatId
}

/**
 * Kill a side chat PTY and clean up context file.
 */
export function killSideChat(sideChatId: string): void {
  logInfo(`[side-chat] Killing side chat ${sideChatId}`)
  killPty(sideChatId)

  // Find and clean up
  for (const [parentId, entry] of activeSideChats) {
    if (entry.sideChatId === sideChatId) {
      // Clean up context file
      if (entry.contextFile) {
        try {
          if (fs.existsSync(entry.contextFile)) {
            fs.unlinkSync(entry.contextFile)
            logInfo(`[side-chat] Context file cleaned up: ${entry.contextFile}`)
          }
        } catch (err) {
          logError(`[side-chat] Failed to clean up context file: ${err}`)
        }
      }
      activeSideChats.delete(parentId)
      break
    }
  }
}

/**
 * Get the active side chat session ID for a parent session.
 */
export function getActiveSideChat(parentSessionId: string): string | undefined {
  return activeSideChats.get(parentSessionId)?.sideChatId
}

/**
 * Kill all active side chats (called during app shutdown).
 */
export function killAllSideChats(): void {
  for (const entry of activeSideChats.values()) {
    killPty(entry.sideChatId)
    // Clean up context files
    if (entry.contextFile) {
      try { fs.unlinkSync(entry.contextFile) } catch { /* ignore */ }
    }
  }
  activeSideChats.clear()
}
