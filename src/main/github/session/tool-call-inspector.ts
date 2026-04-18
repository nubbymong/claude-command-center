import type { ToolCallFileSignal } from '../../../shared/github-types'

/**
 * Narrow subset of the session transcript event shape this module reads.
 * `result` is intentionally NOT part of the type — tool-call RESULTS are
 * never read by this inspector under any code path. Callers passing richer
 * events should trust the inspector to ignore every field outside this
 * interface.
 */
export interface TranscriptToolCall {
  type: 'tool_call'
  tool: string
  args: Record<string, unknown>
  timestamp: number
}

// Tools for which `args.file_path` is the ONLY field read.
const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'MultiEdit'])

// Bash commands whose FIRST token matches this allowlist get their
// path-shaped argument tokens extracted. The command body (everything
// after the first token) is tokenized and filtered — secrets that don't
// look like paths are never captured.
const BASH_PATH_ALLOWLIST = new Set(['git', 'gh', 'cat', 'rm', 'mv', 'cp', 'ls', 'mkdir'])

// A token is treated as a path if it starts with '/', '~', './', '../',
// a Windows drive letter, or a `word/` prefix. This excludes shell flags,
// URLs, environment assignments, and quoted strings.
const PATH_ARG_REGEX = /^(?:\/|~|\.\/|\.\.\/|[A-Za-z]:|\w+\/)/

const MAX_FILES = 20
const MAX_LOOKBACK_EVENTS = 100
const MAX_LOOKBACK_MS = 30 * 60 * 1000

/**
 * Extracts recent-file signals from a session's transcript tool-call events.
 *
 * Security invariants (tested explicitly):
 *   - NEVER reads `old_string`, `new_string`, or any other field of an Edit/
 *     MultiEdit event beyond `file_path`.
 *   - NEVER reads the body of a Bash command beyond its first token. For
 *     allowlisted first tokens, later path-shaped arguments are captured.
 *     Secrets in the command body (env assignments, URLs, arbitrary strings)
 *     are filtered out by PATH_ARG_REGEX.
 *   - NEVER reads tool-call `result` fields. The TranscriptToolCall interface
 *     intentionally omits them.
 *   - IGNORES any tool type not on the allowlist above — no data is captured
 *     from WebFetch, TodoWrite, etc.
 *
 * This module enforces the "minimum surface" principle on tool-call data so
 * the transcript-scanning opt-in toggle in spec §10 can be independently
 * justified without auditing the entire tool-call shape.
 */
export function extractFileSignals(events: TranscriptToolCall[]): ToolCallFileSignal[] {
  const now = Date.now()
  const cutoff = now - MAX_LOOKBACK_MS
  const recent = events.slice(-MAX_LOOKBACK_EVENTS).filter((e) => e.timestamp >= cutoff)

  const signals: ToolCallFileSignal[] = []
  for (const e of recent) {
    if (e.type !== 'tool_call') continue

    if (FILE_TOOLS.has(e.tool)) {
      const fp = typeof e.args?.file_path === 'string' ? e.args.file_path : null
      if (fp) {
        signals.push({
          filePath: fp,
          at: e.timestamp,
          tool: e.tool as ToolCallFileSignal['tool'],
        })
      }
      continue
    }

    if (e.tool === 'Bash') {
      const cmd = typeof e.args?.command === 'string' ? e.args.command : ''
      const tokens = cmd.trim().split(/\s+/)
      const first = tokens[0] ?? ''
      if (!BASH_PATH_ALLOWLIST.has(first)) continue
      for (const tok of tokens.slice(1)) {
        if (PATH_ARG_REGEX.test(tok)) {
          signals.push({ filePath: tok, at: e.timestamp, tool: 'Bash' })
        }
      }
    }
    // All other tools: nothing is read.
  }

  // Dedupe by filePath (newest wins).
  const latest = new Map<string, ToolCallFileSignal>()
  for (const s of signals) {
    const prev = latest.get(s.filePath)
    if (!prev || s.at > prev.at) latest.set(s.filePath, s)
  }
  return Array.from(latest.values())
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_FILES)
}
