// Platform v9 dark theme
export const THEME = {
  background: '#0f1218',
  foreground: '#f0f4fc',
  cursor: '#f0f4fc',
  cursorAccent: '#0f1218',
  selectionBackground: '#1e2530',
  selectionForeground: '#f0f4fc',
  black: '#1e2530',
  red: '#F38BA8',
  green: '#A6E3A1',
  yellow: '#F9E2AF',
  blue: '#89B4FA',
  magenta: '#CBA6F7',
  cyan: '#94E2D5',
  white: '#b8c5d6',
  brightBlack: '#2a3342',
  brightRed: '#F38BA8',
  brightGreen: '#A6E3A1',
  brightYellow: '#F9E2AF',
  brightBlue: '#89B4FA',
  brightMagenta: '#CBA6F7',
  brightCyan: '#94E2D5',
  brightWhite: '#94a3b8',
}

// Inject CSS to hide xterm's cursor layer completely (we use input bar for typing)
const GLOBAL_STYLES_ID = 'claude-multi-terminal-styles'
export function injectGlobalStyles() {
  if (document.getElementById(GLOBAL_STYLES_ID)) return
  const style = document.createElement('style')
  style.id = GLOBAL_STYLES_ID
  style.textContent = `
    .xterm-cursor-layer {
      display: none !important;
    }
  `
  document.head.appendChild(style)
}

// Auto-inject on import
injectGlobalStyles()
