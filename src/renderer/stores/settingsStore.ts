import { create } from 'zustand'
import { saveConfigNow } from '../utils/config-saver'
import { DEFAULT_SHORTCUTS } from '../utils/shortcuts'

export interface AppSettings {
  defaultModel: string
  defaultWorkingDirectory: string
  terminalFontSize: number
  debugMode: boolean
  compactionInterruptThreshold: number  // Context % at which to auto-Escape (default 80)
  keyboardShortcuts: Record<string, string>
  inputBarMaxHeight: number
  configPanelPinned: boolean
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
  compactionInterruptThreshold: 80,
  keyboardShortcuts: { ...DEFAULT_SHORTCUTS },
  inputBarMaxHeight: 400,
  configPanelPinned: false
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
