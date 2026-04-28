import { create } from 'zustand'
import { saveConfigNow } from '../utils/config-saver'
import { DEFAULT_SHORTCUTS } from '../utils/shortcuts'

export type StatusLineFont = 'sans' | 'mono'

export interface StatusLineSettings {
  showModel: boolean
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
  lineHeight: number
  cursorStyle: CursorStyle
  cursorBlink: boolean
}

export const DEFAULT_TERMINAL_SETTINGS: TerminalSettings = {
  fontFamily: 'Cascadia Code',
  fontSize: 14,
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
  terminalFontSize: 14,
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
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: { ...DEFAULT_SETTINGS },
  isLoaded: false,

  hydrate: (settings) => set({
    settings: {
      ...DEFAULT_SETTINGS,
      ...settings,
      // Deep-merge nested objects so users with older saved configs still pick up
      // newly added fields (e.g. statusLine.font/fontSize) instead of getting undefined.
      statusLine: { ...DEFAULT_STATUS_LINE, ...(settings.statusLine || {}) },
      terminal: { ...DEFAULT_TERMINAL_SETTINGS, ...(settings.terminal || {}) },
    },
    isLoaded: true,
  }),

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
