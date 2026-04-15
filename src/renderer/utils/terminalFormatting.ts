/**
 * Strip cursor-related escape sequences from terminal data.
 * This removes the yellow block cursor that Claude's TUI renders.
 *
 * Two layers of defense:
 * 1. Remove cursor control sequences (show/hide/blink/style)
 * 2. Replace yellow background colors with default background.
 *    Claude's TUI paints a yellow block cursor using yellow bg (SGR 43/103)
 *    or 256-color/truecolor yellow bg sequences. We replace them with
 *    default bg (SGR 49) so the cursor block becomes invisible.
 */
export function stripCursorSequences(data: string): string {
  return data
    .replace(/\x1b\[\?25h/g, '')        // strip cursor SHOW only (keep hide sequences)
    .replace(/\x1b\[\?12[hl]/g, '')     // blink on/off
    .replace(/\x1b\[\d+ q/g, '')        // cursor style
    // Strip reverse video (SGR 7) from ANY SGR sequence — Claude's TUI uses it for block cursor.
    // Handles standalone \x1b[7m and combined like \x1b[7;33m, \x1b[1;7m, \x1b[7;38;2;...m
    .replace(/\x1b\[([0-9;]*)m/g, (_match, params: string) => {
      if (!params) return _match
      const parts = params.split(';')
      const filtered = parts.filter(p => p !== '7' && p !== '27')
      if (filtered.length === parts.length) return _match  // no reverse video, keep as-is
      if (filtered.length === 0) return ''  // was only reverse video
      return '\x1b[' + filtered.join(';') + 'm'
    })
    // Yellow/bright-yellow background → default background
    .replace(/\x1b\[(?:43|103)m/g, '\x1b[49m')
    // 256-color yellow/orange backgrounds
    .replace(/\x1b\[48;5;(?:3|11|178|179|180|184|185|186|187|190|191|192|208|214|220|221|226|227|228|229)m/g, '\x1b[49m')
    // Truecolor yellow/orange/amber backgrounds (R>150, G>100, B<100)
    .replace(/\x1b\[48;2;(\d+);(\d+);(\d+)m/g, (_match, r, g, b) => {
      const ri = parseInt(r), gi = parseInt(g), bi = parseInt(b)
      if (ri > 150 && gi > 100 && bi < 100) return '\x1b[49m'
      return _match
    })
}

export function formatTokens(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'm'
  if (n >= 1000) return Math.round(n / 1000) + 'k'
  return n.toString()
}

export function formatDuration(ms: number): string {
  const sec = Math.floor(ms / 1000)
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

export function formatResetTime(iso: string): string {
  try {
    const d = new Date(iso)
    const now = new Date()
    const isToday = d.toDateString() === now.toDateString()
    if (isToday) {
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase()
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase()
  } catch { return '' }
}
