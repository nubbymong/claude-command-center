/** Detect whether the PTY data shows Claude's TUI is running.
 *  Strict mode (any phase): long box-drawing rules `╭─{5,}` or `╰─{5,}`.
 *  Lenient mode (after claudeSent): single-dash markers + `❯` glyph + vertical bars.
 */
export function detectClaudeUi(data: string, claudeSent: boolean): boolean {
  if (/╭─{5,}|╰─{5,}/.test(data)) return true
  if (claudeSent && /[╭╰┃│]|❯/.test(data)) return true
  return false
}

// Escape stripping for the prompt-shape tests. Two gaps in the old
// CSI-only `\x1b\[[0-9;]*[a-zA-Z]` strip broke every END-ANCHORED detector
// on Windows OpenSSH under ConPTY (probed against a real host, 2026-08-27):
//   - the CSI class missed private-mode parameters (`\x1b[?25l` — `?` is not
//     in `[0-9;]`), and
//   - OSC sequences were not stripped at all, and ConPTY appends the
//     window-title OSC to the SAME line as the prompt:
//       `\x1b[?25lpi@host's password: \x1b]0;C:\\...\\ssh.exe\x07\x1b[?25h`
//     so the visible line no longer ENDED with `password:`, the saved
//     password was never typed, and the idle fallback advanced the flow —
//     the "asks to Launch Claude while the password prompt is waiting" bug.
//     The post-login shell prompt gets the same title appended, so
//     SHELL_PROMPT_RE missed too and the whole ladder limped on idle
//     fallbacks. (Git's MSYS ssh emits the title in its own chunk, which is
//     why the bug is client-binary-dependent.)
// The classes mirror the watchdog's proven stripAnsi (patterns.ts); kept
// local so this module stays dependency-free. The final rule drops a
// TRAILING UNTERMINATED escape (e.g. a title OSC split across chunks): after
// complete sequences are removed, anything from a remaining `\x1b` to the end
// of the line is an unfinished sequence, never visible prompt text.
const CSI_SEQ = /\x1b\[[\x20-\x3f]*[\x40-\x7e]/g
const OSC_SEQ = /\x1b\][\s\S]*?(?:\x07|\x1b\\)/g
const OTHER_ESC_SEQ = /\x1b[P_X^][\s\S]*?(?:\x07|\x1b\\)/g
const TRAILING_PARTIAL_ESC = /\x1b[\s\S]*$/

function stripEscapesForPrompt(line: string): string {
  return line
    .replace(OSC_SEQ, '')
    .replace(OTHER_ESC_SEQ, '')
    .replace(CSI_SEQ, '')
    .replace(TRAILING_PARTIAL_ESC, '')
}

/** Extract the last shell-prompt-like line from a PTY data chunk.
 *  Strips ANSI escape sequences (CSI incl. private modes, OSC, DCS/APC/PM,
 *  and a trailing unterminated escape). Returns empty string when:
 *  - the line is too long (>= 200 chars, likely a binary blob)
 *  - the line contains Claude's `❯` glyph (it's the TUI prompt, not the shell)
 */
export function lastPromptLineForClaude(data: string): string {
  const line = stripEscapesForPrompt(data.split('\n').pop() ?? '').trim()
  if (line.length >= 200) return ''
  if (line.includes('❯')) return ''
  return line
}
