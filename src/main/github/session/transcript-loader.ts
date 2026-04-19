import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { TranscriptToolCall } from './tool-call-inspector'
import type { TranscriptMessage } from './transcript-scanner'
import { pathToClaudeProjectFolder } from '../../utils/claude-project-path'

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

const MAX_LINES = 500
// Cap the bytes we read off disk so a long-lived transcript doesn't turn
// the Session Context poll into an O(N bytes) hit every 20s. ~1MB is
// plenty of tail for issue references + recent tool calls.
const MAX_BYTES = 1_000_000

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
    // Tail-read when the file is huge so we don't load tens of MB into
    // memory every poll. The first partial line (before the first \n) is
    // dropped when we slice — newline-delimited JSON tolerates it.
    const st = await fs.stat(newestFile)
    if (st.size > MAX_BYTES) {
      const fh = await fs.open(newestFile, 'r')
      try {
        const buf = Buffer.alloc(MAX_BYTES)
        const start = st.size - MAX_BYTES
        // Slice by bytesRead so a short read (file shrank, filesystem
        // quirk, etc.) doesn't leave trailing zero bytes in the decoded
        // string that would corrupt line splitting / JSON parsing.
        const { bytesRead } = await fh.read(buf, 0, MAX_BYTES, start)
        const tail = buf.subarray(0, bytesRead).toString('utf8')
        // Drop whatever precedes the first newline — it's almost certainly
        // a partial JSON line that can't parse.
        const nl = tail.indexOf('\n')
        raw = nl >= 0 ? tail.slice(nl + 1) : tail
      } finally {
        await fh.close()
      }
    } else {
      raw = await fs.readFile(newestFile, 'utf8')
    }
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
