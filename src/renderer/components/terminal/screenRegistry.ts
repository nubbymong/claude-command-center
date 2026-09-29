/**
 * A per-session registry of terminal screen readers (P3.8 round 1).
 *
 * The status strip and the command bar type an agent CLI's command (/compact,
 * /model, /plan) only into that CLI's ready composer, and TerminalView, which
 * owns the xterm instance, is elsewhere in the tree: a module-level map keyed
 * by session id connects them, as repaintRegistry does for repaints. A reader
 * returns the live screen (the rows below the scrollback), each row as its
 * text and its text with the dim cells blanked, so a placeholder drawn dim is
 * told apart from what the user typed.
 */

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

export type ScreenReader = () => ScreenLine[] | null

const readers = new Map<string, ScreenReader>()

/** Register a terminal's reader. Returns the unregister function, which only
 *  removes THIS registration (a remount's newer reader is kept). */
export function registerScreenReader(sessionId: string, reader: ScreenReader): () => void {
  readers.set(sessionId, reader)
  return () => {
    if (readers.get(sessionId) === reader) readers.delete(sessionId)
  }
}

/** The session's live screen, or null when it has no terminal. Never throws. */
export function readSessionScreen(sessionId: string): ScreenLine[] | null {
  const reader = readers.get(sessionId)
  if (!reader) return null
  try { return reader() } catch { return null }
}

/** The subset of xterm's API a reader needs (typed loosely: the buffer's
 *  line and cell shapes, not the whole Terminal). */
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
