/**
 * replay-sanitizer.ts — makes the per-session log REPLAY history-preserving.
 *
 * The replay pane re-renders the captured raw PTY bytes through xterm. Played
 * back verbatim, some sequences DESTROY the very history the pane exists to
 * show: alternate-screen switches (the alt buffer has no scrollback, so a TUI
 * segment replays as just its final partial repaint), full-screen erases
 * (ESC[2J), scrollback erases (ESC[3J) and full resets (ESC c) — a /clear in a
 * session made the whole replay render blank while every byte sat intact in
 * the DB. The live terminal keeps honouring all of these; ONLY the replay
 * neutralises them: alt-screen toggles are stripped, wipes become a visible
 * divider so the user sees where a /clear happened.
 *
 * Stateful: PTY capture batches split at arbitrary byte boundaries, so an
 * escape sequence can straddle two chunks. A trailing partial escape is
 * carried into the next push() (flush() releases it at end-of-stream).
 * Pure renderer lib — no electron, no xterm import. No default export.
 */

/** Visible marker the replay shows where a screen/scrollback wipe happened. */
export const CLEAR_DIVIDER = '\r\n\x1b[2m──── screen cleared ────\x1b[0m\r\n'

// Alt-screen enter/exit incl. legacy variants. Stripped: replay renders
// everything into the normal buffer so history stays in scrollback.
const ALT_SCREEN = /\x1b\[\?(?:1049|1047|1048|47)[hl]/g
// History-destroying erases: 2J (visible screen), 3J (scrollback), ESC c (RIS).
// Plain ESC[J / ESC[0J / ESC[K are partial-line/cursor erases and stay.
const WIPES = /\x1b\[[23]J|\x1bc/g
// A run of wipe markers (with the cursor-home that conventionally accompanies
// a clear) collapses into ONE divider.
const MARKER_RUN = /(?:\u0000(?:\x1b\[H)?)+/g
// Unterminated escape at the end of a chunk (bare ESC, or an unfinished CSI):
// hold it back until the next chunk completes it.
const PARTIAL_ESC_AT_END = /\x1b(?:\[[0-9;?]*)?$/

export class ReplaySanitizer {
  private carry = ''

  /** Sanitize one decoded chunk; returns what is safe to write to the replay
   *  terminal now (a trailing partial escape is withheld for the next push). */
  push(decoded: string): string {
    let s = this.carry + decoded
    this.carry = ''
    const partial = PARTIAL_ESC_AT_END.exec(s)
    if (partial) {
      this.carry = s.slice(partial.index)
      s = s.slice(0, partial.index)
    }
    s = s.replace(ALT_SCREEN, '')
    s = s.replace(WIPES, '\u0000')
    s = s.replace(MARKER_RUN, CLEAR_DIVIDER)
    return s
  }

  /** End-of-stream: release any withheld partial escape verbatim. */
  flush(): string {
    const tail = this.carry
    this.carry = ''
    return tail
  }
}
