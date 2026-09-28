// src/renderer/utils/launchNote.ts
//
// P3.6 (row 22): one line the terminal says when a session next starts, for
// something the start itself cannot say. A Switch account that could not
// carry the conversation into the new account (completion plan section 5:
// the switch starts a new conversation with an honest notice) leaves its
// line here; the view showing the session writes it, dimmed, as that start
// begins (TerminalView), and it is gone once written. One per session, a
// newer one replacing it; the map is bounded.

const MAX_NOTES = 64
const notes = new Map<string, string>()

/** Nothing that drives the terminal: control characters (C0, DEL, C1,
 *  escape sequences' introducers) are taken out, and the line is bounded. */
function plain(line: string): string {
  return line.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 1000)
}

/** Say `line` in this session's terminal when it next starts. */
export function setLaunchNote(sessionId: string, line: string): void {
  const text = plain(String(line ?? ''))
  if (!text) return
  notes.delete(sessionId)
  notes.set(sessionId, text)
  while (notes.size > MAX_NOTES) {
    const oldest = notes.keys().next().value
    if (oldest === undefined) break
    notes.delete(oldest)
  }
}

/** The line to say as this session starts, once; undefined when none. */
export function takeLaunchNote(sessionId: string): string | undefined {
  const line = notes.get(sessionId)
  notes.delete(sessionId)
  return line
}
