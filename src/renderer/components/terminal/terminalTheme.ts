import type { ITheme } from '@xterm/xterm'

export const DARK_THEME: ITheme = {
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

export const LIGHT_THEME: ITheme = {
  background: '#ffffff',
  foreground: '#1a1a1a',
  cursor: '#1a1a1a',
  cursorAccent: '#ffffff',
  selectionBackground: '#d4d4d4',
  selectionForeground: '#1a1a1a',
  black: '#1a1a1a',
  red: '#dc2626',
  green: '#16a34a',
  yellow: '#ca8a04',
  blue: '#2563eb',
  magenta: '#7c3aed',
  cyan: '#0d9488',
  white: '#e8e8e8',
  brightBlack: '#555555',
  brightRed: '#dc2626',
  brightGreen: '#16a34a',
  brightYellow: '#ca8a04',
  brightBlue: '#2563eb',
  brightMagenta: '#7c3aed',
  brightCyan: '#0d9488',
  brightWhite: '#1a1a1a',
}

// Default export for backwards compatibility
export const THEME = DARK_THEME

export function getTerminalTheme(isDark: boolean): ITheme {
  return isDark ? DARK_THEME : LIGHT_THEME
}

// Inject CSS to hide xterm's cursor layer completely
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

injectGlobalStyles()
