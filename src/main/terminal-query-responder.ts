/**
 * Main's answer to a local Codex session's colour query.
 *
 * Once its startup screens are done, Codex asks the terminal for its default
 * colours -- `ESC ] 10 ; ? ESC \` and `ESC ] 11 ; ? ESC \` -- and waits
 * 100 ms for the answers (codex-rs tui terminal_probe.rs `DEFAULT_TIMEOUT`,
 * terminal_probe/windows.rs; the same at rust-v0.153.4 and rust-v0.155.1, with
 * no setting or environment variable that skips it). An answer that comes later
 * stays in the console input, and Codex then reads it as keystrokes: it sits in
 * the composer as typed text (`]10;rgb:...\]11;rgb:...\`). The answer used to
 * come only from the renderer's xterm.js, a round trip through a renderer that
 * can be busy drawing for longer than that (Electron 44 on the test VM: up to
 * 114 ms after the query).
 *
 * So for a local Codex session main answers the query itself, the moment the PTY
 * emits it, with exactly the bytes xterm.js sends, and keeps the query from the
 * renderer so it is never answered twice. Nothing else is answered: any other
 * query, and any query once the program has SET a default colour (main would no
 * longer know what the terminal shows), still goes to xterm.js as before, as
 * does a query whose colours main cannot know exactly.
 *
 * Two limits, neither reachable with Codex as it is (it writes the probe on its
 * own and never sets these colours): the query is cut out without regard to a
 * sequence left unfinished just before it, which the query's ESC would have
 * ended in xterm.js; and a responder lives for one run, so a colour SET by an
 * earlier run in the same terminal (before a Restart) is not known to it.
 */
import { TERMINAL_DEFAULT_COLORS } from '../shared/terminal-colors'
import { resolveHostColorScheme } from './providers/host-color-scheme'

export type Rgb = readonly [number, number, number]

export interface ReplyColors {
  foreground: Rgb
  background: Rgb
}

/** `#rgb` or `#rrggbb` (any case), as xterm.js reads them; anything else null. */
export function parseHexColor(value: string): Rgb | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value)
  if (!m) return null
  const hex = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1]
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)]
}

/**
 * The default colours the renderer gives a session's xterm.js, read in main:
 * the theme as the renderer resolves `data-theme` (the saved `theme`; `system`
 * follows the OS, which main reads from nativeTheme), its foreground, and the
 * user's terminal background when one is set, else the theme's
 * (terminalTheme.ts getTerminalTheme: `override || --surface-stage`). Null when
 * that background is not a colour main can read exactly; the query then goes to
 * xterm.js, which answers it as before.
 */
export function terminalReplyColors(settings: unknown, systemPrefersDark: boolean): ReplyColors | null {
  const s = settings && typeof settings === 'object' ? (settings as Record<string, unknown>) : {}
  const scheme = resolveHostColorScheme(typeof s.theme === 'string' ? s.theme : undefined, systemPrefersDark)
  const theme = TERMINAL_DEFAULT_COLORS[scheme]
  const terminal = s.terminal && typeof s.terminal === 'object' ? (s.terminal as Record<string, unknown>) : {}
  const override = terminal.background
  const background = override ? (typeof override === 'string' ? parseHexColor(override) : null) : parseHexColor(theme.background)
  const foreground = parseHexColor(theme.foreground)
  if (!background || !foreground) return null
  return { foreground, background }
}

/**
 * xterm.js's answer to OSC 10/11 `?` (CoreBrowserTerminal.ts, xterm 6.0.0):
 * `ESC ] <id> ; rgb:rrrr/gggg/bbbb ESC \`, each 8-bit channel as two lower-case
 * hex digits repeated (XParseColor.ts toRgbString, 16 bits), ended with ST
 * whatever ended the query.
 */
export function colorQueryReply(id: 10 | 11, rgb: Rgb): string {
  const ch = (n: number) => { const s = n.toString(16).padStart(2, '0'); return s + s }
  return `\x1b]${id};rgb:${ch(rgb[0])}/${ch(rgb[1])}/${ch(rgb[2])}\x1b\\`
}

/** The four exact queries main answers. */
const QUERIES: ReadonlyArray<{ id: 10 | 11; text: string }> = [
  { id: 10, text: '\x1b]10;?\x1b\\' },
  { id: 10, text: '\x1b]10;?\x07' },
  { id: 11, text: '\x1b]11;?\x1b\\' },
  { id: 11, text: '\x1b]11;?\x07' },
]
const LONGEST_QUERY = Math.max(...QUERIES.map((q) => q.text.length))

/**
 * Where a query that the chunk ends in the middle of starts (a proper prefix of
 * one, from an ESC), or -1. Those bytes wait for the next chunk: on their own
 * they are an unfinished escape sequence, which a terminal cannot act on yet.
 */
function partialQueryStart(buf: string): number {
  for (let i = Math.max(0, buf.length - (LONGEST_QUERY - 1)); i < buf.length; i++) {
    if (buf.charCodeAt(i) !== 0x1b) continue
    const rest = buf.slice(i)
    if (QUERIES.some((q) => q.text.length > rest.length && q.text.startsWith(rest))) return i
  }
  return -1
}

export interface ColorQueryResponder {
  /** One chunk of PTY output in; what goes on to the renderer out (the answered queries removed). */
  filter(chunk: string): string
}

export function createColorQueryResponder(opts: {
  /** The colours to answer with, read when a query arrives; null leaves the query to xterm.js. */
  colors: () => ReplyColors | null
  /** Writes an answer into the session's PTY. */
  reply: (bytes: string) => void
}): ColorQueryResponder {
  let held = ''
  // An OSC 10/11 that is not one of the exact queries (a colour SET, a
  // two-slot query): from then on every query goes to xterm.js.
  let leftToTerminal = false
  return {
    filter(chunk: string): string {
      if (leftToTerminal) return chunk
      const buf = held + chunk
      held = ''
      const cut = partialQueryStart(buf)
      const body = cut < 0 ? buf : buf.slice(0, cut)
      const tail = cut < 0 ? '' : buf.slice(cut)
      let out = ''
      let from = 0
      let colors: ReplyColors | null | undefined
      const osc = /\x1b\]1[01];/g
      for (let m = osc.exec(body); m; m = osc.exec(body)) {
        const at = m.index
        const query = QUERIES.find((q) => body.startsWith(q.text, at))
        if (!query) {
          leftToTerminal = true
          return out + body.slice(from) + tail
        }
        if (colors === undefined) colors = opts.colors()
        if (!colors) continue
        out += body.slice(from, at)
        from = at + query.text.length
        osc.lastIndex = from
        opts.reply(colorQueryReply(query.id, query.id === 10 ? colors.foreground : colors.background))
      }
      held = tail
      return out + body.slice(from)
    },
  }
}
