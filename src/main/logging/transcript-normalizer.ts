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

/** Message kind produced by the normalizer. transcripts-db keeps kind as string. */
export type MessageKind = 'message' | 'tool_call' | 'sidechain' | 'unknown'

export interface NormalizerStats {
  malformed: number
  skippedMeta: number
  unknown: number
  /** Count of individual content parts that hit the unknown fall-through. */
  unknownParts: number
}

export interface Normalizer {
  push(line: string): NewMessage[]
  stats: NormalizerStats
}

/**
 * P3.16 (M1): `skip` says whether a record written at a time (its own
 * `timestamp`, else the one of the record before it in this read; null when
 * there is none) is left out: nothing of it is indexed, and one divider
 * (`skippedLabel`) goes where a skipped run of records was, before the next
 * rows kept. The rule a Codex rollout's records are read by
 * (codex-rollout-normalizer.ts), for a Claude transcript.
 */
export function makeNormalizer(opts?: { startIdx?: number; startTs?: number; skip?: (recordTs: number | null) => boolean; skippedLabel?: string }): Normalizer {
  const inner = makeRecordNormalizer(opts)
  if (!opts?.skip) return inner
  const skip = opts.skip
  const label = opts.skippedLabel ?? ''
  /** The last record time this read has seen (its own records only). */
  let lastOwnTs: number | null = null
  let skipped = false

  function push(line: string): NewMessage[] {
    if (typeof line !== 'string' || !line.trim()) return []
    let entry: unknown
    try { entry = JSON.parse(line) } catch { return inner.push(line) }
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return inner.push(line)
    const own = recordTime((entry as Record<string, unknown>)['timestamp'])
    if (own !== null) lastOwnTs = own
    if (skip(own ?? lastOwnTs)) {
      if (yieldsRows(entry as Record<string, unknown>)) skipped = true
      return []
    }
    const out = inner.push(line)
    if (skipped && out.length > 0) {
      // The divider takes the first row's place; the rows move up by one.
      const first = out[0]
      for (const m of out) m.idx++
      inner.advanceIdx()
      out.unshift({ idx: first.idx - 1, ts: first.ts, role: 'system', kind: 'clear', content: label })
      skipped = false
    }
    return out
  }

  return { push, stats: inner.stats }
}

/** A date-time with a zone designator (Z or an offset), the form Claude Code writes. */
const ZONED_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/

/** P3.16 (M1): a record's time for the not-indexed rule, when its stamp is a
 *  date-time with a zone designator. A stamp with none is no time (Date.parse
 *  would read it as the machine's local time, not the clock the windows are
 *  kept in), as for a Codex record. */
function recordTime(value: unknown): number | null {
  if (typeof value !== 'string' || !ZONED_TIME_RE.test(value)) return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

/** P3.16 (M1): whether a record would give rows (so leaving it out leaves a
 *  divider): not metadata, and a conversation entry only with content that
 *  shows (text, an image, a tool call); an entry of another type gives an
 *  unknown row. */
function yieldsRows(obj: Record<string, unknown>): boolean {
  if (obj['isMeta'] === true) return false
  const type = typeof obj['type'] === 'string' ? obj['type'] : undefined
  if (type !== undefined && SKIP_TYPES.has(type)) return false
  if (type !== 'user' && type !== 'assistant') return true
  const message = obj['message']
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return true
  const content = (message as Record<string, unknown>)['content']
  if (typeof content === 'string') return content.trim() !== ''
  if (!Array.isArray(content)) return true
  return content.some((p) => {
    if (p === null || typeof p !== 'object' || Array.isArray(p)) return false
    const part = p as Record<string, unknown>
    return (part['type'] === 'text' && typeof part['text'] === 'string' && part['text'] !== '') || part['type'] === 'image' || part['type'] === 'tool_use'
  })
}

function makeRecordNormalizer(opts?: { startIdx?: number; startTs?: number }): Normalizer & { advanceIdx(): void } {
  let nextIdx = opts?.startIdx ?? 0
  let lastTs = opts?.startTs ?? 0

  const stats: NormalizerStats = { malformed: 0, skippedMeta: 0, unknown: 0, unknownParts: 0 }

  function push(line: string): NewMessage[] {
    // 0. Blank/whitespace-only line — not malformed, just empty (e.g. trailing newline)
    if (!line.trim()) return []

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
      return processConversationEntry(obj, entryType, line)
    }

    // 5. Unknown / novel type
    stats.unknown++
    const rawCapped = capRaw(line)
    const msg: NewMessage = {
      idx: nextIdx++,
      ts: resolveTs(obj),
      role: 'system',
      kind: 'unknown' as MessageKind,
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

  function processConversationEntry(
    obj: Record<string, unknown>,
    entryType: string,
    rawLine: string,
  ): NewMessage[] {
    const messageField = obj['message']
    if (messageField === null || typeof messageField !== 'object' || Array.isArray(messageField)) {
      // No message field or wrong shape → unknown; preserve verbatim input line as raw
      stats.unknown++
      return [
        {
          idx: nextIdx++,
          ts: resolveTs(obj),
          role: 'system',
          kind: 'unknown' as MessageKind,
          content: '',
          raw: capRaw(rawLine),
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
          kind: (isSidechain ? 'sidechain' : 'message') as MessageKind,
          content,
        },
      ]
    }

    // --- Array content ---
    if (Array.isArray(content)) {
      return processContentArray(content, role, ts, isSidechain, obj)
    }

    // --- Unrecognizable content shape — preserve verbatim input line as raw ---
    stats.unknown++
    return [
      {
        idx: nextIdx++,
        ts,
        role: 'system',
        kind: 'unknown' as MessageKind,
        content: '',
        raw: capRaw(rawLine),
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
            kind: (isSidechain ? 'sidechain' : 'message') as MessageKind,
            content,
          })
        }
        textFragments.length = 0
      }
    }

    for (const part of parts) {
      if (part === null || typeof part !== 'object' || Array.isArray(part)) {
        // Non-object part (null / primitive / array) — count in part-level drift telemetry
        stats.unknownParts++
        continue
      }

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
          kind: (isSidechain ? 'sidechain' : 'tool_call') as MessageKind,
          content: '',
          toolName,
          toolMeta,
        })
        continue
      }

      // Unknown part type — count in part-level drift telemetry (not entry-level unknown)
      stats.unknownParts++
    }

    flushMessage()

    // If the entry produced nothing (e.g. all tool_result or all whitespace text),
    // return empty without incrementing stats — this is expected behaviour.
    return out
  }

  return { push, stats, advanceIdx: () => { nextIdx++ } }
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

