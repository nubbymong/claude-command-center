/**
 * Strip cursor-related escape sequences from terminal data.
 *
 * Claude Code's TUI draws its own "cursor" by painting a colored block
 * character (white, yellow, sometimes other shades) at the input
 * position, and during "thinking" it animates that block across the
 * screen. From the user's perspective it looks like a flashing cursor
 * jumping around, even with xterm's own cursor disabled.
 *
 * Defense in depth:
 * 1. Remove cursor SHOW / blink / style escape sequences so xterm's
 *    own cursor stays hidden no matter what Claude requests.
 * 2. Walk every SGR sequence's parameter list and drop:
 *    - reverse-video (7) and reverse-off (27)
 *    - 8-color and bright backgrounds (40-47, 100-107)
 *    - 256-color backgrounds (48;5;N — three consecutive tokens)
 *    - truecolor backgrounds (48;2;R;G;B — five consecutive tokens)
 *    Foreground tokens (38;5;* and 38;2;*) are kept verbatim so syntax
 *    highlighting still renders.
 *
 * Why a single param-walker (not a sequence of standalone regexes):
 * Claude composes SGR aggressively — `\x1b[1;7;43m` (bold+inverse+yellow-bg),
 * `\x1b[38;2;255;0;0;48;2;0;0;0m` (FG+BG truecolor in one). Standalone
 * regexes only match isolated sequences and silently miss the compound
 * ones — that lets the white/yellow block keep rendering. Walking
 * params catches every variant.
 *
 * Trade-off: legit BG highlighting in tools like `bat`, `diff`, `cat`
 * also goes flat — by far the right call given this was the #1 complaint.
 */
export function stripCursorSequences(data: string): string {
  return data
    .replace(/\x1b\[\?25h/g, '')        // strip cursor SHOW only (keep hide sequences)
    .replace(/\x1b\[\?12[hl]/g, '')     // blink on/off
    .replace(/\x1b\[\d+ q/g, '')        // cursor style
    .replace(/\x1b\[([0-9;]*)m/g, (match, params: string) => {
      if (!params) return match
      const parts = params.split(';')
      const out: string[] = []
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i]
        // Foreground color compounds — pass through verbatim, advancing
        // past their sub-tokens so the blink-mode check below doesn't
        // mistake the `5` in `38;5;N` for SGR 5 (slow blink).
        if (p === '38') {
          const sub = parts[i + 1]
          if (sub === '5' && parts[i + 2] !== undefined) {
            out.push(p, sub, parts[i + 2])
            i += 2
            continue
          }
          if (sub === '2' && parts[i + 4] !== undefined) {
            out.push(p, sub, parts[i + 2], parts[i + 3], parts[i + 4])
            i += 4
            continue
          }
          // Malformed FG colour escape — keep the lone 38 token, the
          // ECMA spec leaves the next token as a no-op then.
          out.push(p)
          continue
        }
        if (p === '7' || p === '27') continue                  // reverse video on/off
        if (p === '5' || p === '6' || p === '25') continue     // slow blink, fast blink, blink-off
        if (/^(?:4[0-7]|10[0-7])$/.test(p)) continue           // 8-color / bright bg
        if (p === '48') {
          const sub = parts[i + 1]
          if (sub === '5') { i += 2; continue }                // 48;5;N
          if (sub === '2') { i += 4; continue }                // 48;2;R;G;B
          // Malformed 48 with no sub — drop the lone 48 token.
          continue
        }
        out.push(p)
      }
      if (out.length === parts.length) return match            // nothing changed
      if (out.length === 0) return ''                          // SGR collapsed empty
      return '\x1b[' + out.join(';') + 'm'
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
