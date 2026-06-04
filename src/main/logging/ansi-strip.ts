// Precompiled regex patterns for ANSI escape sequence stripping.
// Order matters: OSC must be consumed before the catch-all lone-ESC pattern.

/** CSI (Control Sequence Introducer): ESC [ <params> <intermediates> <final-byte>
 *  Covers SGR colours, cursor moves, erase, etc. */
const RE_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g

/** OSC (Operating System Command): ESC ] <text> (BEL | ST)
 *  ST = ESC \ */
const RE_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/** Two-character ESC sequences: ESC <byte in 0x40-0x5F> (e.g. ESC M, ESC D, ESC E) */
const RE_ESC2 = /\x1b[@-_]/g

/** Any remaining lone ESC byte not consumed above */
const RE_ESC_LONE = /\x1b/g

/**
 * Strip terminal escape sequences from `raw`, preserving printable text,
 * newlines (\n / 0x0A) and tabs (\t / 0x09).
 *
 * Sequences stripped:
 *   - CSI sequences (colours, cursor, erase, …)
 *   - OSC sequences (window title, hyperlinks, …)
 *   - Two-character Fe escape sequences (e.g. ESC M reverse-index)
 *   - Any residual lone ESC byte
 *
 * Other C0 control codes (BEL 0x07, CR 0x0D, etc.) that appear outside an
 * escape sequence are left untouched; callers that need further normalisation
 * can post-process.
 */
export function stripAnsi(raw: string): string {
  return raw
    .replace(RE_CSI, '')
    .replace(RE_OSC, '')
    .replace(RE_ESC2, '')
    .replace(RE_ESC_LONE, '')
}
