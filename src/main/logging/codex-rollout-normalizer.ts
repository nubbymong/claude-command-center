/**
 * codex-rollout-normalizer.ts: the Codex rollout JSONL to NewMessage
 * normalizer (P3.12, row 31), beside Claude's transcript-normalizer.ts.
 *
 * It is the one logging module that knows Codex's rollout format (tokenomics'
 * tk-parse reads the same files for spend); everything else consumes its rows,
 * which have the shape Claude's normalizer gives:
 *  - the conversation as Codex shows it: the user's words and the assistant's.
 *    A rollout records that history one of two ways (Codex's rollout policy,
 *    0.153.4 and 0.155.1): legacy history as `event_msg` user_message /
 *    agent_message, paginated history as `event_msg` item_completed with a
 *    UserMessage / AgentMessage item. A rollout persists only one of the two,
 *    so both are read. A user_message that carries a kind other than
 *    `plain` (`user_instructions`, `environment_context`: injected context,
 *    in builds that record it as an event) is not the user's words (P3.12
 *    round 1). The `response_item` messages are NOT read: they repeat
 *    those words and carry the context Codex injects (developer instructions,
 *    the environment, AGENTS.md), which is not the conversation;
 *  - a tool_call row per tool call, from the response items both histories
 *    persist (function_call, custom_tool_call, local_shell_call,
 *    web_search_call), with Claude's bounded preview (buildToolMeta): a shell
 *    call's command (the shell's own script when it is wrapped in `bash -lc` or
 *    `powershell -Command`), the first file an apply_patch names, a search's
 *    query, and any of Claude's preview keys the arguments carry;
 *  - tool outputs and reasoning are skipped, as Claude skips tool results and
 *    thinking; every known record type is metadata; a record type this does not
 *    know is kept as an unsupported entry with its line, capped (Claude's rule).
 *
 * `readCodexRolloutLine` is the line reader both the normalizer and the GitHub
 * Session Context loader use (row 65), so the two read a rollout alike.
 *
 * Contract (Claude's): never throws, idx dense from startIdx, ts from each
 * record's `timestamp`, else the last one seen. No imports beyond types and
 * the shared bounds; no default export.
 */
import type { NewMessage } from './transcripts-db'
import { buildToolMeta, capRaw, type Normalizer, type NormalizerStats } from './transcript-normalizer'

/** Bumped when the rows this makes, or the rules that make them, change. */
export const CODEX_PARSER_VERSION = 1

/** A file an edit names, and what the edit does to it. */
export interface CodexFileTouch {
  path: string
  op: 'add' | 'update' | 'delete'
}

/** What one rollout record says, in the terms the app uses. */
export type CodexRolloutEntry =
  | { kind: 'message'; role: 'user' | 'assistant'; text: string }
  | {
      kind: 'tool'
      name: string
      command?: string
      /** The files an apply_patch in the call edits. */
      edits?: CodexFileTouch[]
      /** A file the call's arguments name (file_path, path): not an edit. */
      filePath?: string
      url?: string
      query?: string
      pattern?: string
      prompt?: string
      description?: string
    }
  /** The files an edit changed, as its completion records them (not a call). */
  | { kind: 'files'; files: CodexFileTouch[] }
  /** A record type this does not know. */
  | { kind: 'unknown' }

/** The top-level record types Codex writes (snake_case wire names, 0.153.4
 *  and 0.155.1); every one but the two read here is metadata. */
const KNOWN_RECORDS = new Set([
  'session_meta',
  'response_item',
  'event_msg',
  'turn_context',
  'compacted',
  'world_state',
  'token_usage_record',
  'retained_context',
  'security_risk_score',
  'inter_agent_communication',
  'inter_agent_communication_metadata',
  'realtime_item',
])

/** The most files one record may name here, and the longest name kept. */
const MAX_FILES = 20
const MAX_PATH_CHARS = 1024
/** The longest tool name kept (Claude keeps its tool names as given; a
 *  rollout is untrusted text, so this one is bounded). */
const MAX_TOOL_NAME_CHARS = 200
/** Arguments longer than this are not parsed for a preview. */
const MAX_ARGUMENTS_CHARS = 256 * 1024

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/** A shell's own script when the command is wrapped (`bash -lc <script>`,
 *  `powershell -NoProfile -Command <script>`, `cmd /c <script>`), else the
 *  words joined; a string as given. */
function commandText(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (!Array.isArray(v) || v.length === 0 || !v.every((s) => typeof s === 'string')) return undefined
  const words = v as string[]
  if (words.length >= 3 && /^(?:-l?c|-command|\/c)$/i.test(words[words.length - 2])) return words[words.length - 1]
  return words.join(' ')
}

/** The files an apply_patch names (its `*** Add/Update/Delete File:` lines),
 *  whether the patch is given as is or inside a JavaScript string (the code
 *  mode's `tools.apply_patch("...")`, where the line breaks are `\n`). */
