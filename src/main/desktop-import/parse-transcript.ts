/**
 * parse-transcript.ts — pure transcript parser for the desktop-chat import (#209).
 *
 * Turns a captured Claude conversation (pasted text, or the message array a
 * share-link / webview capture yields) into a normalised {@link ParsedTranscript}.
 *
 * PURE: no fs, no electron, no network — so it is fully unit-testable and can be
 * reasoned about as the ONLY thing standing between untrusted chat text and the
 * rest of the app.
 *
 * Design notes:
 *   - Role detection is heuristic BY NECESSITY. Copying a conversation out of the
 *     desktop app yields plain text with no machine-readable role markers, so we
 *     look for the conventional line shapes and, when none are found, fall back to
 *     ONE `unknown` message rather than inventing a structure. The UI surfaces
 *     `roleMarkersDetected: false` so the user knows what they got.
 *   - Fenced code blocks are tracked while scanning so a line like `Human:` INSIDE
 *     a fence is content, never a role marker. This is the whole reason the scan
 *     is line-based instead of a regex split.
 *
 * No default export (project convention).
 */

import {
  MAX_TRANSCRIPT_CHARS,
  type ImportCodeBlock,
  type ImportMessage,
  type ImportRole,
  type ImportSource,
  type ParsedTranscript,
} from '../../shared/desktop-import'

const HUMAN_LABELS = ['human', 'you', 'user', 'me', 'prompt']
const ASSISTANT_LABELS = ['assistant', 'claude', 'ai', 'response']
const ALL_LABELS = [...HUMAN_LABELS, ...ASSISTANT_LABELS].join('|')

/**
 * Longest line that can possibly BE a role marker. Anything longer is prose and
 * is never matched against the role patterns.
 *
 * This is a hard DoS bound, not a tidiness rule. `ROLE_ONLY_RE` places two
 * unbounded `\s*` next to each other behind an optional `#`, which backtracks
 * quadratically: a paste of `"Human: hi\n#" + " ".repeat(600_000) + "x"` — plain
 * text a user could genuinely paste — blocked the main process for **133
 * seconds** (measured; 2x input gave 4x time, and the 1.5M-char input cap
 * extrapolates to roughly 13 minutes). The parser runs synchronously inside an
 * `ipcMain.handle`, so that freezes every terminal and the window, with no
 * error — indistinguishable from a deadlock. Paste is the PRIMARY path and is
 * explicitly fed third-party text.
 */
const MAX_ROLE_MARKER_LINE = 200

/**
 * A role marker ALONE on its line, with optional markdown decoration:
 *   `Human:` / `**You**` / `## Assistant` / `Claude`
 */
const ROLE_ONLY_RE = new RegExp(
  `^\\s{0,3}(?:#{1,6}\\s*)?(?:\\*\\*|__)?\\s*(${ALL_LABELS})\\s*(?:\\*\\*|__)?\\s*[:：]?\\s*$`,
  'i',
)

/**
 * A role marker followed by content on the SAME line. The colon is REQUIRED here —
 * without it, an ordinary sentence opening with "You need to…" would be misread as
 * a turn boundary.
 */
const ROLE_INLINE_RE = new RegExp(
  `^\\s{0,3}(?:\\*\\*|__)?\\s*(${ALL_LABELS})\\s*(?:\\*\\*|__)?\\s*[:：]\\s+(\\S.*)$`,
  'i',
)

/** Opening or closing fence: three-or-more backticks / tildes. */
const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})\s*(.*)$/

/**
 * Standalone UI chrome the desktop app's copy can drag along. Matched ONLY against
 * a whole trimmed line and ONLY outside fences, so real content is never eaten.
 */
const CHROME_LINES = new Set([
  'retry',
  'copy',
  'edit',
  'share',
  'claude can make mistakes. please double-check responses.',
  'claude can make mistakes. please double-check cited sources.',
])

function roleFromLabel(label: string): ImportRole {
  const l = label.toLowerCase()
  if (HUMAN_LABELS.includes(l)) return 'human'
  if (ASSISTANT_LABELS.includes(l)) return 'assistant'
  return 'unknown'
}

interface FenceState {
  open: boolean
  char: string
  len: number
}

/**
 * Advance the fence state for one line. Returns true when this line WAS a fence
 * delimiter (so callers skip role-marker matching on it).
 *
 * A closing fence must use the same character and be at least as long as the
 * opener, and must carry no info string — matching CommonMark closely enough that
 * a nested ```` ``` ```` inside a ```` ```` ```` block does not close it early.
 */
function stepFence(line: string, state: FenceState): boolean {
  const m = FENCE_RE.exec(line)
  if (!m) return false
  const [, , marker, info] = m
  const char = marker[0]
  if (!state.open) {
    state.open = true
    state.char = char
    state.len = marker.length
    return true
  }
  if (char === state.char && marker.length >= state.len && info.trim() === '') {
    state.open = false
    state.char = ''
    state.len = 0
    return true
  }
  // A different fence character (or one carrying an info string) while open is
  // ordinary content inside the block.
  return false
}

