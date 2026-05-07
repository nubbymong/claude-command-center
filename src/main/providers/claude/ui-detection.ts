/** Detect whether the PTY data shows Claude's TUI is running.
 *  Strict mode (any phase): long box-drawing rules `╭─{5,}` or `╰─{5,}`.
 *  Lenient mode (after claudeSent): single-dash markers + `❯` glyph + vertical bars.
 */
export function detectClaudeUi(data: string, claudeSent: boolean): boolean {
  if (/╭─{5,}|╰─{5,}/.test(data)) return true
  if (claudeSent && /[╭╰┃│]|❯/.test(data)) return true
  return false
}

/** Extract the last shell-prompt-like line from a PTY data chunk.
 *  Strips ANSI escape sequences. Returns empty string when:
 *  - the line is too long (>= 200 chars, likely a binary blob)
 *  - the line contains Claude's `❯` glyph (it's the TUI prompt, not the shell)
 */
export function lastPromptLineForClaude(data: string): string {
  const line = data.split('\n').pop()?.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').trim() || ''
  if (line.length >= 200) return ''
  if (line.includes('❯')) return ''
  return line
}
