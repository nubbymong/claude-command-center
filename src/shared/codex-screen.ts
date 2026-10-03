/**
 * Reading Codex's TUI from its screen (P3.8 rounds 1 to 4; moved here in P3.10
 * so the main process can read it too). Pure: the rows of a terminal's live
 * screen in, what they show out. The renderer's composer typing
 * (src/renderer/lib/codexComposer.ts) and the Watchdog's send gate for a Codex
 * session (src/main/watchdog/codex-patterns.ts) both read the screen with
 * these, so the two never disagree about when Codex's composer is ready.
 *
 * Evidence (the P3.8 VM probe of the real 0.153.4 and 0.155.1 TUIs, and the
 * strings of their binaries), in short:
 *  - ready: the screen's last line is the footer "<model> <effort> . <folder>"
 *    and the line above it (blank lines aside) is the composer;
 *  - the composer's placeholder is one of two dim texts; anything else in it,
 *    dim or not, is content;
 *  - once a command is typed its popup replaces the footer.
 * P3.10: Codex's "Hooks need review" screens (its startup review of the
 * app's hooks, and the /hooks view it opens) are blocking screens too.
 * WP2 PR 4, P4.1: so are its MCP approval form and its sandbox set-up menu
 * (by title as well as footer); and main's submit primitive
 * (src/main/providers/codex/composer-submit.ts) reads a long paste's
 * placeholder and the composer's height from here.
 */

/** One row of a terminal's live screen. */
export interface ScreenLine {
  /** The row's text, trailing spaces trimmed. */
  text: string
  /** The same row with every dim cell (a placeholder) as a space, trimmed. */
  typed: string
  /** The row's width in cells, and the cell just past its last non-blank one
   *  (P3.8 round 4: where a right-aligned segment ends). Absent when the
   *  reader does not know them. */
  width?: number
  end?: number
}

/** The subset of xterm's API a reader needs (typed loosely: the buffer's
 *  line and cell shapes, not the whole Terminal). The renderer's xterm and
 *  the main process's headless one both have it. */
export interface XtermLike {
  rows: number
  cols: number
  buffer: { active: {
    baseY: number
    getLine(y: number): { getCell(x: number): { getChars(): string; getWidth(): number; isDim(): number | boolean } | undefined } | undefined
  } }
}

/** The live screen of an xterm terminal: the `rows` rows from the top of the
 *  active screen (below any scrollback), whichever buffer is active. */
export function readXtermScreen(term: XtermLike): ScreenLine[] {
  const buf = term.buffer.active
  const out: ScreenLine[] = []
  for (let y = buf.baseY; y < buf.baseY + term.rows; y++) {
    const line = buf.getLine(y)
    if (!line) { out.push({ text: '', typed: '', width: term.cols, end: 0 }); continue }
    let text = ''
    let typed = ''
    let end = 0
    for (let x = 0; x < term.cols; x++) {
      const cell = line.getCell(x)
      if (!cell) break
      if (cell.getWidth() === 0) continue // the second half of a wide character
      const ch = cell.getChars() || ' '
      text += ch
      typed += cell.isDim() ? ' '.repeat(ch.length) : ch
      if (ch.trim() !== '') end = x + Math.max(1, cell.getWidth())
    }
    out.push({ text: text.replace(/\s+$/, ''), typed: typed.replace(/\s+$/, ''), width: term.cols, end })
  }
  return out
}

export type CodexComposerState = 'ready' | 'busy' | 'not-ready'
/** What the live screen shows, in more detail than the state (round 2, WW):
 *  'unrecognised' is a composer with a footer under it that is not the last
 *  row (a narrow window wraps it, or a row is drawn under it). */
export type CodexScreenKind = 'ready' | 'busy' | 'blocked' | 'no-prompt' | 'unrecognised' | 'starting'

/** Codex's prompt glyphs: the composer's, and the one it draws at ultra. */
const GLYPHS = String.fromCharCode(0x203a) + String.fromCharCode(0xbb)
const MIDDLE_DOT = String.fromCharCode(0xb7)
/** The composer row: a prompt glyph, then a space or nothing. */
const COMPOSER_RE = new RegExp(`^[${GLYPHS}](?: |$)`)
const GLYPH_PREFIX_RE = new RegExp(`^[${GLYPHS}] ?`)
/** The efforts the footer names: Codex's levels, and "default" when the
 *  model's own applies (VM: gpt-5.2 and gpt-5.3-codex launched with none). */
