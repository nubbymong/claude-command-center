import { create } from 'zustand'
import { saveConfigNow, saveConfigDebounced } from '../utils/config-saver'

export interface TerminalConfig {
  id: string
  label: string
  workingDirectory: string
  model: string
  color: string
  sessionType: 'local' | 'ssh'
  shellOnly?: boolean  // Don't run Claude, just open a shell
  groupId?: string     // Group this config belongs to
  sectionId?: string   // Section this config belongs to (only used when ungrouped)
  partnerTerminalPath?: string  // Optional partner shell terminal path
  partnerElevated?: boolean     // Run partner terminal as admin (requires gsudo)
  sshConfig?: {
    host: string
    port: number
    username: string
    remotePath: string
    hasPassword?: boolean
    postCommand?: string      // Command to run after SSH connects (e.g., docker exec)
    hasSudoPassword?: boolean // Whether sudo password is needed for postCommand
    startClaudeAfter?: boolean // Start Claude after post-command completes
    dockerContainer?: string  // Docker container name (enables docker cp for screenshots)
    // SSH connection flow:
    //   'manual' (default for SSH) — explicit user-gated stages. After SSH
    //     login a button overlay prompts the user to (1) run the post-connect
    //     command (if configured), then (2) inject statusline + launch
    //     Claude. Eliminates the auto-detection paste-leak class entirely.
    //   'auto' — legacy behaviour: state machine watches the PTY data
    //     stream for shell prompts and fires writes itself. Faster but
    //     occasionally lands setup blobs inside a running Claude on
    //     restore/restart paths. Kept for users who prefer hands-off.
    connectionFlow?: 'auto' | 'manual'
  }
  legacyVersion?: {
    enabled: boolean
    version: string
  }
  pinned?: boolean
  agentIds?: string[]  // Selected agent template IDs
  flickerFree?: boolean // Enable CLAUDE_CODE_NO_FLICKER=1 (alternate screen buffer rendering)
  powershellTool?: boolean // Enable CLAUDE_CODE_USE_POWERSHELL_TOOL=1 (native PowerShell tool)
  effortLevel?: 'low' | 'medium' | 'high' // Claude Code --effort flag
  disableAutoMemory?: boolean // Disable CLAUDE.md auto-memory writes
  machineName?: string // Identifies which machine this session runs on
}

export interface ConfigGroup {
  id: string
  name: string
  collapsed?: boolean
  sectionId?: string   // Section this group belongs to
}

export interface ConfigSection {
  id: string
  name: string
  collapsed?: boolean
}

interface ConfigState {
  configs: TerminalConfig[]
  groups: ConfigGroup[]
  sections: ConfigSection[]
  isLoaded: boolean
  hydrate: (configs: TerminalConfig[], groups: ConfigGroup[], sections: ConfigSection[]) => void
  addConfig: (config: TerminalConfig) => void
  updateConfig: (id: string, updates: Partial<TerminalConfig>) => void
  removeConfig: (id: string) => void
  addGroup: (group: ConfigGroup) => void
  renameGroup: (groupId: string, name: string) => void
  removeGroup: (groupId: string) => void
  toggleGroupCollapsed: (groupId: string) => void
  moveConfigToGroup: (configId: string, groupId: string | undefined) => void
  addSection: (section: ConfigSection) => void
  renameSection: (sectionId: string, name: string) => void
  removeSection: (sectionId: string) => void
  toggleSectionCollapsed: (sectionId: string) => void
  moveGroupToSection: (groupId: string, sectionId: string | undefined) => void
  moveConfigToSection: (configId: string, sectionId: string | undefined) => void
  togglePinned: (configId: string) => void
  duplicateConfig: (configId: string) => TerminalConfig | undefined
  reorderConfigs: (reordered: TerminalConfig[]) => void
}

