import { create } from 'zustand'
import { saveConfigNow } from '../utils/config-saver'
import { DEFAULT_SHORTCUTS } from '../utils/shortcuts'

export type StatusLineFont = 'sans' | 'mono'

export interface StatusLineSettings {
  showModel: boolean
  showEffort: boolean
  showAccount: boolean
  showTokens: boolean
  showContextBar: boolean
  showCost: boolean
  showLinesChanged: boolean
  showDuration: boolean
  showRateLimits: boolean
  showResetTime: boolean
  font: StatusLineFont
  fontSize: number
}

export const DEFAULT_STATUS_LINE: StatusLineSettings = {
  showModel: true,
  showEffort: true,
  showAccount: true,
  showTokens: true,
  showContextBar: true,
  showCost: true,
  showLinesChanged: true,
  showDuration: true,
  showRateLimits: true,
  showResetTime: true,
  font: 'sans',
  fontSize: 12
}

export type UpdateChannel = 'stable' | 'beta'

// 'system' follows the OS prefers-color-scheme; explicit 'dark' / 'light'
// overrides regardless of OS. Default is 'dark' so existing users see no
// visual change unless they opt in.
export type ThemeMode = 'dark' | 'light' | 'system'

export type CursorStyle = 'bar' | 'block' | 'underline'

export interface TerminalSettings {
  fontFamily: string
  fontSize: number
  fontWeight: number
  lineHeight: number
  cursorStyle: CursorStyle
  cursorBlink: boolean
  background?: string   // optional user terminal-background override; undefined => --surface-stage token
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontFamily: 'JetBrains Mono',
  fontSize: 13,
  fontWeight: 450,
  lineHeight: 1.2,
  cursorStyle: 'bar',
  cursorBlink: false,
}

export interface AppSettings {
  defaultModel: string
  defaultWorkingDirectory: string
  terminalFontSize: number
  terminal: TerminalSettings
  debugMode: boolean
  keyboardShortcuts: Record<string, string>
  inputBarMaxHeight: number
  configPanelPinned: boolean
  statusLine: StatusLineSettings
  localMachineName: string
  updateChannel: UpdateChannel
  skipPermissionsForAgents: boolean
  showTips: boolean
  hooksEnabled: boolean
  hooksPort: number
  theme: ThemeMode
  tokenomicsAccountFilter?: string  // 'all' | '__mixed__' | '__unknown__' | <email>
  fontMigratedV2?: boolean  // one-time guard: existing installs moved off the old Cascadia Code/14 default
  identityColorMigratedV2?: boolean      // one-time guard: saved-config colours migrated to identity keys
  colourMigrationNoticePending?: boolean // a colour migration changed records and the notice should show
  colourMigrationNoticeDismissed?: boolean
  /** User-defined per-account email -> identity colour key overrides. Keyed by
   *  canonicalised (lowercase+trim) email. Absent = use the deterministic colour.
   *  v1.5.9: no longer surfaced anywhere in the UI (AccountColoursSection removed).
   *  Retained so older saved settings still hydrate without errors. */
  accountColourOverrides?: Record<string, import('../../shared/identity-colors').IdentityColorKey>
  /** v1.5.19: friendly names for accounts WITHOUT a profile (the default/single
   *  account), keyed by canonical email. Profiles carry their own `name`. */
  accountAliases?: Record<string, string>
  /** v1.5.12: when true, CCC writes `disableWorkflows: true` into every
   *  per-session Claude settings file so Claude Code's dynamic-workflow
   *  feature is disabled at session boot. Affects newly spawned sessions
   *  only -- in-flight sessions keep whatever setting they started with.
   *  Off by default; CC's own /config toggle still wins per-session. */
  disableClaudeWorkflows?: boolean
  /** v1.5.31: record each session's terminal output locally for search and
   *  review. Logs never leave the machine. Default on; set false to disable
   *  capture. The main process capture gate reads this key from the shared
   *  settings config (readConfig('settings').loggingEnabled). */
  loggingEnabled?: boolean
  /** v1.5.31: one-time first-run consent notice has been shown. Falsy = show
   *  the notice on the next boot so the user can opt out before any data is
   *  written. Set true (with or without disabling logging) to suppress the
   *  prompt permanently. */
  loggingConsentSeen?: boolean
  /** True once the legacy file logs have been imported into SQLite (Phase 2b). */
  legacyLogsMigrated?: boolean
  /** True once the one-time "legacy logs detected" surfacing has been shown. */
  legacyLogsSurfacingSeen?: boolean
  /** v1.5.32: when true (or absent = default), CLAUDE_CODE_DISABLE_MOUSE=1 is set
   *  in the Claude spawn env so xterm owns the mouse and classic terminal selection
   *  + right-click copy/paste work. Right-click copies selected text or pastes when
   *  nothing is selected. Trade-off: CC's click-to-expand / click-to-position /
   *  scroll-inside-Claude are disabled; xterm scrollback + native selection take over.
   *  Set false to restore CC's mouse mode (copy-on-select active; right-click pastes).
   *  Changes apply to newly-launched sessions only. */
  classicTerminalCopyPaste?: boolean
  /** Sentinel service (spec 2026-06-11): when false, the Sentinel service is not
   *  initialised at all — no startup check, no dot, zero overhead.
   *  Absent or true = enabled (default-on). */
  sentinelEnabled?: boolean
  /** When true (default), the Sentinel panel auto-opens once when a completed
   *  analysis finds open findings. Set false to suppress all automatic opens. */
  sentinelAutoOpen?: boolean
  /** Account profile Sentinel's headless analysis runs under. null/absent =
   *  the captured primary (never the bare global login when profiles exist —
   *  the frozen global hangs at auth or carries stale usage limits). Switchable
   *  in Settings when the chosen account hits its usage limit. */
  sentinelAccountProfileId?: string | null
}