const FOOTER_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'default']
/** A model id as the footer can show it, when the session's are not known. */
const ANY_MODEL = '[A-Za-z0-9][A-Za-z0-9._:/-]*'
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
/** The footer (round 2, FT): "<model> <effort> . <folder>", the model one of
 *  `models` when they are given. Codex's own hint lines ("enter select . esc
 *  back", "MCP servers . 2 enabled", "Git . main") name no level after a
 *  model, so they never match. */
function footerRe(models?: readonly string[] | null): RegExp {
  const model = models && models.length > 0 ? `(?:${models.map(escapeRe).join('|')})` : ANY_MODEL
  return new RegExp(`^ {0,8}${model} (?:${FOOTER_EFFORTS.join('|')}) ${MIDDLE_DOT} \\S`)
}
/** On screen means the composer is not the one taking keys: the trust
 *  prompt, Codex's pickers and notices, and (round 2, defence in depth; not
 *  reachable on the VM without a working model) its approval requests, as the
 *  binaries of 0.153.4 and 0.155.1 word them. */
const BLOCKING_RE = [
  /Do you trust the contents of this directory/i,
  /Press enter to continue/i,
  /Press enter to confirm or esc to go back/i,
  /Would you like to run the following command/i,
  /Would you like to send input to (?:the existing )?terminal/i,
  /Do you want to approve network access/i,
  /Would you like to grant these permissions/i,
  /Would you like to make the following edits/i,
  /needs your approval/i,
  // P3.10 (the VM probe of both versions): Codex's review of new or changed
  // hooks at start-up ("Hooks need review ... Trust all and continue"), and
  // the /hooks view its first option opens ("Press t to trust all; enter to
  // review hooks; esc to close"). Nothing is typed into either.
  /Hooks need review/i,
  /\bhooks? needs? review before\b/i,
  /Press t to trust/i,
  // WP2 PR 4, P4.1 (the PR 4 VM probes PB2 and PB4, both versions): Codex's
  // MCP approval form ('Allow the <server> MCP server to run tool "<name>"?'),
  // which takes a digit as its answer at once, and the title of its sandbox
  // set-up menu (its footer above is matched already; the title is defence in
  // depth for a pane that wraps or clips the footer).
  /\bAllow the .{1,80}? MCP server to run tool\b/i,
  /Set up the Codex agent sandbox/i,
]
/** A turn running (its status row). */
const BUSY_RE = /esc to interrupt/i
/** Codex still starting (round 3, V1): 0.153.4 boots its MCP servers after
 *  drawing its prompt, under a status row that reads like a turn ("Booting
 *  MCP server: conductor (0s . esc to interrupt)"); the binaries also say
 *  "Starting MCP servers". Not busy, and not the user's doing. */
const STARTING_RE = /\b(?:Booting MCP server|Starting MCP servers?)\b/i
/** The composer's placeholders (the binaries' strings), drawn dim. */
const PLACEHOLDERS = ['Ask Codex to do anything', 'Ask a follow-up question']
/** A row of the slash-command popup under a typed command. */
const POPUP_ROW_RE = /^ {1,8}\/[a-z][\w-]*(?: |$)/

const nonBlank = (l: ScreenLine): boolean => l.text.trim() !== ''
const blocked = (lines: ScreenLine[]): boolean => lines.some((l) => BLOCKING_RE.some((re) => re.test(l.text)))

