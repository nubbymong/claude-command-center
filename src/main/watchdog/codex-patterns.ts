// P3.10 (row 43): the Session Watchdog's detectors for a Codex session --
// Codex's own words and screen, never Claude Code's (aicc_planning#72: a CLI
// without its own patterns has that check reported unavailable, never run with
// another CLI's). Pure functions over the rendered pane, as patterns.ts is.
//
// Evidence: the strings of the 0.153.4 and 0.155.1 binaries, and the raw
// screens of the real TUIs on the test VM (P3.8's and P3.10's probes):
//  - an error is its own history cell, drawn from column 0 with a black square
//    and a space (U+25A0, then "Conversation interrupted - ...");
//  - a usage limit is such a cell: "You've hit your usage limit. Upgrade to
//    Pro (...), visit ... to purchase more credits or try again at 3:05 PM."
//    (a later day: "... try again at Oct 1st, 2026 3:05 PM."; none known:
//    "... or try again later."); a model's own limit says "You've hit your
//    usage limit for <model>. Switch to another model now, or try again at
//    ..."; "Usage limit reached. You've reached your usage limit." too;
//  - a sustained server error is such a cell after Codex's own retries: "We're
//    currently experiencing high demand, which may cause temporary errors.",
//    "Selected model is at capacity. Please try a different model.",
//    "exceeded retry limit, last status: 503 Service Unavailable", a stream
//    disconnected before completion, "Server overloaded; retry later.";
//  - while Codex retries it shows "Reconnecting... 2/5 (4s . esc to
//    interrupt)", its internal retry, with the failure as a child line (U+2514, "
//    Stream disconnected before completion: ..."), never an error cell;
//  - a turn running shows "esc to interrupt" on its status row;
//  - the composer is a row starting with its prompt glyph, the footer under
//    it; readiness is src/shared/codex-screen.ts's reading, the same the app's
//    own Codex commands use (P3.8).
// Codex has no flagged-safeguard message a retry clears (its cyber and policy
// refusals are not false positives to retry), so the safeguard check is
// unavailable for Codex.
import { readCodexScreen } from '../../shared/codex-screen'
import type { ScreenLine } from '../../shared/codex-screen'
import type { ParsedResetTime } from './time-parser'
import type { SendGateResult } from './patterns'

const ERROR_GLYPH = String.fromCharCode(0x25a0)
const PROMPT_GLYPHS = String.fromCharCode(0x203a) + String.fromCharCode(0xbb)
/** A composer or user-message row: a prompt glyph at column 0, then a space or nothing. */
const PROMPT_ROW_RE = new RegExp(`^[${PROMPT_GLYPHS}](?: |$)`)
/** An error cell's first row. */
const ERROR_ROW_RE = new RegExp(`^${ERROR_GLYPH} `)
/** A row that starts another history cell (so ends an error cell's text):
 *  the error square, the prompt glyphs, the bullets Codex starts a cell with,
 *  and box and rule drawing. */
const CELL_START_RE = new RegExp(`^[${ERROR_GLYPH}${PROMPT_GLYPHS}\u2022\u25e6\u2500-\u257f]`)

/** How many rows above the composer count as the live region. */
export const CODEX_LIVE_ROWS = 12
/** How many rows from the bottom a status row ("esc to interrupt") is read in. */
const STATUS_ROWS = 20

