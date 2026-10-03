/**
 * The context reading a terminal's own output carries (P3.8 round 3, CM),
 * for the session's context meter, which shows how much context is USED.
 *
 * A CLI that prints "N% context left" (or "N% remaining") gives the share
 * LEFT, so it reads as 100 - N used; "N% context", "N% used", "N% ctx",
 * "context: N%" and "N% | $" read as used, as they always have. A figure
 * outside 0-100 is a match with no reading.
 */

/** The terminal's control sequences removed, as the context reading needs. */
export function stripTerminalControls(data: string): string {
  return data
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/\x1b[=>]/g, '')
}

const LEFT_RE = /(\d+(?:\.\d+)?)%\s*(?:of\s+)?(?:(?:the\s+)?context\s+)?(?:left|remaining)\b/i
const USED_RES = [
  /(\d+(?:\.\d+)?)%\s*(?:context|of context|used|ctx)/i,
  /context[:\s]+(\d+(?:\.\d+)?)%/i,
  /(\d+(?:\.\d+)?)%\s*\|\s*\$/i,
]

/** The context used, from text: null when the text carries no figure, else
 *  the used share (null when the figure is out of range). */
export function readContextPercent(text: string): { used: number | null } | null {
  const left = LEFT_RE.exec(text)
  if (left) {
    const pct = parseFloat(left[1])
    return { used: pct >= 0 && pct <= 100 ? 100 - pct : null }
  }
  for (const re of USED_RES) {
    const m = re.exec(text)
    if (m) {
      const pct = parseFloat(m[1])
      return { used: pct >= 0 && pct <= 100 ? pct : null }
    }
  }
  return null
}