export const useConfigStore = create<ConfigState>((set) => ({
  configs: [],
  groups: [],
  sections: [],
  isLoaded: false,

  hydrate: (configs, groups, sections) => set({ configs, groups, sections, isLoaded: true }),

  addConfig: (config) =>
    set((state) => {
      const configs = [...state.configs, config]
      saveConfigNow('configs', configs)
      return { configs }
    }),

  updateConfig: (id, updates) =>
    set((state) => {
      const configs = state.configs.map((c) => (c.id === id ? { ...c, ...updates } : c))
      saveConfigNow('configs', configs)
      return { configs }
    }),

  removeConfig: (id) =>
    set((state) => {
      const configs = state.configs.filter((c) => c.id !== id)
      saveConfigNow('configs', configs)
      return { configs }
    }),

  addGroup: (group) =>
    set((state) => {
      const groups = [...state.groups, group]
      saveConfigNow('configGroups', groups)
      return { groups }
    }),

  renameGroup: (groupId, name) =>
    set((state) => {
      const groups = state.groups.map((g) => (g.id === groupId ? { ...g, name } : g))
      saveConfigNow('configGroups', groups)
      return { groups }
    }),

  removeGroup: (groupId) =>
    set((state) => {
      // Ungroup all configs in this group
      const configs = state.configs.map((c) =>
        c.groupId === groupId ? { ...c, groupId: undefined } : c
      )
      const groups = state.groups.filter((g) => g.id !== groupId)
      saveConfigNow('configs', configs)
      saveConfigNow('configGroups', groups)
      return { configs, groups }
    }),

  toggleGroupCollapsed: (groupId) =>
    set((state) => {
      const groups = state.groups.map((g) =>
        g.id === groupId ? { ...g, collapsed: !g.collapsed } : g
      )
      saveConfigDebounced('configGroups', groups)
      return { groups }
    }),

  moveConfigToGroup: (configId, groupId) =>
    set((state) => {
      const configs = state.configs.map((c) =>
        c.id === configId ? { ...c, groupId } : c
      )
      saveConfigNow('configs', configs)
      return { configs }
    }),

  addSection: (section) =>
    set((state) => {
      const sections = [...state.sections, section]
      saveConfigNow('configSections', sections)
      return { sections }
    }),

  renameSection: (sectionId, name) =>
    set((state) => {
      const sections = state.sections.map((s) => (s.id === sectionId ? { ...s, name } : s))
      saveConfigNow('configSections', sections)
      return { sections }
    }),

  removeSection: (sectionId) =>
    set((state) => {
      // Unset sectionId on all groups and configs in this section
      const groups = state.groups.map((g) =>
        g.sectionId === sectionId ? { ...g, sectionId: undefined } : g
      )
      const configs = state.configs.map((c) =>
        c.sectionId === sectionId ? { ...c, sectionId: undefined } : c
      )
      const sections = state.sections.filter((s) => s.id !== sectionId)
      saveConfigNow('configGroups', groups)
      saveConfigNow('configs', configs)
      saveConfigNow('configSections', sections)
      return { groups, configs, sections }
    }),

  toggleSectionCollapsed: (sectionId) =>
    set((state) => {
      const sections = state.sections.map((s) =>
        s.id === sectionId ? { ...s, collapsed: !s.collapsed } : s
      )
      saveConfigDebounced('configSections', sections)
      return { sections }
    }),

  moveGroupToSection: (groupId, sectionId) =>
    set((state) => {
      const groups = state.groups.map((g) =>
        g.id === groupId ? { ...g, sectionId } : g
      )
      saveConfigNow('configGroups', groups)
      return { groups }
    }),

  moveConfigToSection: (configId, sectionId) =>
    set((state) => {
      const configs = state.configs.map((c) =>
        c.id === configId ? { ...c, sectionId } : c
      )
      saveConfigNow('configs', configs)
      return { configs }
    }),

  togglePinned: (configId) =>
    set((state) => {
      const configs = state.configs.map((c) =>
        c.id === configId ? { ...c, pinned: !c.pinned } : c
      )
      saveConfigNow('configs', configs)
      return { configs }
    }),

  reorderConfigs: (reordered) =>
    set(() => {
      saveConfigNow('configs', reordered)
      return { configs: reordered }
    }),

  duplicateConfig: (configId) => {
    const state = useConfigStore.getState()
    const original = state.configs.find((c) => c.id === configId)
    if (!original) return undefined
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
    const copy: TerminalConfig = {
      ...original,
      id,
      label: original.label + ' (copy)',
      pinned: undefined,
    }
    const configs = [...state.configs, copy]
    saveConfigNow('configs', configs)
    useConfigStore.setState({ configs })
    return copy
  }
}))
