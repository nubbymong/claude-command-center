// Warm neutral dark theme
export const THEME = {
  background: '#1a1a1a',
  foreground: '#e8e8e8',
  cursor: '#e8e8e8',
  cursorAccent: '#1a1a1a',
  selectionBackground: '#333333',
  selectionForeground: '#e8e8e8',
  black: '#222222',
  red: '#e55c5c',
  green: '#5cb85c',
  yellow: '#e8a84e',
  blue: '#6ea8fe',
  magenta: '#a78bfa',
  cyan: '#5bbfb5',
  white: '#cccccc',
  brightBlack: '#555555',
  brightRed: '#e55c5c',
  brightGreen: '#5cb85c',
  brightYellow: '#e8a84e',
  brightBlue: '#6ea8fe',
  brightMagenta: '#a78bfa',
  brightCyan: '#5bbfb5',
  brightWhite: '#e8e8e8',
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