function patchFiles(input: string): CodexFileTouch[] {
  const out: CodexFileTouch[] = []
  const re = /\*\*\* (Add|Update|Delete) File: (.+?)(?=\\n|\r?\n|"|$)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(input)) !== null && out.length < MAX_FILES) {
    const path = m[2].replace(/\\\\/g, '\\').trim()
    if (path && path.length <= MAX_PATH_CHARS) out.push({ path, op: m[1].toLowerCase() as CodexFileTouch['op'] })
  }
  return out
}

/** The files a FileChange map names (keys), with each change's type. */
function changeFiles(changes: unknown): CodexFileTouch[] {
  if (!isObject(changes)) return []
  const out: CodexFileTouch[] = []
  for (const [path, change] of Object.entries(changes)) {
    if (out.length >= MAX_FILES) break
    if (!path || path.length > MAX_PATH_CHARS) continue
    const type = isObject(change) ? change.type : undefined
    const op = type === 'add' || type === 'delete' || type === 'update' ? type : 'update'
    out.push({ path, op })
  }
  return out
}

/** Claude's preview keys from a tool call's arguments, with Codex's own
 *  spellings: `cmd` for the command, `path` for the file. */
function argumentFacts(args: unknown): Partial<Extract<CodexRolloutEntry, { kind: 'tool' }>> {
  if (!isObject(args)) return {}
  const out: Partial<Extract<CodexRolloutEntry, { kind: 'tool' }>> = {}
  const command = commandText(args.command) ?? str(args.cmd)
  if (command !== undefined) out.command = command
  const file = str(args.file_path) ?? str(args.path)
  if (file) out.filePath = file.slice(0, MAX_PATH_CHARS)
  for (const k of ['url', 'query', 'pattern', 'prompt', 'description'] as const) {
    const v = str(args[k])
    if (v !== undefined) out[k] = v
  }
  return out
}

/** A tool call's name, bounded. */
const toolName = (v: unknown): string => (typeof v === 'string' ? v.slice(0, MAX_TOOL_NAME_CHARS) : '')

/** The text parts of a turn's content, with `[image]` for each image, joined
 *  as Claude's normalizer joins fragments. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const p of content) {
    if (!isObject(p)) continue
    const type = p.type
    if ((type === 'text' || type === 'Text' || type === 'input_text' || type === 'output_text') && typeof p.text === 'string') {
      if (p.text.length > 0) parts.push(p.text)
    } else if (type === 'image' || type === 'local_image' || type === 'input_image') {
      parts.push('[image]')
    }
  }
  return parts.join('\n\n')
}

function responseItemEntries(p: Record<string, unknown>): CodexRolloutEntry[] {
  switch (p.type) {
    case 'function_call': {
      const raw = p.arguments
      let args: unknown = raw
      if (typeof raw === 'string') {
        args = undefined
        if (raw.length <= MAX_ARGUMENTS_CHARS) {
          try { args = JSON.parse(raw) } catch { args = undefined }
        }
      }
      return [{ kind: 'tool', name: toolName(p.name), ...argumentFacts(args) }]
    }
    case 'custom_tool_call': {
      const edits = typeof p.input === 'string' ? patchFiles(p.input) : []
      return [{ kind: 'tool', name: toolName(p.name), ...(edits.length ? { edits } : {}) }]
    }
    case 'local_shell_call': {
      const action = isObject(p.action) ? p.action : {}
      const command = commandText(action.command)
      return [{ kind: 'tool', name: 'local_shell', ...(command !== undefined ? { command } : {}) }]
    }
    case 'web_search_call': {
      const action = isObject(p.action) ? p.action : {}
      const query = str(action.query)
      return [{ kind: 'tool', name: 'web_search', ...(query !== undefined ? { query } : {}) }]
    }
    default:
      // messages (read from the events instead), reasoning, tool outputs and
      // every other response item: not the conversation's rows.
      return []
  }
}

function eventEntries(p: Record<string, unknown>): CodexRolloutEntry[] {
  switch (p.type) {
    case 'user_message': {
      // Round 1 (B6): only a plain user_message (or one with no kind) is the
      // user's words; another kind is context Codex injected.
      if (typeof p.kind === 'string' && p.kind !== 'plain') return []
      const parts: string[] = []
      if (typeof p.message === 'string' && p.message.length > 0) parts.push(p.message)
      for (const list of [p.images, p.local_images]) if (Array.isArray(list)) for (let i = 0; i < list.length; i++) parts.push('[image]')
      const text = parts.join('\n\n')
      return text.trim() ? [{ kind: 'message', role: 'user', text }] : []
    }
    case 'agent_message': {
      const text = str(p.message) ?? ''
      return text.trim() ? [{ kind: 'message', role: 'assistant', text }] : []
    }
    case 'patch_apply_end': {
      const files = changeFiles(p.changes)
      return files.length ? [{ kind: 'files', files }] : []
    }
    case 'item_completed': {
      const it = p.item
      if (!isObject(it)) return []
      if (it.type === 'UserMessage' || it.type === 'AgentMessage') {
        const text = contentText(it.content)
        return text.trim() ? [{ kind: 'message', role: it.type === 'UserMessage' ? 'user' : 'assistant', text }] : []
      }
      if (it.type === 'FileChange') {
        const files = changeFiles(it.changes)
        return files.length ? [{ kind: 'files', files }] : []
      }
      return []
    }
    default:
      return []
  }
}

/**
 * What one rollout line says: its time (null when it gives none) and its
 * entries, or null when the line is not a JSON object (malformed). A blank
 * line says nothing. Never throws.
 */
