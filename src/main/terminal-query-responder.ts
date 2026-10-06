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
 * renderer so it is never answered twice. In the query's place the renderer
 * gets ST alone (`ESC \`), which ends whatever sequence the query's ESC would
 * have ended there, so xterm.js reads the bytes after it as it would have.
 * Nothing else is answered: any other query, and any query once the program has
 * SET a default colour (main would no longer know what the terminal shows),
 * still goes to xterm.js as before, as does a query whose colours main cannot
 * know exactly. A SET is recognised as xterm.js 6.0.0 reads an OSC: started by
 * `ESC ]` or the 8-bit OSC (U+009D), its id the digits up to `;` (leading zeros
 * included), with the C0 controls xterm.js drops inside it left out.
 *
 * Platforms: this runs for a local Codex session on every OS, and was verified
 * live on Windows, where Codex sends only the two colour queries. On macOS and
 * Linux Codex sends them in one write with a cursor position query, and can
 * also send a keyboard and a device attributes query in it
 * (`ESC[6n ... ESC[?u ESC[c`; terminal_probe.rs has a variant with only the
 * cursor position and the two colour queries); main's colour answers then
 * reach Codex before xterm.js's answers to the others, which Codex reads each
 * on its own (terminal_probe.rs update_startup_probe).
 *
 * Limits, none reachable with Codex as it is (it writes the probe on its own and
 * never sets these colours): a responder lives for one run, so a colour SET by
 * an earlier run in the same terminal (before a Restart) is not known to it; and
 * up to 7 characters of an unfinished query held at the end of a chunk are
 * dropped if the run ends right after them (an unfinished escape sequence, which
 * xterm.js could not act on either).
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

/** What the renderer gets in place of an answered query: ST, ending what the query's ESC would have ended. */
export const ANSWERED_QUERY_STAND_IN = '\x1b\\'

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
 * At most LONGEST_QUERY - 1 (7) characters are ever held.
 */
function partialQueryStart(buf: string): number {
  for (let i = Math.max(0, buf.length - (LONGEST_QUERY - 1)); i < buf.length; i++) {
    if (buf.charCodeAt(i) !== 0x1b) continue
    const rest = buf.slice(i)
    if (QUERIES.some((q) => q.text.length > rest.length && q.text.startsWith(rest))) return i
  }
  return -1
}

// Where xterm.js 6.0.0's parser is, as far as a colour SET goes (EscapeSequenceParser.ts,
// OscParser.ts). ESC moves it to ESCAPE and U+009D starts an OSC from ANY state, so
// nothing else needs tracking.
const GROUND = 0
const ESCAPE = 1
const OSC_ID = 2
/** ESC or the 8-bit OSC introducer, the only characters that change what is tracked from GROUND. */
const INTRODUCER = /[\x1b\x9d]/g

/** A C0 control xterm.js drops inside an OSC string (IGNORE in OSC_STRING); BEL ends the string. */
function droppedInOsc(c: number): boolean {
  return (c <= 0x17 && c !== 0x07) || c === 0x19 || (c >= 0x1c && c <= 0x1f)
}
/** A character after which xterm.js stays in ESCAPE: a C0 control it runs there, or DEL, which it ignores. */
function staysInEscape(c: number): boolean {
  return c <= 0x17 || c === 0x19 || (c >= 0x1c && c <= 0x1f) || c === 0x7f
}

export interface ColorQueryResponder {
  /** One chunk of PTY output in; what goes on to the renderer out (each answered query replaced by ST). */
  filter(chunk: string): string
}

export function createColorQueryResponder(opts: {
  /** The colours to answer with, read when a query arrives; null leaves the query to xterm.js. */
  colors: () => ReplyColors | null
  /** Writes an answer into the session's PTY. */
  reply: (bytes: string) => void
}): ColorQueryResponder {
  let held = ''
  // An OSC xterm.js reads as 10 or 11 that is not one of the exact queries (a
  // colour SET, a two-slot query, any other form): from then on every query goes
  // to xterm.js.
  let leftToTerminal = false
  // The parser position, carried across chunks: an OSC id can be cut by a chunk end.
  let state = GROUND
  let oscId = -1
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
      for (let i = 0; i < body.length;) {
        if (state === GROUND) {
          INTRODUCER.lastIndex = i
          const next = INTRODUCER.exec(body)
          if (!next) break
          i = next.index
          if (body.charCodeAt(i) === 0x9d) { state = OSC_ID; oscId = -1; i++; continue }
          const query = QUERIES.find((q) => body.startsWith(q.text, i))
          if (!query) { state = ESCAPE; i++; continue }
          // An exact query: answered here when the colours are known, else left in place for
          // xterm.js. Either way it is a complete OSC, after which xterm.js is back in GROUND.
          if (colors === undefined) colors = opts.colors()
          if (colors) {
            out += body.slice(from, i) + ANSWERED_QUERY_STAND_IN
            from = i + query.text.length
            opts.reply(colorQueryReply(query.id, query.id === 10 ? colors.foreground : colors.background))
          }
          i += query.text.length
          continue
        }
        const c = body.charCodeAt(i)
        if (state === ESCAPE) {
          if (c === 0x5d) {
            state = OSC_ID
            oscId = -1
            i++
          } else if (c === 0x1b || c === 0x9d) {
            state = GROUND // read again from GROUND: a new escape, or an exact query
          } else if (staysInEscape(c)) {
            i++
          } else {
            state = GROUND
            i++
          }
          continue
        }
        // OSC_ID: digits up to `;` name the OSC (OscParser); any other character ends or abandons it.
        if (c >= 0x30 && c <= 0x39) {
          oscId = Math.min(12, (oscId < 0 ? 0 : oscId) * 10 + (c - 0x30))
          i++
        } else if (c === 0x3b) {
          if (oscId === 10 || oscId === 11) {
            leftToTerminal = true
            return out + body.slice(from) + tail
          }
          state = GROUND
          i++
        } else if (droppedInOsc(c)) i++
        else {
          state = GROUND
          if (c !== 0x1b && c !== 0x9d) i++
        }
      }
      held = tail
      return out + body.slice(from)
    },
  }
}
