/**
 * transcript-normalizer.ts — Versioned, defensive JSONL-to-NewMessage normalizer.
 *
 * This is ONE of exactly TWO modules allowed to know Claude Code's transcript
 * JSONL format (the other being discovery). Everything else consumes its output.
 *
 * Design contract:
 *  - NEVER throws on any input, including shape drift, unknown types, or
 *    malformed JSON.
 *  - Maps the real 605k-line histogram (2026-06-06) faithfully.
 *  - PARSER_VERSION is bumped whenever the output shape or mapping rules change,
 *    allowing the worker to re-ingest stale transcripts.
 */

import type { NewMessage } from './transcripts-db'

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const PARSER_VERSION = 1

export interface NormalizerStats {
  malformed: number
  skippedMeta: number
  unknown: number
}

export interface Normalizer {
  push(line: string): NewMessage[]
  stats: NormalizerStats
}

export function makeNormalizer(opts?: { startIdx?: number }): Normalizer {
  let nextIdx = opts?.startIdx ?? 0
  let lastTs = 0

  const stats: NormalizerStats = { malformed: 0, skippedMeta: 0, unknown: 0 }

  function push(line: string): NewMessage[] {
    // 1. Parse JSON — malformed → silent empty
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      stats.malformed++
      return []
    }

    // Reject non-object values (null, number, string, array, boolean)
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      stats.malformed++
      return []
    }

    const obj = entry as Record<string, unknown>

    // 2. isMeta shortcut — any entry flagged isMeta:true is always metadata
    if (obj['isMeta'] === true) {
      stats.skippedMeta++
      return []
    }

    const entryType = typeof obj['type'] === 'string' ? obj['type'] : undefined

    // 3. Known metadata/skip types
    if (entryType !== undefined && SKIP_TYPES.has(entryType)) {
      stats.skippedMeta++
      return []
    }

    // 4. Conversation entries: user / assistant
    if (entryType === 'user' || entryType === 'assistant') {
      return processConversationEntry(obj, entryType)
    }

    // 5. Unknown / novel type
    stats.unknown++
    const rawCapped = capRaw(line)
    const msg: NewMessage = {
      idx: nextIdx++,
      ts: resolveTs(obj),
      role: 'system',
      kind: 'unknown',
      content: '',
      raw: rawCapped,
    }
    return [msg]
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  function resolveTs(obj: Record<string, unknown>): number {
    // Prefer ISO string `timestamp`
    if (typeof obj['timestamp'] === 'string') {
      const ms = Date.parse(obj['timestamp'])
      if (!isNaN(ms)) {
        lastTs = ms
        return ms
      }
    }
    // Fall back to numeric `ts`
    if (typeof obj['ts'] === 'number' && isFinite(obj['ts'])) {
      lastTs = obj['ts']
      return obj['ts']
    }
    // Inherit lastTs (or 0 if none seen yet)
    return lastTs
  }

  function processConversationEntry(obj: Record<string, unknown>, entryType: string): NewMessage[] {
    const messageField = obj['message']
    if (messageField === null || typeof messageField !== 'object' || Array.isArray(messageField)) {
      // No message field or wrong shape → unknown
      stats.unknown++
      return [
        {
          idx: nextIdx++,
          ts: resolveTs(obj),
          role: 'system',
          kind: 'unknown',
          content: '',
          raw: capRaw(safeStringify(obj)),
        },
      ]
    }

    const msgObj = messageField as Record<string, unknown>
    // role: from message.role, falling back to entry type
    const role = typeof msgObj['role'] === 'string' ? msgObj['role'] : entryType
    const isSidechain = obj['isSidechain'] === true
    const ts = resolveTs(obj)
    const content = msgObj['content']

    // --- Plain string content (13k real entries) ---
    if (typeof content === 'string') {
      if (content.trim() === '') return []
      return [
        {
          idx: nextIdx++,
          ts,
          role,
          kind: isSidechain ? 'sidechain' : 'message',
          content,
        },
      ]
    }

    // --- Array content ---
    if (Array.isArray(content)) {
      return processContentArray(content, role, ts, isSidechain, obj)
    }

    // --- Unrecognizable content shape ---
    stats.unknown++
    return [
      {
        idx: nextIdx++,
        ts,
        role: 'system',
        kind: 'unknown',
        content: '',
        raw: capRaw(safeStringify(obj)),
      },
    ]
  }

  function processContentArray(
    parts: unknown[],
    role: string,
    ts: number,
    isSidechain: boolean,
    obj: Record<string, unknown>,
  ): NewMessage[] {
    const out: NewMessage[] = []

    // Accumulate text and image fragments into one message
    const textFragments: string[] = []

    // Flush the accumulated text/image message if any
    const flushMessage = () => {
      if (textFragments.length > 0) {
        const content = textFragments.join('\n\n')
        if (content.trim() !== '') {
          out.push({
            idx: nextIdx++,
            ts,
            role,
            kind: isSidechain ? 'sidechain' : 'message',
            content,
          })
        }
        textFragments.length = 0
      }
    }

    for (const part of parts) {
      if (part === null || typeof part !== 'object' || Array.isArray(part)) continue

      const p = part as Record<string, unknown>
      const partType = typeof p['type'] === 'string' ? p['type'] : undefined

      if (partType === 'text') {
        // Accumulate text
        const text = typeof p['text'] === 'string' ? p['text'] : ''
        if (text.length > 0) textFragments.push(text)
        continue
      }

      if (partType === 'image') {
        // Append literal '[image]' token to current message
        textFragments.push('[image]')
        continue
      }

      if (partType === 'thinking') {
        // v1 decision: skip thinking parts
        continue
      }

      if (partType === 'tool_result') {
        // Privacy + size: skip tool results entirely
        continue
      }

      if (partType === 'tool_use') {
        // Each tool_use becomes a separate tool_call row AFTER flushing any
        // accumulated text so the ordering is: message first, then tool_calls.
        flushMessage()
        const toolName = typeof p['name'] === 'string' ? p['name'] : ''
        const toolMeta = buildToolMeta(p['input'])
        out.push({
          idx: nextIdx++,
          ts,
          role,
          kind: isSidechain ? 'sidechain' : 'tool_call',
          content: '',
          toolName,
          toolMeta,
        })
        continue
      }

      // Unknown part type — ignore silently (part-level, not entry-level unknown)
    }

    flushMessage()

    // If the entry produced nothing (e.g. all tool_result or all whitespace text),
    // return empty without incrementing stats — this is expected behaviour.
    return out
  }

  return { push, stats }
}

