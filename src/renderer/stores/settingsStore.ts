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
  /** v1.5.17: show the genuine-only permission tray (cards for prompts Claude is
   *  blocked on). Default on; set false to hide the tray and skip capture. */
  permissionTrayEnabled?: boolean
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
  permissionTrayEnabled: true,
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
