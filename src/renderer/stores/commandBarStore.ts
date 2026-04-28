import { create } from 'zustand'
import { saveConfigDebounced } from '../utils/config-saver'

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
      state: {
        ...DEFAULTS,
        ...next,
        // Defend against a hand-edited / corrupted commandBarUi.json
        // where collapsedSectionIds came back as a string or null.
        // toggleSection calls .filter on it, which would throw.
        collapsedSectionIds: Array.isArray(next.collapsedSectionIds)
          ? next.collapsedSectionIds
          : [],
      },
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
      // Debounced — rapid expand/collapse spam shouldn't write to
      // disk on every click. config-saver coalesces successive calls
      // within 300 ms.
      saveConfigDebounced('commandBarUi', nextState)
      return { state: nextState }
    }),
}))
