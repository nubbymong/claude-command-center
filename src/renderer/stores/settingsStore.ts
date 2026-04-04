import { create } from 'zustand'
import { saveConfigNow } from '../utils/config-saver'
import { DEFAULT_SHORTCUTS } from '../utils/shortcuts'

export interface StatusLineSettings {
  showModel: boolean
  showTokens: boolean
  showContextBar: boolean
  showCost: boolean
  showLinesChanged: boolean
  showDuration: boolean
  showRateLimits: boolean
  showResetTime: boolean
}

export const DEFAULT_STATUS_LINE: StatusLineSettings = {
  showModel: true,
  showTokens: true,
  showContextBar: true,
  showCost: true,
  showLinesChanged: true,
  showDuration: true,
  showRateLimits: true,
  showResetTime: true
}

export interface AppSettings {
  defaultModel: string
  defaultWorkingDirectory: string
  terminalFontSize: number
  debugMode: boolean
  keyboardShortcuts: Record<string, string>
  inputBarMaxHeight: number
  configPanelPinned: boolean
  statusLine: StatusLineSettings
  localMachineName: string
  updateChannel: 'stable' | 'beta'
  skipPermissionsForAgents: boolean
}

interface SettingsState {
  settings: AppSettings
  isLoaded: boolean
  hydrate: (settings: AppSettings) => void
  updateSettings: (updates: Partial<AppSettings>) => void
}

export const DEFAULT_SETTINGS: AppSettings = {
  defaultModel: 'sonnet',
  defaultWorkingDirectory: '',
  terminalFontSize: 14,
  debugMode: false,
  keyboardShortcuts: { ...DEFAULT_SHORTCUTS },
  inputBarMaxHeight: 400,
  configPanelPinned: false,
  statusLine: { ...DEFAULT_STATUS_LINE },
  localMachineName: '',
  updateChannel: 'stable' as const,
  skipPermissionsForAgents: true
}

export const useSettingsStore = create<SettingsState>((set) => ({
  settings: { ...DEFAULT_SETTINGS },
  isLoaded: false,

  hydrate: (settings) => set({ settings: { ...DEFAULT_SETTINGS, ...settings }, isLoaded: true }),

  updateSettings: (updates) =>
    set((state) => {
      const settings = { ...state.settings, ...updates }
      saveConfigNow('settings', settings)
      return { settings }
    })
}))
