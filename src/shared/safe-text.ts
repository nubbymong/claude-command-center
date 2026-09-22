// Text that came from somewhere untrusted (a directory name, a spawn error, a
// transcript field) and is about to be shown as PROSE -- in a terminal, in the
// app log, on a panel.
//
// C0 AND C1 CONTROLS OUT, and the Unicode characters that are not controls at
// all but spoof just as well. The first version of this lived inline in
// pty-manager's deferred-spawn failure path and stripped 0x00-0x1F and DEL,
// which closes the 7-bit door and leaves the 8-bit one open: U+009B is CSI,
// U+009D is OSC and U+009C is ST as single code points, NTFS permits all three
// in a file name, and xterm parses them. A directory named with an OSC 8
// sequence would have rendered a clickable link of the attacker's choosing in
// the terminal and the transcript (adversarial round 5). The bidi overrides and
// isolates (U+202A-202E, U+2066-2069) make text DISPLAY in a different order
// from its content, and the line and paragraph separators (U+2028/2029) let a
// path fake a second, separate message on its own line.
//
// Factored out so the app log gets the same treatment as the terminal: the
// debug logger escapes CR and LF at its sink and nothing else, so a working
// directory logged raw put ESC and bidi controls into app.log, where whoever
// reads the log after an incident sees them rendered (adversarial review,
// MINOR). One regex, every sink.
//
// The re-attack extended the class: the bidi MARKS (U+200E/200F/061C) reorder
// rendering like the overrides, scoped to a run; the zero-width and invisible
// formatters (U+200B-200D, U+00AD, U+180E, U+2060-2064, U+FEFF, U+FFF9-FFFB)
// hide characters or split a word a reader is matching by eye; and the TAG
// block (U+E0000-E007F) is invisible in most renderers and has been used to
// smuggle text past a human. All replaced by a space.
const SPOOFABLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu

/** `raw` with every control and spoofing character replaced by a space, cut
 *  to `max` characters. The result is prose-safe for a terminal, a log line or
 *  a UI string; nothing legitimate in a path or an error message is lost. */
export function stripSpoofableText(raw: string, max = 500): string {
  const clean = raw.replace(SPOOFABLE, ' ')
  // Cut on CODE POINTS, never inside a surrogate pair: a lone surrogate at the
  // boundary is itself malformed text a sink may render as garbage.
  if (clean.length <= max) return clean
  const points = Array.from(clean)
  return points.length <= max ? clean : points.slice(0, max).join('')
}
