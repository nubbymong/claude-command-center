/**
 * The terminal's default foreground and background in each app theme: the
 * colours main answers a Codex session's OSC 10/11 colour query with
 * (main/terminal-query-responder.ts, both pairs). The dark pair alone is also
 * the renderer's fallback when no CSS is applied (terminalTheme.ts); only main
 * reads the light pair from here. The live terminal takes them from styles.css
 * (`--terminal-foreground`, `--surface-stage`, read by getTerminalTheme, which
 * tests/unit/renderer/terminal-theme.test.ts pins), so
 * tests/unit/main/terminal-query-responder.test.ts holds styles.css to these
 * values: what main answers is what the terminal shows.
 */
export type TerminalColorScheme = 'dark' | 'light'

export interface TerminalDefaultColors {
  /** `#rrggbb`, lower case. */
  foreground: string
  /** `#rrggbb`, lower case. */
  background: string
}

export const TERMINAL_DEFAULT_COLORS: Readonly<Record<TerminalColorScheme, Readonly<TerminalDefaultColors>>> = Object.freeze({
  dark: Object.freeze({ foreground: '#eef2f7', background: '#171e27' }),
  light: Object.freeze({ foreground: '#11161f', background: '#e8ecf3' }),
})
