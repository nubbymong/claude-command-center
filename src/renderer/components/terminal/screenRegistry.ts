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

// P3.10: the row shape and the xterm reader live in src/shared/codex-screen.ts
// (the Watchdog reads its headless pane the same way); re-exported here.
import type { ScreenLine } from '../../../shared/codex-screen'
export type { ScreenLine, XtermLike } from '../../../shared/codex-screen'
export { readXtermScreen } from '../../../shared/codex-screen'

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
