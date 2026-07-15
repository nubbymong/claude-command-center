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
  // Whole-bar collapse -- when true the CommandBar renders only its slim
  // toggle row and hides the command rows. Shared (like collapsedSectionIds)
  // so the Claude and Partner CommandBar instances within one config agree,
  // and persisted so the choice survives restarts. Defaults to false
  // (expanded) to avoid surprising existing users on upgrade.
  barCollapsed: boolean
}

interface CommandBarStore {
  state: CommandBarUiState
  isLoaded: boolean
  hydrate: (state: Partial<CommandBarUiState>) => void
  isCollapsed: (sectionId: string) => boolean
  toggleSection: (sectionId: string) => void
  toggleBar: () => void
  setBarCollapsed: (value: boolean) => void
}

const DEFAULTS: CommandBarUiState = {
  collapsedSectionIds: [],
  barCollapsed: false,
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
        // Defend against a corrupted commandBarUi.json where barCollapsed
        // came back as a non-boolean; default to expanded.
        barCollapsed: typeof next.barCollapsed === 'boolean' ? next.barCollapsed : false,
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

  toggleBar: () =>
    set((s) => {
      const nextState = { ...s.state, barCollapsed: !s.state.barCollapsed }
      saveConfigDebounced('commandBarUi', nextState)
      return { state: nextState }
    }),

  setBarCollapsed: (value) =>
    set((s) => {
      if (s.state.barCollapsed === value) return s
      const nextState = { ...s.state, barCollapsed: value }
      saveConfigDebounced('commandBarUi', nextState)
      return { state: nextState }
    }),
}))
