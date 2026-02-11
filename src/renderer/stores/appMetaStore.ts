import { create } from 'zustand'
import { saveConfigNow } from '../utils/config-saver'

export interface AppMeta {
  setupVersion?: string
  lastSeenVersion?: string
  commandsSeeded?: boolean
  colorMigrated?: boolean
}

interface AppMetaState {
  meta: AppMeta
  isLoaded: boolean
  hydrate: (meta: AppMeta) => void
  update: (updates: Partial<AppMeta>) => void
}

export const useAppMetaStore = create<AppMetaState>((set, get) => ({
  meta: {},
  isLoaded: false,

  hydrate: (meta) => set({ meta, isLoaded: true }),

  update: (updates) =>
    set((state) => {
      const meta = { ...state.meta, ...updates }
      saveConfigNow('appMeta', meta)
      return { meta }
    })
}))