/** The index of the composer row: the last row with the prompt glyph. */
function composerIndex(lines: ScreenLine[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if (COMPOSER_RE.test(lines[i].text)) return i
  return -1
}

/** A composer row's content: '' only for nothing or one of Codex's dim
 *  placeholders; anything else there, dim or not, is content (round 2, FT). */
function composerContent(row: ScreenLine): string {
  const all = row.text.replace(GLYPH_PREFIX_RE, '').trim()
  if (all === '') return ''
  const typed = row.typed.replace(GLYPH_PREFIX_RE, '').trim()
  if (typed === '' && PLACEHOLDERS.includes(all)) return ''
  return all
}

/** The screen's structure: what it shows, the composer's content, and the
 *  footer row under the composer when that is the last row. `startup`
 *  (round 4, E3): whether the run is still starting, so that Codex's
 *  start-up row counts; it counts only in its own place, the status row
 *  directly above the composer. */
function layout(lines: ScreenLine[] | null | undefined, models?: readonly string[] | null, startup = true): { screen: CodexScreenKind; text: string; footer: ScreenLine | null } {
  if (!lines || lines.length === 0) return { screen: 'no-prompt', text: '', footer: null }
  if (blocked(lines)) return { screen: 'blocked', text: '', footer: null }
  const shown = lines.filter(nonBlank)
  const i = composerIndex(shown)
  const text = i < 0 ? '' : composerContent(shown[i])
  if (startup && i > 0 && STARTING_RE.test(shown[i - 1].text)) return { screen: 'starting', text, footer: null }
  if (i < 0) return { screen: 'no-prompt', text: '', footer: null }
  const footer = footerRe(models)
  const below = shown.slice(i + 1)
  if (below.length === 1 && footer.test(below[0].text)) {
    return { screen: shown.some((l) => BUSY_RE.test(l.text)) ? 'busy' : 'ready', text, footer: below[0] }
  }
  if (below.some((l) => footer.test(l.text))) return { screen: 'unrecognised', text, footer: null }
  return { screen: 'no-prompt', text, footer: null }
}

/** What the live screen shows, and the composer's content when there is one.
 *  `startup` false: the run has had its first turn (or a command sent), so a
 *  row that looks like Codex's start-up row reads as what it says. */
export function readCodexScreen(lines: ScreenLine[] | null | undefined, models?: readonly string[] | null, opts: { startup?: boolean } = {}): { screen: CodexScreenKind; text: string } {
  const { screen, text } = layout(lines, models, opts.startup ?? true)
  return { screen, text }
}

/** Whether Codex's composer is the one taking keys, from the live screen. */
export function codexComposerState(lines: ScreenLine[] | null | undefined, models?: readonly string[] | null): CodexComposerState {
  const { screen } = readCodexScreen(lines, models)
  return screen === 'ready' ? 'ready' : screen === 'busy' ? 'busy' : 'not-ready'
}

/** What is in the composer ('' for nothing or Codex's placeholder). */
export function codexComposerText(lines: ScreenLine[] | null | undefined): string {
  if (!lines) return ''
  const i = composerIndex(lines)
  return i < 0 ? '' : composerContent(lines[i])
}

/** Whether the screen shows `command` typed at the composer with nothing in
 *  the way (round 2, G5): no blocking prompt, no turn running, the composer
 *  holding exactly the command, and under it only its popup or the footer. */
export function codexCommandTyped(lines: ScreenLine[] | null | undefined, command: string, models?: readonly string[] | null): boolean {
  if (!lines || lines.length === 0 || blocked(lines) || lines.some((l) => BUSY_RE.test(l.text))) return false
  const shown = lines.filter(nonBlank)
  const i = composerIndex(shown)
  if (i < 0 || composerContent(shown[i]) !== command) return false
  const footer = footerRe(models)
  return shown.slice(i + 1).every((l) => POPUP_ROW_RE.test(l.text) || footer.test(l.text))
}

/** A row Codex wraps the composer's text onto: indented under the text. */
const WRAPPED_ROW_RE = /^ {2,}\S/

/** P3.15 round 1 (F8): whether the screen shows `text` typed at the composer,
 *  over the composer row and the rows Codex wraps it onto in a narrow pane
 *  (each indented under the text), with nothing in the way: no blocking
 *  prompt, no turn running, and under it only those rows and then the footer.
 *  The rows are read together with their spaces dropped, because a wrap may
 *  fall at a space (which the wrap takes) or inside a word. */
export function codexTextTyped(lines: ScreenLine[] | null | undefined, text: string, models?: readonly string[] | null): boolean {
  const want = text.replace(/\s+/g, '')
  if (want === '' || !lines || lines.length === 0 || blocked(lines) || lines.some((l) => BUSY_RE.test(l.text))) return false
  const shown = lines.filter(nonBlank)
  const i = composerIndex(shown)
  if (i < 0) return false
  const below = shown.slice(i + 1)
  if (below.length === 0 || !footerRe(models).test(below[below.length - 1].text)) return false
  const wrapped = below.slice(0, -1)
  if (!wrapped.every((l) => WRAPPED_ROW_RE.test(l.text))) return false
  return [composerContent(shown[i]), ...wrapped.map((l) => l.text)].join('').replace(/\s+/g, '') === want
}

/** The placeholder Codex draws in its composer for a long paste: the count is
 *  the paste's length in code points (PB3, PB9). */
const PASTED_CONTENT_RE = /^\[Pasted Content (\d{1,7}) chars\]$/

/** WP2 PR 4, P4.1 (PB9): whether the screen shows Codex's paste placeholder
 *  for exactly `codePoints` at the composer, with nothing in the way: no
 *  blocking prompt, no turn running, the composer holding only the
 *  placeholder, and under it only the footer. Codex folds a text into it from
 *  1,001 code points on, both supported versions, every width probed. */
export function codexPastedContentShown(lines: ScreenLine[] | null | undefined, codePoints: number, models?: readonly string[] | null): boolean {
  if (!Number.isInteger(codePoints) || codePoints < 1) return false
  if (!lines || lines.length === 0 || blocked(lines) || lines.some((l) => BUSY_RE.test(l.text))) return false
  const shown = lines.filter(nonBlank)
  const i = composerIndex(shown)
  if (i < 0) return false
  const m = PASTED_CONTENT_RE.exec(composerContent(shown[i]))
  if (!m || Number(m[1]) !== codePoints) return false
  const below = shown.slice(i + 1)
  return below.length === 1 && footerRe(models).test(below[0].text)
}

/** WP2 PR 4, P4.1 (PB9): how many rows the composer takes on screen now, from
 *  the row with the prompt glyph down to the row above the footer (the rows
 *  Codex wraps a text onto included), or null when no composer stands on a
 *  footer. Codex's composer is at most the pane's rows minus 4 high, and a
 *  taller text scrolls inside it (its first rows hidden), so a composer this
 *  tall holds a text that cannot be confirmed on screen. */
export function codexComposerRows(lines: ScreenLine[] | null | undefined, models?: readonly string[] | null): number | null {
  if (!lines || lines.length === 0) return null
  const shown = lines.filter(nonBlank)
  const i = composerIndex(shown)
  if (i < 0) return null
  const below = shown.slice(i + 1)
  if (below.length === 0 || !footerRe(models).test(below[below.length - 1].text)) return null
  return below.length
}

/** Codex's Plan mode label, right-aligned in its footer after the folder. */
const PLAN_MODE_SEGMENT_RE = /^Plan mode(?: \(shift\+tab to cycle\))?$/
/** The cells Codex leaves after its footer's right segment (the raw bytes). */
const PLAN_MODE_RIGHT_MARGIN = 2
/** Whether Codex's footer shows its Plan mode (rounds 2 and 3; PM1, T19):
 *  read only from the footer row under the composer (the screen's own
 *  structure, the session's models when given), and only from its
 *  right-aligned segment after the folder, so neither a folder named "Plan
 *  mode" nor a footer-shaped line elsewhere reads as it. null when no footer
 *  shows there (a popup, a prompt or start-up: nothing to go by). */
export function codexPlanModeOnScreen(lines: ScreenLine[] | null | undefined, models?: readonly string[] | null): boolean | null {
  const { screen, footer } = layout(lines, models)
  if ((screen !== 'ready' && screen !== 'busy') || footer === null) return null
  const right = / {3,}(\S(?:.*\S)?)\s*$/.exec(footer.text)
  if (!right || !PLAN_MODE_SEGMENT_RE.test(right[1])) return false
  // Round 4 (E4): Codex draws the segment right-aligned, ending two cells
  // from the right edge (the raw footer bytes: the segment, then two
  // spaces); a screen reader that knows the row's width holds it to that.
  if (footer.width !== undefined && footer.end !== undefined && footer.end !== footer.width - PLAN_MODE_RIGHT_MARGIN) return false
  return true
}
