import { create } from 'zustand'
import { saveConfigNow } from '../utils/config-saver'

export interface MagicButtonSettings {
  screenshotColor: string
  autoDeleteDays: number | null
}

interface MagicButtonState {
  settings: MagicButtonSettings
  isLoaded: boolean
  hydrate: (settings: MagicButtonSettings) => void
  updateSettings: (updates: Partial<MagicButtonSettings>) => void
}

export const MAGIC_BUTTON_DEFAULTS: MagicButtonSettings = {
  screenshotColor: '#00FFFF',
  autoDeleteDays: null
}

export const useMagicButtonStore = create<MagicButtonState>((set) => ({
  settings: { ...MAGIC_BUTTON_DEFAULTS },
  isLoaded: false,

  hydrate: (settings) => set({ settings: { ...MAGIC_BUTTON_DEFAULTS, ...settings }, isLoaded: true }),

  updateSettings: (updates) =>
    set((state) => {
      const settings = { ...state.settings, ...updates }
      saveConfigNow('magicButtons', settings)
      return { settings }
    })
}))