// ---------------------------------------------------------------------------
// Module-level constants and utilities
// ---------------------------------------------------------------------------

/** Types counted in skippedMeta — known metadata, 15%+ of real entries. */
const SKIP_TYPES = new Set([
  'attachment',
  'last-prompt',
  'pr-link',
  'permission-mode',
  'custom-title',
  'agent-name',
  'system',
  'queue-operation',
  'mode',
  'ai-title',
  'progress',
  'worktree-state',
  'file-history-snapshot',
  'summary',
])

const RAW_CAP = 32 * 1024
const TRUNCATION_SUFFIX = '…[truncated]'

/** Cap a raw string at 32 KiB with a truncation suffix. */
function capRaw(s: string): string {
  if (s.length <= RAW_CAP) return s
  return s.slice(0, RAW_CAP) + TRUNCATION_SUFFIX
}

/** Safely stringify any value without throwing. */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return ''
  }
}

/** Preview keys extracted for toolMeta. Order matters for field presence. */
const TOOL_META_KEYS = ['file_path', 'command', 'url', 'query', 'pattern', 'prompt', 'description'] as const

const TOOL_META_VALUE_CAP = 200
const TOOL_META_TOTAL_CAP = 2048

/**
 * Build a bounded JSON string of notable tool arguments.
 *
 * - Extracts only the TOOL_META_KEYS listed above.
 * - Truncates each string value to 200 chars.
 * - Truncates the total JSON to 2 KiB.
 */
function buildToolMeta(input: unknown): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return '{}'

  const inp = input as Record<string, unknown>
  const preview: Record<string, string> = {}

  for (const key of TOOL_META_KEYS) {
    const val = inp[key]
    if (val !== undefined) {
      const str = typeof val === 'string' ? val : safeStringify(val)
      preview[key] = str.length > TOOL_META_VALUE_CAP ? str.slice(0, TOOL_META_VALUE_CAP) : str
    }
  }

  let json = safeStringify(preview)
  if (json.length > TOOL_META_TOTAL_CAP) {
    json = json.slice(0, TOOL_META_TOTAL_CAP)
    // Ensure it's still valid JSON by replacing with a truncation marker object.
    // Rather than mangling the JSON, cap the serialized string and note truncation.
    json = '{"_truncated":true}'
  }

  return json
}
