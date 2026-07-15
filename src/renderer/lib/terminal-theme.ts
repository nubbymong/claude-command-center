// src/renderer/lib/terminal-theme.ts
//
// Shared xterm terminal theme built from the app's semantic CSS variables
// (Catppuccin / V2 tokens). Relocated here from the now-deleted log-replay
// component so it has a stable home independent of the logs UI. Consumed by
// SetupDialog (the CLI-setup terminal) and any other read-only terminal surface.

function readVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** Semantic-token xterm theme. Reads live CSS vars so it tracks the active theme. */
export function buildLogTheme() {
  return {
    background:          readVar('--surface-stage', '#0f1218'),
    foreground:          readVar('--terminal-foreground', '#b8c5d6'),
    cursor:              readVar('--text-primary', '#F5E0DC'),
    cursorAccent:        readVar('--surface-stage', '#0f1218'),
    selectionBackground: readVar('--surface-overlay', '#2a3342'),
    selectionForeground: readVar('--text-primary', '#f0f4fc'),
    black:        readVar('--surface-overlay', '#2a3342'),
    red:          readVar('--status-danger', '#F38BA8'),
    green:        readVar('--status-success', '#A6E3A1'),
    yellow:       readVar('--status-warning', '#F9E2AF'),
    blue:         readVar('--status-info', '#89B4FA'),
    magenta:      readVar('--chart-other', '#CBA6F7'),
    cyan:         readVar('--accent', '#94E2D5'),
    white:        readVar('--text-secondary', '#b8c5d6'),
    brightBlack:  readVar('--text-muted', '#4a5568'),
    brightRed:    readVar('--status-danger', '#F38BA8'),
    brightGreen:  readVar('--status-success', '#A6E3A1'),
    brightYellow: readVar('--status-warning', '#F9E2AF'),
    brightBlue:   readVar('--status-info', '#89B4FA'),
    brightMagenta:readVar('--chart-other', '#CBA6F7'),
    brightCyan:   readVar('--accent', '#94E2D5'),
    brightWhite:  readVar('--text-primary', '#f0f4fc'),
  }
}