/** UTF-16 char cap (32*1024 chars, not KiB — JS strings are UTF-16 code units). */
const RAW_CAP = 32 * 1024
const TRUNCATION_SUFFIX = '…[truncated]'

/** Cap a raw string at RAW_CAP UTF-16 code units with a truncation suffix.
 *  Guards against a lone high surrogate at the cut boundary. The Codex rollout
 *  normalizer (P3.12) keeps an unknown line with the same cap. */
export function capRaw(s: string): string {
  if (s.length <= RAW_CAP) return s
  let cut = RAW_CAP
  // If the last char of the slice is a lone high surrogate, drop it
  const lastCode = s.charCodeAt(cut - 1)
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut--
  return s.slice(0, cut) + TRUNCATION_SUFFIX
}

/** Safely stringify any value without throwing. */
function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? ''
  } catch {
    return ''
  }
}

/** Preview keys extracted for toolMeta. Order matters: earlier keys survive cap longer. */
const TOOL_META_KEYS = ['file_path', 'command', 'url', 'query', 'pattern', 'prompt', 'description'] as const

const TOOL_META_VALUE_CAP = 200
const TOOL_META_TOTAL_CAP = 2048

/** Truncate a string value to TOOL_META_VALUE_CAP chars, guarding against a lone high surrogate. */
function capMetaValue(s: string): string {
  if (s.length <= TOOL_META_VALUE_CAP) return s
  let cut = TOOL_META_VALUE_CAP
  const lastCode = s.charCodeAt(cut - 1)
  if (lastCode >= 0xd800 && lastCode <= 0xdbff) cut--
  return s.slice(0, cut)
}

/**
 * Build a bounded JSON string of notable tool arguments.
 *
 * - Extracts only TOOL_META_KEYS; ignores all other input fields.
 * - Truncates each string value to 200 chars (surrogate-safe).
 * - If the serialized JSON exceeds 2048 chars, drops trailing keys in reverse
 *   TOOL_META_KEYS order until it fits. Falls back to '{"_truncated":true}'
 *   only if even {file_path} alone would exceed the cap.
 * - The Codex rollout normalizer (P3.12) builds its preview with this too.
 */
export function buildToolMeta(input: unknown): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return '{}'

  const inp = input as Record<string, unknown>
  const preview: Record<string, string> = {}

  for (const key of TOOL_META_KEYS) {
    const val = inp[key]
    if (val !== undefined) {
      const str = typeof val === 'string' ? val : safeStringify(val)
      preview[key] = capMetaValue(str)
    }
  }

  let json = safeStringify(preview)
  if (json.length <= TOOL_META_TOTAL_CAP) return json

  // Drop trailing preview keys (in reverse TOOL_META_KEYS order) until it fits
  const keysInOrder = [...TOOL_META_KEYS] as string[]
  for (let i = keysInOrder.length - 1; i >= 0; i--) {
    delete preview[keysInOrder[i]]
    json = safeStringify(preview)
    if (json.length <= TOOL_META_TOTAL_CAP) return json
  }

  // Even {file_path} alone exceeded the cap — return sentinel
  return '{"_truncated":true}'
}
