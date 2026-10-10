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
// The class is every character a reader cannot see, named by Unicode rather
// than listed by hand: \p{Cc} (the C0 and C1 controls) and
// \p{Default_Ignorable_Code_Point}, which holds the bidi marks, overrides and
// isolates, the zero-width and invisible formatters, the soft hyphen, the
// fillers that render as nothing (U+034F, the Hangul fillers), the variation
// selectors (both blocks), the Khmer and Mongolian invisibles and the TAG
// block. Hidden characters split a word a reader is matching by eye, and
// invisible ones carry text past a human. Named one by one, because Unicode
// does not count them ignorable: the line and paragraph separators, the braille
// blank (U+2800, drawn as nothing), the interlinear annotation marks
// (U+FFF9-FFFB), and a lone surrogate (half of a character, which a sink may
// draw as anything; a whole pair is one code point and is kept). All replaced
// by a space, a variation selector included: an emoji written with one shows
// as its base character and a space, as a joined emoji already showed its
// parts with spaces between them, and so does a CJK or Mongolian character
// written with one of its variant selectors.
//
// Two scripts the app ships cannot import this module and keep their own copy
// of the same expression; a parity test holds the three to one answer.
const SPOOFABLE = /[\p{Cc}\p{Default_Ignorable_Code_Point}\u2028\u2029\u2800\ufff9-\ufffb\ud800-\udfff]/gu

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