const USAGE_LIMIT_RE = [/\bYou['\u2019]ve hit your usage limit\b/i, /\bUsage limit reached\b/i]
/** Codex's own sustained server errors (as error cells only). */
export const CODEX_OVERLOAD_PATTERNS: RegExp[] = [
  /\bWe['\u2019]re currently experiencing high demand\b/i,
  /\bSelected model is at capacity\b/i,
  /\bexceeded retry limit, last status: (?:429|5\d\d)\b/i,
  /\bstream disconnected before completion\b/i,
  /\bServer overloaded\b/i,
  /\binternal server error\b/i,
]
const WORKING_RE = /esc to interrupt/i
const INTERNAL_RETRY_RE = /\bReconnecting\.\.\.\s*\d+\/\d+/i

function rows(text: string): string[] {
  return text.split('\n').map((l) => l.replace(/\s+$/, ''))
}

/** The index of the composer: the last row starting with the prompt glyph
 *  (a user message in the history starts the same way, above it). -1: none. */
function composerRow(lines: string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (PROMPT_ROW_RE.test(lines[i])) return i
  return -1
}

/** The live region: up to CODEX_LIVE_ROWS rows directly above the composer
 *  (the screen's end when there is none). */
function liveRegion(lines: string[], maxRows: number): { lines: string[]; start: number } {
  const end = composerRow(lines)
  const stop = end < 0 ? lines.length : end
  const start = Math.max(0, stop - maxRows)
  return { lines: lines.slice(start, stop), start }
}

/** Each error cell in `lines`: its row index and its text, its continuation
 *  rows joined with spaces (a long message wraps). */
function errorCells(lines: string[]): Array<{ at: number; text: string }> {
  const out: Array<{ at: number; text: string }> = []
  for (let i = 0; i < lines.length; i++) {
    if (!ERROR_ROW_RE.test(lines[i])) continue
    const parts = [lines[i].slice(2).trim()]
    for (let j = i + 1; j < lines.length && j <= i + 6; j++) {
      const l = lines[j]
      if (l.trim() === '' || CELL_START_RE.test(l)) break
      parts.push(l.trim())
    }
    out.push({ at: i, text: parts.join(' ') })
  }
  return out
}

/** The live usage-limit cell, bottom-most first: its row in the live region
 *  and its text; null when none. */
function liveLimitCell(text: string, tailLines: number): { at: number; text: string; region: string[] } | null {
  const region = liveRegion(rows(text), tailLines > 0 ? tailLines : CODEX_LIVE_ROWS).lines
  const cells = errorCells(region)
  for (let k = cells.length - 1; k >= 0; k--) {
    if (USAGE_LIMIT_RE.some((re) => re.test(cells[k].text))) return { ...cells[k], region }
  }
  return null
}

/** A turn running: "esc to interrupt" on a status row near the bottom. */
export function codexIsWorking(text: string): boolean {
  const all = rows(text)
  return all.slice(Math.max(0, all.length - STATUS_ROWS)).some((l) => WORKING_RE.test(l))
}

/** Codex's own retry ("Reconnecting... 2/5"): not recovery; the turn is still failing. */
export function codexIsInternalRetry(text: string): boolean {
  const all = rows(text)
  return all.slice(Math.max(0, all.length - STATUS_ROWS)).some((l) => INTERNAL_RETRY_RE.test(l))
}

/** A usage-limit error cell in the live region, with no turn running. */
export function codexIsRateLimited(text: string, tailLines = CODEX_LIVE_ROWS): boolean {
  return liveLimitCell(text, tailLines) !== null
}

/** The live usage-limit message, for its reset time; null when none. */
export function codexFindRateLimitMessage(text: string): string | null {
  return liveLimitCell(text, CODEX_LIVE_ROWS)?.text ?? null
}

/** Has the session moved on past its limit: a message the user sent, or a
 *  turn running, below the limit cell. With no limit cell live: a turn
 *  running. */
export function codexResumedAfterLimit(text: string, tailLines = CODEX_LIVE_ROWS): boolean {
  const cell = liveLimitCell(text, tailLines)
  if (!cell) return codexIsWorking(text)
  return cell.region.slice(cell.at + 1).some((l) => PROMPT_ROW_RE.test(l) || WORKING_RE.test(l))
}

/** A sustained server error cell in the live region. `_patterns` (the
 *  config's, Claude Code's) are never used for Codex: its own are. */
export function codexDetectOverload(text: string, _patterns?: unknown): boolean {
  const region = liveRegion(rows(text), CODEX_LIVE_ROWS).lines
  return errorCells(region).some((c) => CODEX_OVERLOAD_PATTERNS.some((re) => re.test(c.text)))
}

/** Codex has no safeguard message: never detected. */
export function codexDetectSafeguard(_text?: string, _patterns?: unknown): boolean {
  return false
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const AT_TIME_RE = /\btry again at (?:([A-Za-z]{3})[a-z]* (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}),? )?(\d{1,2}):(\d{2})\s*([AaPp][Mm])\b/

/**
 * The reset time a Codex usage-limit message gives, in the local time Codex
 * formats it in: "try again at 3:05 PM" (today's, or tomorrow's once past),
 * or "try again at Oct 1st, 2026 3:05 PM" (that day). Null when it gives
 * none ("try again later"): the Watchdog then waits its fallback, as for
 * Claude.
 */
export function parseCodexResetTime(message: string, now: Date = new Date()): ParsedResetTime | null {
  if (typeof message !== 'string') return null
  const m = AT_TIME_RE.exec(message)
  if (!m) return null
  let hour = parseInt(m[4], 10)
  const minute = parseInt(m[5], 10)
  const pm = m[6].toLowerCase() === 'pm'
  if (hour < 1 || hour > 12 || minute > 59) return null
  if (pm && hour !== 12) hour += 12
  if (!pm && hour === 12) hour = 0
  if (!m[1]) return { hour, minute, timezone: null, ambiguous: false }
  const month = MONTHS.indexOf(m[1].toLowerCase())
  const day = parseInt(m[2], 10)
  const year = parseInt(m[3], 10)
  if (month < 0 || day < 1 || day > 31) return null
  const target = new Date(year, month, day, hour, minute, 0, 0)
  if (!Number.isFinite(target.getTime()) || target.getDate() !== day) return null
  return { relative: true, waitMs: Math.max(0, target.getTime() - now.getTime()) }
}

/**
 * May an automated line be typed into this Codex pane now: only into Codex's
 * ready, EMPTY composer (src/shared/codex-screen.ts's reading, the same the
 * app's own Codex commands use). A prompt or picker up is a 'menu' (Enter
 * would choose in it), text in the composer a 'draft'; a turn running, the
 * start-up, or a screen that cannot be read defer as a 'menu' too. Fails
 * closed: no screen, no send.
 */
export function codexCanSendNow(_text: string, _nonDim?: string, screen?: ScreenLine[] | null): SendGateResult {
  if (!screen || screen.length === 0) return { ok: false, reason: 'menu' }
  const read = readCodexScreen(screen)
  if (read.screen === 'ready') return read.text === '' ? { ok: true } : { ok: false, reason: 'draft' }
  if (read.screen === 'busy' && read.text !== '') return { ok: false, reason: 'draft' }
  return { ok: false, reason: 'menu' }
}

/** Codex's own composer is on screen and ready (the pane is Codex's). */
export function codexHasInputChrome(_text: string, screen?: ScreenLine[] | null): boolean {
  return !!screen && readCodexScreen(screen).screen === 'ready'
}
