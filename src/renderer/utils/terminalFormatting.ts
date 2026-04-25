/**
 * Strip the narrow set of escape sequences that fight our xterm
 * preferences: cursor blink mode and cursor-style (DECSCUSR). Claude's
 * TUI sometimes asks for a blinking block cursor that overrides the
 * user's `cursorBlink: false` / `cursorStyle: 'bar'` settings.
 *
 * Reverse-video, backgrounds, and spinner glyphs are NO LONGER
 * stripped here. With ConPTY + alternate-screen rendering
 * (CLAUDE_CODE_NO_FLICKER=1), Claude's TUI repaints faithfully and
 * the historical "yellow flashing block" symptom goes away at the
 * PTY-fidelity layer rather than via downstream byte rewrites.
 */
export function stripCursorSequences(data: string): string {
  return data
    .replace(/\x1b\[\?12[hl]/g, '')     // blink on/off
    .replace(/\x1b\[\d+ q/g, '')        // cursor style
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
