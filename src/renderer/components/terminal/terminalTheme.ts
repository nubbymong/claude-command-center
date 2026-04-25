// xterm theme is now derived from the live CSS palette so light/dark
// mode flips both the React UI and the terminal contents in lockstep.
// Hex literals are kept as the dark-mode fallback for the rare case
// where computed styles aren't available (e.g. unit tests under jsdom
// without our `:root` block applied).
const FALLBACK_DARK = {
  background: '#1a1a1a',
  foreground: '#e8e8e8',
  surface1: '#2a2a2a',
  surface2: '#333333',
  red: '#e55c5c',
  green: '#5cb85c',
  yellow: '#e8a84e',
  blue: '#6ea8fe',
  magenta: '#a78bfa',
  cyan: '#5bbfb5',
  white: '#cccccc',
  brightBlack: '#555555',
}

function readVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
    return v || fallback
  } catch {
    return fallback
  }
}

export function getTerminalTheme() {
  return {
    background: readVar('--color-base', FALLBACK_DARK.background),
    foreground: readVar('--color-text', FALLBACK_DARK.foreground),
    cursor: readVar('--color-text', FALLBACK_DARK.foreground),
    cursorAccent: readVar('--color-base', FALLBACK_DARK.background),
    selectionBackground: readVar('--color-surface2', FALLBACK_DARK.surface2),
    selectionForeground: readVar('--color-text', FALLBACK_DARK.foreground),
    black: readVar('--color-surface0', FALLBACK_DARK.surface1),
    red: readVar('--color-red', FALLBACK_DARK.red),
    green: readVar('--color-green', FALLBACK_DARK.green),
    yellow: readVar('--color-yellow', FALLBACK_DARK.yellow),
    blue: readVar('--color-blue', FALLBACK_DARK.blue),
    magenta: readVar('--color-mauve', FALLBACK_DARK.magenta),
    cyan: readVar('--color-teal', FALLBACK_DARK.cyan),
    white: readVar('--color-subtext1', FALLBACK_DARK.white),
    brightBlack: readVar('--color-overlay0', FALLBACK_DARK.brightBlack),
    brightRed: readVar('--color-red', FALLBACK_DARK.red),
    brightGreen: readVar('--color-green', FALLBACK_DARK.green),
    brightYellow: readVar('--color-yellow', FALLBACK_DARK.yellow),
    brightBlue: readVar('--color-blue', FALLBACK_DARK.blue),
    brightMagenta: readVar('--color-mauve', FALLBACK_DARK.magenta),
    brightCyan: readVar('--color-teal', FALLBACK_DARK.cyan),
    brightWhite: readVar('--color-text', FALLBACK_DARK.foreground),
  }
}

// Backwards-compatible export for code that still imports a static THEME.
// Computed once at module load using current document state. Components
// that need to react to theme flips should call getTerminalTheme()
// each time they re-render.
export const THEME = getTerminalTheme()

// Hide every xterm-rendered cursor surface. The cursor-layer canvas was
// the only target the previous selector hit, but Claude's TUI moves the
// cursor across glyphs during the "thinking" spinner faster than our
// per-write `\x1b[?25l` can suppress, and xterm renders the cursor as a
// styled span on the focused row when the canvas layer is masked. Match
// every variant: the canvas layer, the focused-row cursor span, any
// element whose class contains "cursor", and force `caret-color:
// transparent` on the root so the focus ring on inactive panes stays
// invisible too.
const GLOBAL_STYLES_ID = 'claude-multi-terminal-styles'
export function injectGlobalStyles() {
  if (document.getElementById(GLOBAL_STYLES_ID)) return
  const style = document.createElement('style')
  style.id = GLOBAL_STYLES_ID
  style.textContent = `
    .xterm-cursor-layer,
    .xterm-cursor,
    .xterm-helper-textarea {
      display: none !important;
      visibility: hidden !important;
      opacity: 0 !important;
    }
    .xterm,
    .xterm-screen {
      caret-color: transparent !important;
    }
    /* xterm renders the focused-row cursor as inline spans with these
       classes on the text layer when the cursor canvas is masked.
       Catch every flavour. */
    .xterm-screen [class*="cursor"] {
      background: transparent !important;
      color: inherit !important;
      border: 0 !important;
      outline: 0 !important;
    }
  `
  document.head.appendChild(style)
}

// Auto-inject on import
injectGlobalStyles()