/** Lift every fenced code block out of a message body. */
export function extractCodeBlocks(text: string): ImportCodeBlock[] {
  const blocks: ImportCodeBlock[] = []
  const state: FenceState = { open: false, char: '', len: 0 }
  let lang = ''
  let buf: string[] = []

  for (const line of text.split('\n')) {
    const wasOpen = state.open
    const isFence = stepFence(line, state)
    if (isFence && !wasOpen && state.open) {
      // Opening fence: capture the info string as the language.
      lang = (FENCE_RE.exec(line)?.[3] ?? '').trim().split(/\s+/)[0] ?? ''
      buf = []
      continue
    }
    if (isFence && wasOpen && !state.open) {
      blocks.push({ lang, code: buf.join('\n') })
      lang = ''
      buf = []
      continue
    }
    if (state.open) buf.push(line)
  }

  // Unterminated fence (a truncated paste): keep what we have rather than drop it.
  if (state.open && buf.length > 0) blocks.push({ lang, code: buf.join('\n') })

  return blocks
}

function normalise(raw: string): { text: string; truncated: boolean } {
  let text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
  let truncated = false
  if (text.length > MAX_TRANSCRIPT_CHARS) {
    text = text.slice(0, MAX_TRANSCRIPT_CHARS)
    truncated = true
  }
  return { text, truncated }
}

function finish(role: ImportRole, lines: string[]): ImportMessage | null {
  const text = lines.join('\n').trim()
  if (!text) return null
  return { role, text, codeBlocks: extractCodeBlocks(text) }
}

function summarise(
  source: ImportSource,
  messages: ImportMessage[],
  roleMarkersDetected: boolean,
  truncated: boolean,
  title?: string,
): ParsedTranscript {
  return {
    source,
    title,
    messages,
    messageCount: messages.length,
    codeBlockCount: messages.reduce((n, m) => n + m.codeBlocks.length, 0),
    charCount: messages.reduce((n, m) => n + m.text.length, 0),
    roleMarkersDetected,
    truncated,
  }
}

/**
 * Parse pasted conversation text into messages.
 *
 * When no role markers are found the ENTIRE paste becomes one `unknown` message —
 * we never guess turn boundaries from blank lines, which produced nonsense splits
 * in every shape we tried.
 */
export function parsePastedTranscript(raw: string, source: ImportSource = 'paste'): ParsedTranscript {
  const { text, truncated } = normalise(raw)

  const messages: ImportMessage[] = []
  const state: FenceState = { open: false, char: '', len: 0 }
  let currentRole: ImportRole = 'unknown'
  let buf: string[] = []
  let sawMarker = false

  for (const line of text.split('\n')) {
    if (stepFence(line, state)) {
      buf.push(line)
      continue
    }
    if (state.open) {
      buf.push(line)
      continue
    }

    const trimmed = line.trim()
    if (CHROME_LINES.has(trimmed.toLowerCase())) continue

    // A role marker is short by construction. Skipping long lines bounds the
    // quadratic backtracking in ROLE_ONLY_RE (see MAX_ROLE_MARKER_LINE) and
    // costs nothing: no real marker approaches 200 characters.
    if (line.length > MAX_ROLE_MARKER_LINE) {
      buf.push(line)
      continue
    }

    const only = ROLE_ONLY_RE.exec(line)
    if (only) {
      const done = finish(currentRole, buf)
      if (done) messages.push(done)
      buf = []
      currentRole = roleFromLabel(only[1])
      sawMarker = true
      continue
    }

    const inline = ROLE_INLINE_RE.exec(line)
    if (inline) {
      const done = finish(currentRole, buf)
      if (done) messages.push(done)
      buf = [inline[2]]
      currentRole = roleFromLabel(inline[1])
      sawMarker = true
      continue
    }

    buf.push(line)
  }

  const last = finish(currentRole, buf)
  if (last) messages.push(last)

  if (!sawMarker) {
    const whole = finish('unknown', [text])
    return summarise(source, whole ? [whole] : [], false, truncated)
  }

  return summarise(source, messages, true, truncated)
}

/**
 * Normalise an already-structured message list (share-link / webview capture)
 * into the same shape. Roles arrive machine-readable here, so no heuristics run.
 */
export function parseStructuredTranscript(
  input: { role: ImportRole; text: string }[],
  source: ImportSource,
  title?: string,
): ParsedTranscript {
  let budget = MAX_TRANSCRIPT_CHARS
  let truncated = false
  const messages: ImportMessage[] = []

  for (const m of input) {
    if (budget <= 0) {
      truncated = true
      break
    }
    let text = m.text.replace(/\r\n?/g, '\n').trim()
    if (!text) continue
    if (text.length > budget) {
      text = text.slice(0, budget)
      truncated = true
    }
    budget -= text.length
    messages.push({ role: m.role, text, codeBlocks: extractCodeBlocks(text) })
  }

  return summarise(source, messages, messages.length > 0, truncated, title)
}
