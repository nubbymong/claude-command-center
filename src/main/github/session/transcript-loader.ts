import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { TranscriptToolCall } from './tool-call-inspector'
import type { TranscriptMessage } from './transcript-scanner'

/**
 * Loads the most-recently-touched JSONL transcript under
 * ~/.claude/projects/<cwd-mangled>/ and returns a small, typed view of
 * its contents.
 *
 * Conductor's internal session id is NOT the same as Claude CLI's
 * sessionId (the CLI picks its own UUID). We therefore locate the right
 * transcript by:
 *   1. Mapping the session's cwd to Claude's project-folder naming
 *      convention (same mapping as src/main/ipc/setup-handlers.ts).
 *   2. Picking the JSONL with the most recent mtime — for an active
 *      session that's overwhelmingly the running conversation.
 *
 * Returns an empty result (rather than throwing) if anything fails:
 *   - cwd has no Claude project folder yet
 *   - folder has no JSONL files
 *   - JSONL parse errors (best-effort line-by-line)
 */

function pathToClaudeProjectFolder(fsPath: string): string {
  return fsPath.replace(/:/g, '-').replace(/[\\/]+/g, '-')
}

const MAX_LINES = 500

export interface TranscriptEvents {
  messages: TranscriptMessage[]
  toolCalls: TranscriptToolCall[]
}

interface ContentPart {
  type?: string
  text?: string
  name?: string
  input?: Record<string, unknown>
}

interface JsonlEntry {
  type?: string
  timestamp?: string
  message?:
    | string
    | {
        role?: string
        content?: string | ContentPart[]
      }
}

export async function loadTranscriptEvents(cwd: string | undefined): Promise<TranscriptEvents> {
  const empty: TranscriptEvents = { messages: [], toolCalls: [] }
  if (!cwd) return empty

  const projectsDir = path.join(homedir(), '.claude', 'projects')
  const folder = path.join(projectsDir, pathToClaudeProjectFolder(cwd))

  let entries: string[]
  try {
    entries = await fs.readdir(folder)
  } catch {
    return empty
  }
  const jsonl = entries.filter((e) => e.endsWith('.jsonl'))
  if (jsonl.length === 0) return empty

  let newestFile: string | null = null
  let newestMtime = 0
  for (const name of jsonl) {
    const full = path.join(folder, name)
    try {
      const st = await fs.stat(full)
      if (st.mtimeMs > newestMtime) {
        newestMtime = st.mtimeMs
        newestFile = full
      }
    } catch {
      /* skip */
    }
  }
  if (!newestFile) return empty

  let raw: string
  try {
    raw = await fs.readFile(newestFile, 'utf8')
  } catch {
    return empty
  }

  const lines = raw.split('\n').filter((l) => l.trim())
  // Cap at the last MAX_LINES — older history is unlikely to influence the
  // current session's GitHub context and parsing is O(n) in both bytes
  // read + JSON.parse calls.
  const tail = lines.slice(-MAX_LINES)

  const messages: TranscriptMessage[] = []
  const toolCalls: TranscriptToolCall[] = []

  for (const line of tail) {
    let obj: JsonlEntry
    try {
      obj = JSON.parse(line) as JsonlEntry
    } catch {
      continue
    }
    const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0
    if (!obj.message || typeof obj.message === 'string') continue

    const content = obj.message.content
    const role = obj.message.role ?? (obj.type === 'human' ? 'user' : obj.type)

    if (typeof content === 'string') {
      if (role === 'user' || role === 'assistant') {
        messages.push({ role, text: content, ts })
      }
      continue
    }
    if (!Array.isArray(content)) continue

    for (const part of content) {
      if (part.type === 'text' && typeof part.text === 'string') {
        if (role === 'user' || role === 'assistant') {
          messages.push({ role, text: part.text, ts })
        }
      } else if (part.type === 'tool_use' && typeof part.name === 'string') {
        toolCalls.push({
          type: 'tool_call',
          tool: part.name,
          args: (part.input ?? {}) as Record<string, unknown>,
          timestamp: ts,
        })
      }
    }
  }

  return { messages, toolCalls }
}
