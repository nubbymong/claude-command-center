import { create } from 'zustand'
import { saveConfigNow } from '../utils/config-saver'

// Section collapse state lives outside CommandBar's local useState so the
// Claude and Partner terminals (separate TerminalView + CommandBar instances
// per session) share the same view of which sections are collapsed.
// Previously each instance had its own Set and toggling on one side was
// invisible to the other — bug report: "if I collapse sections in a config
// then move to that config's partner terminal the collapse setting isn't
// persisted; if I go back to claude it is".
//
// Persisted to disk so collapse state survives app restarts.

export interface CommandBarUiState {
  collapsedSectionIds: string[]
}

interface CommandBarStore {
  state: CommandBarUiState
  isLoaded: boolean
  hydrate: (state: Partial<CommandBarUiState>) => void
  isCollapsed: (sectionId: string) => boolean
  toggleSection: (sectionId: string) => void
}

const DEFAULTS: CommandBarUiState = {
  collapsedSectionIds: [],
}

export const useCommandBarStore = create<CommandBarStore>((set, get) => ({
  state: { ...DEFAULTS },
  isLoaded: false,

  hydrate: (next) =>
    set({
      state: { ...DEFAULTS, ...next, collapsedSectionIds: next.collapsedSectionIds ?? [] },
      isLoaded: true,
    }),

  isCollapsed: (sectionId) => get().state.collapsedSectionIds.includes(sectionId),

  toggleSection: (sectionId) =>
    set((s) => {
      const current = s.state.collapsedSectionIds
      const has = current.includes(sectionId)
      const collapsedSectionIds = has
        ? current.filter((id) => id !== sectionId)
        : [...current, sectionId]
      const nextState = { ...s.state, collapsedSectionIds }
      saveConfigNow('commandBarUi', nextState)
      return { state: nextState }
    }),
}))