interface SettingsState {
  settings: AppSettings
  isLoaded: boolean
  hydrate: (settings: AppSettings) => void
  updateSettings: (updates: Partial<AppSettings>) => Promise<unknown>
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultModel: 'sonnet',
  defaultWorkingDirectory: '',
  terminalFontSize: 13,
  terminal: { ...DEFAULT_TERMINAL_SETTINGS },
  debugMode: false,
  keyboardShortcuts: { ...DEFAULT_SHORTCUTS },
  inputBarMaxHeight: 400,
  configPanelPinned: false,
  statusLine: { ...DEFAULT_STATUS_LINE },
  localMachineName: '',
  updateChannel: 'stable' as const,
  skipPermissionsForAgents: true,
  showTips: true,
  hooksEnabled: true,
  hooksPort: 19334,
  theme: 'dark',
  loggingEnabled: true,
  classicTerminalCopyPaste: true,
  sentinelEnabled: true,
  sentinelAutoOpen: true,
}

// V2 changed the bundled terminal default from Cascadia Code @14 to JetBrains
// Mono @13. Move installs still sitting on the OLD default to the new one
// exactly ONCE, guarded by fontMigratedV2. A user who picked a different font is
// left alone; a user who re-picks Cascadia Code after the migration is respected
// (the guard has already fired). `changed` is true whenever the guard is newly
// set, so the caller persists it and the migration never runs again.
export function migrateV2Font(settings: AppSettings): { settings: AppSettings; changed: boolean } {
  if (settings.fontMigratedV2) return { settings, changed: false }
  const terminal = { ...settings.terminal }
  if (terminal.fontFamily === 'Cascadia Code') terminal.fontFamily = 'JetBrains Mono'
  if (terminal.fontSize === 14) terminal.fontSize = 13
  return {
    settings: {
      ...settings,
      terminal,
      terminalFontSize: settings.terminalFontSize === 14 ? 13 : settings.terminalFontSize,
      fontMigratedV2: true,
    },
    changed: true,
  }
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: { ...DEFAULT_SETTINGS },
  isLoaded: false,

  hydrate: (settings) => {
    const merged: AppSettings = {
      ...DEFAULT_SETTINGS,
      ...settings,
      // Deep-merge nested objects so users with older saved configs still pick up
      // newly added fields (e.g. statusLine.font/fontSize) instead of getting undefined.
      statusLine: { ...DEFAULT_STATUS_LINE, ...(settings.statusLine || {}) },
      terminal: { ...DEFAULT_TERMINAL_SETTINGS, ...(settings.terminal || {}) },
    }
    const { settings: migrated, changed } = migrateV2Font(merged)
    if (changed) {
      // Persist the one-time migration (including the guard flag) so it runs once.
      saveConfigNow('settings', migrated).catch(() => {})
    }
    set({ settings: migrated, isLoaded: true })
  },

  updateSettings: (updates) => {
    let savePromise: Promise<unknown> = Promise.resolve()
    set((state) => {
      const settings = { ...state.settings, ...updates }
      savePromise = saveConfigNow('settings', settings)
      return { settings }
    })
    return savePromise
  }
}))
