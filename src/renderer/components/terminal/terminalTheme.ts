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

// Cursor visibility for `.claude-session` panes — xterm's DOM
// renderer creates the cursor as a positioned `<div class="xterm-cursor
// xterm-cursor-bar">` (or -block/-underline/-outline) inside .xterm-screen.
// During Claude's thinking animation the cursor is repositioned at the
// "end of last write" of every redrawn region, which is what the user
// has been seeing as a rogue yellow square jumping around the screen.
// We nuke every conceivable cursor variant with a wide net of !important
// declarations because:
//   * xterm sets the cursor colour via the `--cursor-color` CSS var
//     (and may override at runtime if the TUI sends an OSC 12)
//   * xterm may toggle inline styles on the cursor element across
//     focus / animation frames
//   * we don't want to depend on which specific modifier class is
//     active in any given xterm release
//
// `caret-color: transparent` on the helper-textarea stays
// unconditional — that textarea is xterm's offscreen keyboard input
// capture (must remain focusable), but its blinking browser caret
// would otherwise show through.
const GLOBAL_STYLES_ID = 'claude-multi-terminal-styles'
const STYLE_TEXT = `
  .xterm,
  .xterm-screen,
  .xterm-helper-textarea {
    caret-color: transparent !important;
  }

  /* THE WINDOWS-ONLY ROGUE-RECTANGLE FIX.
     xterm repositions a real <textarea class="xterm-helper-textarea">
     to the cursor position on every cursor move (so IME composition
     works). When the terminal has focus, that textarea has focus,
     and Chromium on Windows draws a yellow rounded focus outline
     around it — which looks like a rogue caret jumping with the
     cursor as Claude's TUI repaints during animations. macOS draws
     a different (invisible-against-dark-bg) outline. Killing every
     browser-drawn chrome on this textarea makes the artifact go
     away on Windows and stays a no-op on macOS. */
  .xterm-helper-textarea,
  .xterm-helper-textarea:focus,
  .xterm-helper-textarea:focus-visible,
  .xterm-helper-textarea:active {
    outline: none !important;
    outline-color: transparent !important;
    border: 0 !important;
    background: transparent !important;
    background-color: transparent !important;
    box-shadow: none !important;
    -webkit-appearance: none !important;
    appearance: none !important;
    color: transparent !important;
  }

  /* Full-nuke for the xterm cursor in Claude sessions. Covers DOM
     renderer (.xterm-cursor + modifier classes), canvas renderer
     (.xterm-cursor-layer canvas) and any future variant whose
     class contains "xterm-cursor". */
  .claude-session .xterm-cursor,
  .claude-session .xterm-cursor-blink,
  .claude-session .xterm-cursor-bar,
  .claude-session .xterm-cursor-block,
  .claude-session .xterm-cursor-underline,
  .claude-session .xterm-cursor-outline,
  .claude-session .xterm-cursor-pointer,
  .claude-session .xterm-cursor-layer,
  .claude-session [class*="xterm-cursor"] {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    width: 0 !important;
    height: 0 !important;
    min-width: 0 !important;
    min-height: 0 !important;
    background: transparent !important;
    background-color: transparent !important;
    color: transparent !important;
    border: 0 !important;
    outline: 0 !important;
    box-shadow: none !important;
    pointer-events: none !important;
    transform: scale(0) !important;
  }

  /* xterm DOM renderer reads its cursor colour from a CSS var; force
     it transparent at the .claude-session level so even if the
     element happens to render, it draws nothing. Belt + braces. */
  .claude-session {
    --cursor-color: transparent !important;
    --xterm-cursor-color: transparent !important;
  }
`
export function injectGlobalStyles() {
  let style = document.getElementById(GLOBAL_STYLES_ID) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = GLOBAL_STYLES_ID
    document.head.appendChild(style)
  }
  // Always refresh the textContent — under HMR / repeat module
  // imports, an early-return on element-exists would lock stale CSS
  // into place and silently block updates.
  style.textContent = STYLE_TEXT
}

// Auto-inject on import
injectGlobalStyles()