export function readCodexRolloutLine(line: string): { ts: number | null; entries: CodexRolloutEntry[] } | null {
  if (typeof line !== 'string' || !line.trim()) return { ts: null, entries: [] }
  let rec: unknown
  try { rec = JSON.parse(line) } catch { return null }
  if (!isObject(rec)) return null
  const at = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN
  const ts = Number.isFinite(at) ? at : null
  const type = rec.type
  if (typeof type !== 'string' || !KNOWN_RECORDS.has(type)) return { ts, entries: [{ kind: 'unknown' }] }
  const payload = rec.payload
  if (!isObject(payload)) return { ts, entries: [] }
  try {
    if (type === 'response_item') return { ts, entries: responseItemEntries(payload) }
    if (type === 'event_msg') return { ts, entries: eventEntries(payload) }
  } catch {
    return { ts, entries: [] }
  }
  return { ts, entries: [] }
}

/** Claude's preview of a tool entry: the first file it edits (else the file
 *  its arguments name) as file_path. */
function toolMeta(e: Extract<CodexRolloutEntry, { kind: 'tool' }>): string {
  const file = e.edits && e.edits.length ? e.edits[0].path : e.filePath
  return buildToolMeta({
    ...(file !== undefined ? { file_path: file } : {}),
    ...(e.command !== undefined ? { command: e.command } : {}),
    ...(e.url !== undefined ? { url: e.url } : {}),
    ...(e.query !== undefined ? { query: e.query } : {}),
    ...(e.pattern !== undefined ? { pattern: e.pattern } : {}),
    ...(e.prompt !== undefined ? { prompt: e.prompt } : {}),
    ...(e.description !== undefined ? { description: e.description } : {}),
  })
}

/** A normalizer for one Codex rollout, carrying idx and ts on from where its
 *  run already is (the worker seeds them), as Claude's does. */
/**
 * P3.12 (Y1): `skip` says whether a record written at a time (its own
 * `timestamp`, else the one of the record before it in this read; null
 * when there is none) is left out: nothing of it is indexed, and one
 * divider (`skippedLabel`) goes where a skipped run of records was, before
 * the next rows kept.
 */
export function makeCodexRolloutNormalizer(opts?: { startIdx?: number; startTs?: number; skip?: (recordTs: number | null) => boolean; skippedLabel?: string }): Normalizer {
  let nextIdx = opts?.startIdx ?? 0
  let lastTs = opts?.startTs ?? 0
  /** The last record time this read has seen (its own records only). */
  let lastOwnTs: number | null = null
  let skipped = false
  const stats: NormalizerStats = { malformed: 0, skippedMeta: 0, unknown: 0, unknownParts: 0 }

  function push(line: string): NewMessage[] {
    if (typeof line !== 'string' || !line.trim()) return []
    const read = readCodexRolloutLine(line)
    if (read === null) { stats.malformed++; return [] }
    if (read.ts !== null) lastOwnTs = read.ts
    if (opts?.skip && opts.skip(read.ts ?? lastOwnTs)) {
      if (read.entries.some((e) => e.kind !== 'files')) skipped = true
      return []
    }
    if (read.ts !== null) lastTs = read.ts
    const ts = lastTs
    const out: NewMessage[] = []
    if (skipped && read.entries.some((e) => e.kind !== 'files')) {
      out.push({ idx: nextIdx++, ts, role: 'system', kind: 'clear', content: opts?.skippedLabel ?? '' })
      skipped = false
    }
    for (const e of read.entries) {
      if (e.kind === 'message') {
        out.push({ idx: nextIdx++, ts, role: e.role, kind: 'message', content: e.text })
      } else if (e.kind === 'tool') {
        out.push({ idx: nextIdx++, ts, role: 'assistant', kind: 'tool_call', content: '', toolName: e.name, toolMeta: toolMeta(e) })
      } else if (e.kind === 'unknown') {
        stats.unknown++
        out.push({ idx: nextIdx++, ts, role: 'system', kind: 'unknown', content: '', raw: capRaw(line) })
      }
      // 'files' is what the GitHub Session Context reads; the call that made
      // the change is already a tool_call row.
    }
    if (read.entries.length === 0) stats.skippedMeta++
    return out
  }

  return { push, stats }
}
