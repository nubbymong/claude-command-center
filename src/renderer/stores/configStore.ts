import { create } from 'zustand'
import { saveConfigNow, saveConfigDebounced } from '../utils/config-saver'
import type { ProviderId, ClaudeOptions, CodexOptions, TerminalOptions, SshRuntime } from '../../shared/types'
import type { IdentityColorKey } from '../../shared/identity-colors'
import { generateId } from '../utils/id'

// Re-export provider types so callers can import from a single place
export type { ProviderId, ClaudeOptions, CodexOptions, TerminalOptions }

export interface TerminalConfig {
  id: string
  label: string
  workingDirectory: string
  color: string
  /** V2 identity colour: stable palette key. Authoritative over `color` at render time. */
  identityColorKey?: IdentityColorKey
  /** Pre-migration raw `color`, retained only when this record was migrated. */
  legacyColor?: string
  sessionType: 'local' | 'ssh'
  shellOnly?: boolean  // Don't run Claude, just open a shell
  /** Terminal-only launcher options (command / args / secret / elevated). */
  terminalOptions?: TerminalOptions
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
    dockerContainer?: string  // Docker container name (enables docker cp for screenshots)
    runtime?: SshRuntime      // item e: structured container runtime (supersedes free-text docker postCommand)
    detachable?: boolean      // item 1: "Detachable" persistent tmux session (default ON; only false disables)
    remoteOs?: 'auto' | 'unix' | 'windows'  // item 3: remote OS (windows = prototype Windows setup path)
  }
  pinned?: boolean
  /**
   * Allow Multi Spawn (phase 4): this config may run SEVERAL copies at once.
   * Absent/false = off — a launch is refused while any session of this config
   * is live, and the config cannot be picked in select mode while running.
   * Persisted only when ON (absent is the default, same shape rule as
   * `sshConfig.detachable`'s opt-out).
   */
  allowMultiSpawn?: boolean
  /**
   * How many copies the row's ×N control launches. Only meaningful with
   * `allowMultiSpawn`; absent => MULTI_SPAWN_DEFAULT_COUNT (2). Clamped 1-9 at
   * read time (`resolveMultiSpawnCount`) so a hand-edited file cannot spawn a
   * hundred sessions.
   */
  multiSpawnCount?: number
  machineName?: string // Identifies which machine this session runs on
  /** v1.5.19: account profile a session spawned from this config runs under
   *  (drives CLAUDE_CONFIG_DIR at PTY spawn). Absent = the bare default account. */
  profileId?: string
  /**
   * P9.3 (#280): persisted GitHub integration on the CONFIG template so any
   * session spawned from it inherits the activation + repo + auth profile.
   * Previously the integration only lived on the live SavedSession (in
   * session-state.json) and was lost the moment that session ended; spawning
   * a fresh session from the same config required re-enabling every time.
   * SessionGitHubConfig.save() now writes the patch back here too whenever
   * the session has a configId, so the template stays in sync.
   */
  githubIntegration?: import('../../shared/github-types').SessionGitHubIntegration
  // Provider discriminator + sub-options
  provider: ProviderId
  claudeOptions?: ClaudeOptions
  codexOptions?: CodexOptions
  // Legacy top-level fields -- kept for backward compat during migration; read from claudeOptions after P1.2
  /** @deprecated read from claudeOptions; removed in P1.2+ */
  model?: string
  /** @deprecated read from claudeOptions; removed in P1.2+ */
  legacyVersion?: {
    enabled: boolean
    version: string
  }
  /** @deprecated read from claudeOptions; removed in P1.2+ */
  agentIds?: string[]  // Selected agent template IDs
  /** @deprecated read from claudeOptions; removed in P1.2+ */
  effortLevel?: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode' // Claude Code --effort flag
  /** @deprecated read from claudeOptions; removed in P1.2+ */
  disableAutoMemory?: boolean // Disable CLAUDE.md auto-memory writes
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
    const id = generateId()
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
